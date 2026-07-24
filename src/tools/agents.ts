import { statSync, realpathSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, resolveProject, type Project } from "../context.js";
import { ensureHooksFile } from "../hooks.js";
import { loadProjectYml } from "../projectYml.js";
import { run } from "../result.js";
import { closeAgentRow, launchAgent } from "../spawn.js";
import {
  capturePane,
  ensureAttached,
  isPaneTarget,
  liveTargets,
  paneCurrentCommand,
  sendText,
  sessionName,
  shellQuote,
  sleep,
  targetAlive,
  tmux,
  windowAlive,
  type AliveSnapshot,
} from "../tmux.js";
import { projectIdParam } from "./params.js";

export interface AgentRow {
  id: number;
  project_id: number;
  actor_id: string;
  name: string;
  tmux_target: string;
  command: string;
  cwd: string;
  parent_actor_id: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
  agent_state: string;
  state_changed_at: string | null;
  kind: string;
}

export function findAgent(projectId: number, ref: { agent_id?: number; name?: string }): AgentRow {
  if (ref.agent_id != null) {
    const row = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND id = ?")
      .get(projectId, ref.agent_id) as AgentRow | undefined;
    if (!row) throw new Error(`No agent ${ref.agent_id} in project ${projectId}. Call agent_list.`);
    return row;
  }
  if (ref.name) {
    const rows = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
      .all(projectId, ref.name) as AgentRow[];
    if (rows.length === 0) {
      throw new Error(`No running agent named "${ref.name}" in project ${projectId}. Call agent_list.`);
    }
    if (rows.length > 1) {
      throw new Error(`Multiple running agents named "${ref.name}". Target by agent_id instead.`);
    }
    return rows[0];
  }
  throw new Error("Pass agent_id or name.");
}

// The core liveness rule of the agent model: a row is live only while it is
// open in the store AND its tmux target still exists.
export function isLive(agent: AgentRow): boolean {
  return agent.status === "running" && windowAlive(agent.tmux_target);
}

function requireLive(agent: AgentRow): void {
  if (agent.status !== "running") {
    throw new Error(`Agent ${agent.id} ("${agent.name}") is closed.`);
  }
  if (!windowAlive(agent.tmux_target)) {
    throw new Error(
      `Agent ${agent.id} ("${agent.name}") has no live tmux window (its process exited or the window was killed). Close it with agent_close and spawn a new one.`,
    );
  }
}

function bootstrapInstructions(agent: AgentRow, project: Project): string {
  return `[HIVE CONTEXT]
You are agent "${agent.name}" (actor id: ${agent.actor_id}) in project "${project.name}" (${project.path}).
This session is locked to this project (HIVE_PROJECT_LOCK=1); do not try to access other projects.
Coordinate through the hive MCP tools:
- whoami confirms your identity and scope.
- pad_list / pad_read for the shared plan and findings. Record decisions there.
- todo_list(is_blocked=false, status="open") for dispatchable work; set status to in_progress while working.
- todo_comment for handoffs (changed files, tests run, remaining risk), then todo_complete.
- lease_acquire before editing shared file areas; leases expire on their own.
If the hive MCP tools are unavailable in this session, write progress and results to stdout; the orchestrator will read your terminal.
[END HIVE CONTEXT]`;
}

function agentSummary(row: AgentRow, snapshot?: AliveSnapshot) {
  const alive =
    row.status === "running" &&
    (snapshot ? targetAlive(row.tmux_target, snapshot) : windowAlive(row.tmux_target));
  return {
    agent_id: row.id,
    kind: row.kind,
    name: row.name,
    actor_id: row.actor_id,
    status: row.status === "running" && !alive ? "exited" : row.status,
    alive,
    agent_state: alive ? row.agent_state : "gone",
    state_changed_at: row.state_changed_at,
    tmux_target: row.tmux_target,
    command: row.command,
    cwd: row.cwd,
    parent_actor_id: row.parent_actor_id,
    created_at: row.created_at,
  };
}

export function registerAgents(server: McpServer): void {
  server.registerTool(
    "agent_spawn",
    {
      description:
        "Spawn a worker agent in a tmux window (default command: claude). Returns bootstrap instructions to PREPEND to the first agent_send prompt. The worker is locked to this project. Humans can watch with: tmux attach -t hive-<project_id>.",
      inputSchema: {
        name: z.string().optional().describe("Display name; defaults to worker-N."),
        model: z.string().optional().describe("Passed as --model to the agent command."),
        command: z.string().optional().describe("Agent command to run. Defaults to claude."),
        extra_args: z.array(z.string()).optional().describe("Extra CLI arguments."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory, e.g. a git worktree path. Defaults to the project root."),
        placement: z
          .enum(["split", "window"])
          .optional()
          .describe(
            "split (default): the worker appears as a pane in the lead's window, auto-tiled, so the whole crew shares one screen. window: its own tmux window (iTerm tab).",
          ),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const parent = currentActor();

        let cwd = project.path;
        if (args.cwd) {
          cwd = realpathSync(args.cwd);
          if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${args.cwd}`);
        }

        let name = args.name;
        if (!name) {
          const count = (
            db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(project.id) as {
              n: number;
            }
          ).n;
          name = `worker-${count + 1}`;
        }
        const clash = db
          .prepare(
            "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND name = ? AND status = 'running'",
          )
          .get(project.id, name) as { n: number };
        if (clash.n > 0) throw new Error(`A running agent named "${name}" already exists. Pick another name.`);

        const baseCommand = args.command ?? "claude";
        const commandString = [
          baseCommand,
          ...(args.model ? ["--model", args.model] : []),
          // State hooks (working/idle/waiting) ride along via --settings.
          ...(baseCommand === "claude" ? ["--settings", ensureHooksFile()] : []),
          ...(args.extra_args ?? []),
        ]
          .map(shellQuote)
          .join(" ");
        const placement =
          args.placement ??
          loadProjectYml(project.path).config?.placement ??
          (process.env.HIVE_SPAWN_PLACEMENT === "window" ? "window" : "split");

        const { agentId, actorId, target } = launchAgent({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          name,
          kind: "agent",
          commandString,
          cwd,
          env: {},
          placement,
          parentActor: parent,
        });
        ensureAttached(sessionName(project.id));

        const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow;
        return {
          agent_id: agentId,
          actor_id: actorId,
          name,
          tmux_target: target,
          instructions: bootstrapInstructions(row, project),
        };
      }),
  );

  server.registerTool(
    "agent_list",
    {
      description: "List this project's agents with live status.",
      inputSchema: {
        include_closed: z.boolean().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        let sql = "SELECT * FROM agents WHERE project_id = ?";
        if (!args.include_closed) sql += " AND status = 'running'";
        const rows = db.prepare(`${sql} ORDER BY id`).all(project.id) as AgentRow[];
        const snapshot = liveTargets();
        return {
          project_id: project.id,
          project_name: project.name,
          agents: rows.map((r) => agentSummary(r, snapshot)),
        };
      }),
  );

  server.registerTool(
    "agent_status",
    {
      description: "Detailed status for one agent, including a short tail of its terminal.",
      inputSchema: {
        agent_id: z.number().int().optional(),
        name: z.string().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        const summary = agentSummary(agent);
        return {
          ...summary,
          closed_at: agent.closed_at,
          current_command: summary.alive ? paneCurrentCommand(agent.tmux_target) : null,
          tail: summary.alive ? capturePane(agent.tmux_target, 15) : "",
        };
      }),
  );

  server.registerTool(
    "agent_send",
    {
      description:
        "Type into an agent's terminal. text is typed literally (multi-line uses bracketed paste) and submitted with Enter unless submit=false. Alternatively pass keys (tmux key names like Escape, C-c, Enter). wait_ms (250-10000) returns the terminal tail after sending. PREPEND the spawn instructions to the FIRST prompt you send a new agent.",
      inputSchema: {
        agent_id: z.number().int().optional(),
        name: z.string().optional(),
        text: z.string().optional(),
        keys: z.array(z.string()).optional().describe("tmux key names, e.g. [\"Escape\"] or [\"C-c\"]."),
        submit: z.boolean().optional().describe("Append Enter after text. Defaults to true."),
        wait_ms: z.number().int().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        requireLive(agent);
        const target = agent.tmux_target;

        if (args.keys && args.keys.length > 0) {
          tmux("send-keys", "-t", target, "--", ...args.keys);
        } else if (args.text != null) {
          await sendText(target, args.text, args.submit !== false);
        } else {
          throw new Error("Pass text or keys.");
        }

        if (args.wait_ms != null) {
          await sleep(Math.min(Math.max(args.wait_ms, 250), 10000));
          return { agent_id: agent.id, sent: true, tail: capturePane(target, 15) };
        }
        return { agent_id: agent.id, sent: true };
      }),
  );

  server.registerTool(
    "agent_output",
    {
      description:
        "Read the rendered terminal of an agent (default 50 lines, max 200). Read REAL output before declaring a worker done.",
      inputSchema: {
        agent_id: z.number().int().optional(),
        name: z.string().optional(),
        lines: z.number().int().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        const lines = Math.min(args.lines ?? 50, 200);
        const alive = isLive(agent);
        return {
          agent_id: agent.id,
          name: agent.name,
          alive,
          output: alive ? capturePane(agent.tmux_target, lines) : "",
          ...(alive ? {} : { note: "No live tmux window; output is not retained after exit." }),
        };
      }),
  );

  server.registerTool(
    "agent_close",
    {
      description:
        "Kill an agent's tmux window and mark it closed. Capture handoffs (todo comments, pads) BEFORE closing; terminal output is not retained. Closing yourself requires confirm_self=true.",
      inputSchema: {
        agent_id: z.number().int().optional(),
        name: z.string().optional(),
        confirm_self: z.boolean().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        if (agent.actor_id === currentActor() && args.confirm_self !== true) {
          throw new Error(
            "This would close your own session. Pass confirm_self=true only if the user explicitly asked you to close yourself.",
          );
        }
        if (isLive(agent)) {
          tmux(isPaneTarget(agent.tmux_target) ? "kill-pane" : "kill-window", "-t", agent.tmux_target);
        }
        closeAgentRow(agent.id);
        return { agent_id: agent.id, name: agent.name, closed: true };
      }),
  );
}
