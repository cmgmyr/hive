import { existsSync, statSync, realpathSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  agentBriefPath,
  isClaudeCommand,
  paneAnnouncement,
  readAgentBrief,
  workerBrief,
  workerCommandString,
  writeAgentBrief,
} from "../brief.js";
import { currentActor, resolveProject } from "../context.js";
import { ensureHooksFile } from "../hooks.js";
import { activeProfile, loadProjectYml } from "../projectYml.js";
import { run } from "../result.js";
import { renderableVars } from "../trust.js";
import { closeAgentRow, launchAgent } from "../spawn.js";
import {
  applyLayout,
  capturePane,
  DEFAULT_LAYOUT,
  ensureAttached,
  isPaneTarget,
  liveTargets,
  paneCurrentCommand,
  paneWindow,
  sendText,
  sessionName,
  sleep,
  targetAlive,
  tmux,
  waitForPaneInput,
  WINDOW_LAYOUTS,
  windowAlive,
  windowLayout,
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

function nextWorkerName(projectId: number): string {
  const count = (
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId) as { n: number }
  ).n;
  return `worker-${count + 1}`;
}

// How long agent_spawn waits for claude's prompt box before typing the
// visible first turn into the pane. A cold claude loading plugins and MCP
// servers routinely needs more than ten seconds, and an observed 8s default
// missed the prompt box outright. Waiting costs one tmux fork per 500ms, so
// the ceiling is generous on purpose: a slow start should delay the line, not
// lose it.
const PANE_READY_MS = Number(process.env.HIVE_SPAWN_READY_MS ?? 45_000);

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
        "Spawn a worker agent in a tmux window (default command: claude). A claude worker is briefed automatically: the full brief is appended to its system prompt and a short [hive] line is typed into its pane as the visible first turn, so send it its assignment directly. Other commands return `instructions` to PREPEND to your first agent_send. The worker is locked to this project. Humans can watch with: tmux attach -t hive-<project_id>.",
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
        layout: z
          .enum(WINDOW_LAYOUTS)
          .optional()
          .describe(
            "How to arrange the lead's window when placement is split. main-vertical gives the lead the left half with workers stacked on the right; tiled (default) splits evenly. Projects can set a default in hive.yml.",
          ),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const parent = currentActor();

        let cwd = project.path;
        if (args.cwd) {
          cwd = realpathSync(args.cwd);
          if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${args.cwd}`);
        }

        const name = args.name ?? nextWorkerName(project.id);
        const clash = db
          .prepare(
            "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND name = ? AND status = 'running'",
          )
          .get(project.id, name) as { n: number };
        if (clash.n > 0) throw new Error(`A running agent named "${name}" already exists. Pick another name.`);

        const baseCommand = args.command ?? "claude";
        const isClaude = isClaudeCommand(baseCommand);
        // The brief names the agent, so it can only be written once the row
        // exists; launchAgent calls this back with the ids it just allocated.
        const projectConfig = loadProjectYml(project.path).config;
        const briefFor = (actorId: string) => ({
          name,
          actorId,
          projectName: project.name,
          projectPath: project.path,
          cwd,
          profile: activeProfile(projectConfig),
          // Repo-controlled text that would land in a worker's system prompt.
          // Approved once by `hive lead`; unapproved values render as unset.
          vars: renderableVars(project.id, projectConfig?.vars).vars,
        });
        const buildCommand = ({ agentId, actorId }: { agentId: number; actorId: string }) => {
          const briefPath = isClaude
            ? writeAgentBrief(agentId, workerBrief(briefFor(actorId)))
            : undefined;
          return workerCommandString({
            command: baseCommand,
            model: args.model,
            extraArgs: args.extra_args,
            settingsPath: isClaude ? ensureHooksFile() : undefined,
            briefPath,
          });
        };
        const placement =
          args.placement ??
          projectConfig?.placement ??
          (process.env.HIVE_SPAWN_PLACEMENT === "window" ? "window" : "split");
        const layout = args.layout ?? projectConfig?.layout ?? DEFAULT_LAYOUT;

        const { agentId, actorId, target } = launchAgent({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          name,
          kind: "agent",
          commandString: buildCommand,
          cwd,
          env: {},
          placement,
          layout,
          parentActor: parent,
        });
        ensureAttached(sessionName(project.id));

        // The appended system prompt is invisible in the TUI and absent from
        // the transcript, so the pane gets a short line naming the worker: the
        // human watching sees exactly who this session thinks it is. Never let
        // a failure here fail a worker that is already running.
        // Only type once the pane is confirmed ready. Typing into a TUI that
        // has not taken the terminal yet was observed to swallow the line
        // silently, which is strictly worse than not sending: the lead sees a
        // spawn, the worker sees nothing, and nothing says so. Skipping makes
        // announced=false mean "not sent", which a lead can act on.
        // The brief itself rides in the system prompt and is unaffected either
        // way, so a missed line costs visibility, not instructions.
        let announced = false;
        if (isClaude) {
          try {
            announced = await waitForPaneInput(target, PANE_READY_MS);
            if (announced) await sendText(target, paneAnnouncement(briefFor(actorId)));
          } catch {
            // Pane died or tmux refused; the receipt reports it below.
            announced = false;
          }
        }

        return {
          agent_id: agentId,
          actor_id: actorId,
          name,
          tmux_target: target,
          ...(isClaude
            ? {
                brief_path: agentBriefPath(agentId),
                announced,
                ...(announced
                  ? {}
                  : {
                      note: "The pane never became ready, so the [hive] line was NOT sent. The system-prompt brief is loaded regardless; send the worker its assignment as usual, or check agent_output first.",
                    }),
              }
            : {
                instructions: workerBrief(briefFor(actorId)),
              }),
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
      description:
        "Detailed status for one agent, including a short tail of its terminal. include_brief=true returns the exact brief this worker was given; hive keeps that copy because an appended system prompt appears in no transcript.",
      inputSchema: {
        agent_id: z.number().int().optional(),
        name: z.string().optional(),
        include_brief: z
          .boolean()
          .optional()
          .describe("Return the full injected brief, not just its path. Defaults to false."),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        const summary = agentSummary(agent);
        const briefPath = agentBriefPath(agent.id);
        return {
          ...summary,
          closed_at: agent.closed_at,
          current_command: summary.alive ? paneCurrentCommand(agent.tmux_target) : null,
          // The path, not the text, by default: status is polled and the
          // brief is a kilobyte the caller usually already knows. Stat it
          // rather than reading it to find out whether it is there.
          brief_path: existsSync(briefPath) ? briefPath : null,
          ...(args.include_brief ? { brief: readAgentBrief(agent.id) } : {}),
          tail: summary.alive ? capturePane(agent.tmux_target, 15) : "",
        };
      }),
  );

  server.registerTool(
    "agent_send",
    {
      description:
        "Type into an agent's terminal. text is typed literally (multi-line uses bracketed paste) and submitted with Enter unless submit=false. Alternatively pass keys (tmux key names like Escape, C-c, Enter). wait_ms (250-10000) returns the terminal tail after sending. A claude worker is already briefed by agent_spawn; only a non-claude worker needs the returned instructions prepended to your first prompt.",
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
          const pane = isPaneTarget(agent.tmux_target);
          // Resolve the window before the pane dies, then re-tile the
          // survivors: tmux's own redistribution otherwise wipes the
          // arrangement hive applied on spawn.
          const window = pane ? paneWindow(agent.tmux_target) : null;
          tmux(pane ? "kill-pane" : "kill-window", "-t", agent.tmux_target);
          if (window) {
            applyLayout(
              window,
              windowLayout(window) ?? loadProjectYml(project.path).config?.layout ?? DEFAULT_LAYOUT,
            );
          }
        }
        closeAgentRow(agent.id);
        return { agent_id: agent.id, name: agent.name, closed: true };
      }),
  );
}
