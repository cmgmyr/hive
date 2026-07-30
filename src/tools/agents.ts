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
import { closeAgentRow, launchAgent, renameAgent } from "../spawn.js";
import {
  applyLayout,
  capturePane,
  DEFAULT_LAYOUT,
  ensureAttached,
  inputBoxState,
  isPaneTarget,
  liveTargets,
  paneChoiceCheck,
  paneCurrentCommand,
  paneWindow,
  sendText,
  sessionName,
  sleep,
  targetAlive,
  tmux,
  waitForPaneInput,
  WINDOW_LAYOUTS,
  targetLive,
  windowLayout,
  type AliveSnapshot,
  type InputBoxState,
  type Liveness,
} from "../tmux.js";
import { agentIdParam, agentNameParam, projectIdParam } from "./params.js";

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

// The most recently closed agent whose name matches, folded the same way the
// running passes fold. Only reached when no running agent answered, so the
// scan over a project's dead agents stays off the hot path.
function closedAgentNamed(projectId: number, needle: string): { id: number; name: string } | undefined {
  return (
    db
      .prepare("SELECT id, name FROM agents WHERE project_id = ? AND status != 'running' ORDER BY id DESC")
      .all(projectId) as { id: number; name: string }[]
  ).find((r) => r.name.toLowerCase() === needle);
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
      .prepare("SELECT * FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
      .all(projectId) as AgentRow[];

    // Strict precedence, strongest signal first, so a shorter name can never
    // be shadowed by a longer one that happens to contain it: "impl" resolves
    // to impl even while impl-followup is running.
    const exact = rows.filter((r) => r.name === ref.name);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`Multiple running agents named "${ref.name}". Target by agent_id instead.`);
    }

    const needle = ref.name.toLowerCase();
    const sameName = rows.filter((r) => r.name.toLowerCase() === needle);
    if (sameName.length === 1) return sameName[0];

    // A name the caller typed in full must never resolve to a DIFFERENT
    // worker. Closing "impl" while "impl-followup" runs would otherwise make
    // agent_close(name="impl") kill the wrong pane, because the running-only
    // filter above turns the exact match into a miss and the substring pass
    // happily takes the sibling. Report the closed worker instead. Checked
    // after the running passes so that reusing a closed worker's name still
    // resolves to the live one.
    const closed = closedAgentNamed(projectId, needle);
    if (closed) {
      throw new Error(
        `Agent ${closed.id} ("${closed.name}") is closed. Spawn a new worker, or target a running one by name or agent_id.`,
      );
    }

    const partial = rows.filter((r) => r.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const candidates = partial.map((r) => `${r.name} (agent_id ${r.id})`).join(", ");
      throw new Error(
        `"${ref.name}" matches ${partial.length} running agents: ${candidates}. Use the full name or agent_id.`,
      );
    }
    throw new Error(`No running agent matching "${ref.name}" in project ${projectId}. Call agent_list.`);
  }
  throw new Error("Pass agent_id or name.");
}

// The core liveness rule of the agent model: a row is live only while it is
// open in the store AND its tmux target still exists. Returns null when tmux
// could not be asked, which every caller must handle as its own case: reading
// unknown as dead is what closed live workers (issue #14).
export function isLive(agent: AgentRow): Liveness {
  if (agent.status !== "running") return false;
  return targetLive(agent.tmux_target);
}

// The message matters as much as the refusal. Told a worker has no window, a
// model follows the instruction and closes it; told the probe failed, it
// retries. Never hand out the first when we mean the second, and say it the
// same way everywhere it is said.
export const PROBE_FAILED_NOTE =
  "tmux could not be probed, so liveness is unknown. Nothing was changed. Retry in a few seconds.";

export const probeFailed = (agent: AgentRow) =>
  new Error(`Agent ${agent.id} ("${agent.name}"): ${PROBE_FAILED_NOTE}`);

function requireLive(agent: AgentRow): void {
  if (agent.status !== "running") {
    throw new Error(`Agent ${agent.id} ("${agent.name}") is closed.`);
  }
  const live = isLive(agent);
  if (live === null) throw probeFailed(agent);
  if (!live) {
    throw new Error(
      `Agent ${agent.id} ("${agent.name}") has no live tmux window (its process exited or the window was killed). Close it with agent_close and spawn a new one.`,
    );
  }
}

// Names are the handle leads address workers by, so two running agents may
// never share one: findAgent would go ambiguous and every name-addressed call
// would need an id instead. Enforced at both doors, spawn and rename.
//
// Compared case-insensitively, because that is how partial resolution matches.
// "impl" and "Impl" are not two handles: every partial match finds both and
// reports them as ambiguous, so allowing the pair would hand a lead two
// workers it can only ever address by id.
//
// Folded in JS with the same toLowerCase findAgent uses, deliberately, rather
// than in SQL. SQLite's NOCASE folds ASCII only, so the two engines disagreed
// outside ASCII: "café" and "CAFÉ" passed this check as different names and
// then collided at resolution, producing the exact pair this exists to
// prevent. One rule needs one implementation.
function requireNameFree(projectId: number, name: string, exceptAgentId?: number): void {
  const needle = name.toLowerCase();
  const taken = (
    db
      .prepare("SELECT id, name FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
      .all(projectId) as { id: number; name: string }[]
  ).find((r) => r.id !== exceptAgentId && r.name.toLowerCase() === needle);
  if (taken) {
    throw new Error(`A running agent named "${taken.name}" already exists. Pick another name.`);
  }
}

// A name is not just a label: it gets typed into a terminal, as the pane
// announcement at spawn and as /rename on a live worker. `tmux send-keys -l`
// stops tmux interpreting key NAMES, but it passes a raw control byte
// straight through to the TUI, so a name carrying 0x03 sends Ctrl-C into a
// worker mid-task. Verified directly against tmux rather than reasoned about:
// send-keys -l -- with a literal 0x03 interrupts a running foreground
// process. Both doors validate, because both doors type.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function normalizeAgentName(raw: string, field: "name" | "new_name"): string {
  const name = raw.trim();
  if (!name) throw new Error(`${field} cannot be empty.`);
  if (CONTROL_CHARS.test(name)) {
    throw new Error(
      `${field} cannot contain control characters, including newlines: it is typed into the worker's terminal.`,
    );
  }
  return name;
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

// Two of the three ways in can end in unknown: an omitted snapshot probes
// this row on its own and may get no answer, and a null snapshot means the
// batch probe already failed. A snapshot that was passed always answers.
// Unknown is reported as alive: null with the row exactly as the store has
// it, rather than inventing "exited" for a worker that is very likely still
// running (issue #14).
function summaryLiveness(row: AgentRow, snapshot?: AliveSnapshot | null): Liveness {
  // A closed row needs no probe: the store already answered, and reporting it
  // as unknown during a hiccup would make a definitely-dead worker look like
  // it might still be there.
  if (row.status !== "running") return false;
  if (snapshot === undefined) return targetLive(row.tmux_target);
  if (snapshot === null) return null;
  return targetAlive(row.tmux_target, snapshot);
}

// Issue #34. A SEPARATE capture from the tail/output, not derived from it:
// counselors review on PR #37 overturned an earlier fused single-capture
// version of this (see git history) after two independent findings. First,
// capturePane's plain "-p" tail and a "-e" capture are not just differently
// formatted, they can DISAGREE on which rows are blank: tmux's "-e"
// serializer also emits OSC 8 hyperlinks and SO/SI charset controls that
// stripSgr's SGR-only regex does not strip, so a visually-blank row carrying
// one of those reads as non-empty under the fused function's trimming and
// gets kept, while capturePane's plain-text trim on the same row correctly
// drops it -- the two "same screen" contracts silently diverge by a row.
// Second, agent_output's capped lines can reach 200, and "-e" widens every
// attributed cell, which can push a single capture past execFileSync's
// default maxBuffer and throw ENOBUFS -- for agent_send's wait_ms path,
// AFTER the text was already sent, turning a successful send into a
// reported error. Two forks is the correct cost here, not one.
//
// Present only when a recognisable input-box line was found: an absent
// field is a plain "nothing to say" (slim receipts), not a claim that the
// box is empty.
function inputBoxField(target: string): { input_box: InputBoxState } | Record<string, never> {
  const box = inputBoxState(target);
  return box ? { input_box: box } : {};
}

function agentSummary(row: AgentRow, snapshot?: AliveSnapshot | null) {
  const alive = summaryLiveness(row, snapshot);
  return {
    agent_id: row.id,
    kind: row.kind,
    name: row.name,
    actor_id: row.actor_id,
    status: alive === false && row.status === "running" ? "exited" : row.status,
    alive,
    agent_state: alive === false ? "gone" : row.agent_state,
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
        name: z
          .string()
          .optional()
          .describe("Display name; defaults to worker-N. This is how you address the worker later."),
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

        const name = args.name != null
          ? normalizeAgentName(args.name, "name")
          : nextWorkerName(project.id);
        requireNameFree(project.id, name);

        const baseCommand = args.command ?? "claude";
        const isClaude = isClaudeCommand(baseCommand);
        // The brief names the agent, so it can only be written once the row
        // exists; launchAgent calls this back with the ids it just allocated.
        const { config: projectConfig, warnings: configWarnings } = loadProjectYml(project.path);
        const briefFor = (actorId: string) => ({
          name,
          actorId,
          projectName: project.name,
          projectPath: project.path,
          cwd,
          profile: activeProfile(projectConfig),
          // Repo-controlled text, rendered into this worker's system prompt.
          // See the hive.yml note in CLAUDE.md: a cloned hive.yml deserves the
          // same read as the repo's own CLAUDE.md.
          vars: projectConfig?.vars ?? {},
        });
        const buildCommand = ({ agentId, actorId }: { agentId: number; actorId: string }) => {
          const briefPath = isClaude
            ? writeAgentBrief(agentId, workerBrief(briefFor(actorId)))
            : undefined;
          return workerCommandString({
            command: baseCommand,
            displayName: name,
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
        //
        // Issue #27. A spawn is exactly when claude raises the folder-trust
        // prompt, so this is the sharpest edge in the lane: typing requires
        // BOTH ready and not-a-dialog, checked independently (see todo 73's
        // comment just below for why the dialog half runs unconditionally).
        let announced = false;
        let dialogTail: string | undefined;
        if (isClaude) {
          try {
            const ready = await waitForPaneInput(target, PANE_READY_MS);
            // Todo 73. The dialog check used to run only when ready, which
            // meant it could never fire for the case that motivated it: a
            // real folder-trust or /model-picker screen carries no readiness
            // marker at all (that absence is #30's own fix), so `ready` was
            // always false for them and this whole branch was dead against
            // every real fixture, catchable only by a synthetic screen. Run
            // it unconditionally instead, so a genuine dialog is reported as
            // one even while the pane also reads as not-yet-ready. One extra
            // capture-pane fork on a path that already burned PANE_READY_MS
            // if it gets here, so the cost is noise.
            const { awaitingChoice, tail } = paneChoiceCheck(target);
            if (awaitingChoice === true) {
              dialogTail = tail;
            } else if (ready) {
              await sendText(target, paneAnnouncement(briefFor(actorId)));
              announced = true;
            }
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
          // The lead has no other channel to learn its hive.yml is malformed:
          // loadProjectYml already fell back to a default, so the spawn looks
          // clean. Reported, never fatal, and omitted when there is nothing to
          // say (slim receipts).
          ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),
          ...(isClaude
            ? {
                brief_path: agentBriefPath(agentId),
                announced,
                ...(announced
                  ? {}
                  : dialogTail !== undefined
                    ? {
                        note: "The pane is waiting on a choice (e.g. a folder-trust or permission prompt), so the [hive] line was NOT sent: typing into it would answer the prompt instead. Clear the prompt with agent_send keys, then send the worker its assignment.",
                        tail: dialogTail,
                      }
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
    "agent_rename",
    {
      description:
        "Change a worker's display name. Its actor_id (agent:N) does not change, so every pad write, todo comment and lease it has already made stays attributable. A live claude worker is also told to retitle its own session, which shows up in its pane; that arrives as a user turn, so rename between assignments rather than mid-task.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
        new_name: z
          .string()
          .describe("The new display name. No other running worker may have it, case aside."),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        // Reachable only by id: name lookups already filter to running agents.
        // Renaming a closed one changes a label nothing can address and
        // rewrites the actors row for a worker that is gone.
        if (agent.status !== "running") {
          throw new Error(`Agent ${agent.id} ("${agent.name}") is closed and cannot be renamed.`);
        }
        const newName = normalizeAgentName(args.new_name, "new_name");
        requireNameFree(project.id, newName, agent.id);

        // Unknown counts as not-live here, and that is safe: everything it
        // gates is cosmetic (the tmux window title, claude's own /rename), so
        // the worst case is a pane label that lags the store until the next
        // rename. The row itself is renamed either way.
        const live = isLive(agent) === true;
        // A window-placed worker carries its name in the tmux window too,
        // which is hive's own to set.
        const ownWindow = live && !isPaneTarget(agent.tmux_target);
        renameAgent(agent, newName, ownWindow ? { projectName: project.name } : null);

        // claude owns its pane title and rewrites it as the session moves, so
        // hive cannot set it directly and make it stick. /rename is claude's
        // own way of pinning it, and typing into the pane is the channel hive
        // already drives workers through.
        //
        // Issue #27, decision D1. This is a synchronous tool call with a caller
        // standing right there, not the scheduler, so it refuses rather than
        // holds: a modal pane gets a receipt saying so, not a retry loop. The
        // row is renamed either way; only the /rename keystroke is skipped,
        // since /rename typed at a dialog would answer the dialog instead.
        let retitled = false;
        let heldNote: string | undefined;
        let heldTail: string | undefined;
        if (live && isClaudeCommand(agent.command)) {
          const { awaitingChoice, tail } = paneChoiceCheck(agent.tmux_target);
          if (awaitingChoice === true) {
            heldNote =
              "Not retitled: the pane is waiting on a choice, so typing /rename would answer it instead of setting the title. Clear the prompt first (agent_send with keys), then retry.";
            heldTail = tail;
          } else {
            try {
              await sendText(agent.tmux_target, `/rename ${newName}`);
              retitled = true;
            } catch {
              // Pane died between the liveness check and the keystrokes; the
              // rename itself already landed in the store.
            }
          }
        }

        return {
          agent_id: agent.id,
          actor_id: agent.actor_id,
          name: newName,
          previous_name: agent.name,
          retitled,
          ...(heldNote ? { note: heldNote, tail: heldTail } : {}),
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
          // Only present when the probe failed, so an empty list from a
          // reachable tmux still reads as the plain "no agents" it is.
          ...(snapshot === null
            ? {
                note: `${PROBE_FAILED_NOTE} These rows are what the store holds; do not conclude a worker died.`,
              }
            : {}),
          agents: rows.map((r) => agentSummary(r, snapshot)),
        };
      }),
  );

  server.registerTool(
    "agent_status",
    {
      description:
        "Detailed status for one agent, addressed by name (or agent_id), including a short tail of its terminal. include_brief=true returns the exact brief this worker was given; hive keeps that copy because an appended system prompt appears in no transcript.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
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
          // agent_status is the tool a lead polls before acting on one worker,
          // so it must not answer "exited" when it means "I could not ask".
          ...(summary.alive === null ? { note: PROBE_FAILED_NOTE } : {}),
          closed_at: agent.closed_at,
          current_command: summary.alive ? paneCurrentCommand(agent.tmux_target) : null,
          // The path, not the text, by default: status is polled and the
          // brief is a kilobyte the caller usually already knows. Stat it
          // rather than reading it to find out whether it is there.
          brief_path: existsSync(briefPath) ? briefPath : null,
          ...(args.include_brief ? { brief: readAgentBrief(agent.id) } : {}),
          tail: summary.alive ? capturePane(agent.tmux_target, 15) : "",
          ...(summary.alive ? inputBoxField(agent.tmux_target) : {}),
        };
      }),
  );

  server.registerTool(
    "agent_send",
    {
      description:
        "Type into an agent's terminal, addressed by name (or agent_id). text is typed literally (multi-line uses bracketed paste) and submitted with Enter unless submit=false. Alternatively pass keys (tmux key names like Escape, C-c, Enter). wait_ms (250-10000) returns the terminal tail after sending. A claude worker is already briefed by agent_spawn; only a non-claude worker needs the returned instructions prepended to your first prompt.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
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

        // Issue #27, decision D2. text and keys are guarded asymmetrically ON
        // PURPOSE, not by oversight. text means "inject a user turn": a modal
        // pane has nowhere to put the paste and drops it, then reads the
        // trailing Enter as picking the highlighted option, so hive would be
        // answering the dialog with the wake's own text. keys means "drive
        // this TUI deliberately", and pressing Escape or an arrow key to
        // answer or dismiss a dialog IS the legitimate use of it: the lead
        // used exactly this to clear a folder-trust prompt and unstick a
        // worker on 2026-07-29. Guarding keys would remove the only supported
        // way to get a pane like that moving again.
        // Pre-existing, found by this lane's review rather than introduced by
        // it: passing both used to silently send keys and drop text, still
        // reporting sent: true. "keys won, text vanished" is not a thing any
        // caller can have meant, so this is a caller error, the same way
        // passing neither already is below.
        if (args.keys && args.keys.length > 0 && args.text != null) {
          throw new Error("Pass text or keys, not both.");
        } else if (args.keys && args.keys.length > 0) {
          tmux("send-keys", "-t", target, "--", ...args.keys);
        } else if (args.text != null) {
          const { awaitingChoice, tail } = paneChoiceCheck(target);
          if (awaitingChoice === true) {
            return {
              agent_id: agent.id,
              name: agent.name,
              sent: false,
              note: "The pane is waiting on a choice (e.g. a permission or trust prompt), so text was NOT sent: typing here would answer the prompt instead of reaching the worker. Use keys to answer or dismiss it deliberately (e.g. [\"Escape\"], or the option's number plus Enter), then retry.",
              tail,
            };
          }
          await sendText(target, args.text, args.submit !== false);
        } else {
          throw new Error("Pass text or keys.");
        }

        if (args.wait_ms != null) {
          await sleep(Math.min(Math.max(args.wait_ms, 250), 10000));
          return {
            agent_id: agent.id,
            name: agent.name,
            sent: true,
            tail: capturePane(target, 15),
            ...inputBoxField(target),
          };
        }
        // The resolved name, not the one the caller typed: a partial name that
        // found the wrong worker is invisible otherwise.
        return { agent_id: agent.id, name: agent.name, sent: true };
      }),
  );

  server.registerTool(
    "agent_output",
    {
      description:
        "Read the rendered terminal of an agent (default 50 lines, max 200), addressed by name or agent_id. Read REAL output before declaring a worker done.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
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
          ...(alive ? inputBoxField(agent.tmux_target) : {}),
          ...(alive === true
            ? {}
            : {
                note:
                  alive === null
                    ? PROBE_FAILED_NOTE
                    : "No live tmux window; output is not retained after exit.",
              }),
        };
      }),
  );

  server.registerTool(
    "agent_close",
    {
      description:
        "Kill an agent's tmux window and mark it closed, addressed by name (or agent_id). Capture handoffs (todo comments, pads) BEFORE closing; terminal output is not retained. Closing yourself requires confirm_self=true.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
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
        const live = isLive(agent);
        // Refuse rather than half-close. Closing the row while the pane may
        // still be up leaks a running worker nothing tracks, and the kill
        // would not land anyway while tmux is unreachable.
        if (live === null) throw probeFailed(agent);
        if (live) {
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
