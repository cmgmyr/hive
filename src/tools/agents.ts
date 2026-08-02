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
import { currentActor, findProjectForDir, resolveProject } from "../context.js";
import { ensureHooksFile } from "../hooks.js";
import { activeProfile, loadProjectYml } from "../projectYml.js";
import { run } from "../result.js";
import { closeAgentRow, isReservedAgentName, isRunningLeadActor, launchAgent, LEAD_KIND, renameAgent } from "../spawn.js";
import { resolveTranscriptDir } from "../transcript.js";
import {
  applyLayout,
  capturePane,
  DEFAULT_LAYOUT,
  describePaneChoice,
  ensureAttached,
  inputBoxState,
  isPaneTarget,
  liveTargets,
  paneChoiceCheck,
  paneCurrentCommand,
  paneWindow,
  rowAlive,
  rowLive,
  sendText,
  sessionName,
  sleep,
  tmux,
  waitForPaneInput,
  WINDOW_LAYOUTS,
  windowLayout,
  type AliveSnapshot,
  type InputBoxState,
  type Liveness,
} from "../tmux.js";
import { agentIdParam, agentNameParam, projectIdParam } from "./params.js";
import { deriveProvenance, lastLogEvent, reportsAgentStateLog, type LastLogEvent } from "../stateProvenance.js";

export interface AgentRow {
  id: number;
  project_id: number;
  actor_id: string;
  name: string;
  tmux_target: string;
  tmux_socket: string;
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
function closedAgentNamed(projectId: number, needle: string): { id: number; name: string; kind: string } | undefined {
  return (
    db
      .prepare("SELECT id, name, kind FROM agents WHERE project_id = ? AND status != 'running' ORDER BY id DESC")
      .all(projectId) as { id: number; name: string; kind: string }[]
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
      // Issue #27's L4 fix round R10, todo 182 item 3 (opus). "Spawn a new
      // worker" is impossible advice for a retired LEAD - newly reachable
      // since todo 176 let agent_close retire a confirmed-dead lead row at
      // all: "lead" stays reserved (isReservedAgentName), so agent_spawn
      // refuses it outright, and the actual remedy is `hive lead` from a
      // terminal.
      const remedy = closed.kind === LEAD_KIND ? "Run `hive lead` to start a new one" : "Spawn a new worker";
      throw new Error(
        `Agent ${closed.id} ("${closed.name}") is closed. ${remedy}, or target a running one by name or agent_id.`,
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
  return rowLive(agent.tmux_socket, agent.tmux_target);
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
  // Issue #27's L4 fix round, DECISION 7c. "lead" is reserved, not merely
  // usually taken: ensureLeadRow (src/cli.ts) inserts the lead's own row
  // directly, never through this door, so a worker could take the name the
  // moment no lead row is running (a fresh clone, or between a lead session
  // ending and the next `hive lead`). The next `hive lead` would then INSERT,
  // hit SQLITE_CONSTRAINT_UNIQUE on idx_agents_running_name, and throw out of
  // ensureLeadRow BEFORE ensureSession or attach - the lead does not start,
  // and nothing about that failure names a worker as the cause.
  if (isReservedAgentName(needle)) {
    throw new Error(`"${name}" is reserved for this project's lead session and cannot be used as a worker name.`);
  }
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
export function summaryLiveness(row: AgentRow, snapshot?: AliveSnapshot | null): Liveness {
  // A closed row needs no probe: the store already answered, and reporting it
  // as unknown during a hiccup would make a definitely-dead worker look like
  // it might still be there.
  if (row.status !== "running") return false;
  if (snapshot === undefined) return rowLive(row.tmux_socket, row.tmux_target);
  if (snapshot === null) return null;
  return rowAlive(row.tmux_socket, row.tmux_target, snapshot);
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

// Issue #5. Resolution is purely a function of the stored cwd string (D7):
// recreating a removed worktree at the same path makes `claude --resume`
// work there again, since Claude Code keys its transcript directory on cwd
// alone. Gated on the same predicate --settings hooks already uses (D4), so
// codex or aider -- which have no such directory -- never get a confidently
// wrong path. One policy, like inputBoxField above: present (possibly null)
// for a claude worker, absent for anything else. Callers decide WHEN to call
// it, the same way they already decide when to call inputBoxField, rather
// than this function carrying two inclusion policies itself.
function transcriptDirField(row: AgentRow): { transcript_dir: string | null } | Record<string, never> {
  return isClaudeCommand(row.command) ? { transcript_dir: resolveTranscriptDir(row.cwd) } : {};
}

// Issue #72. Two more reports, neither derived from agent_state/provenance
// above: a worker whose latch and log genuinely stopped moving reads the
// same in `provenance` whether it is dead-in-the-water or perfectly healthy
// and just quiet, because provenance only ever shows the row that explains
// the CURRENT latch. These make that condition VISIBLE and worth a second
// look, reported raw, with no verdict attached. Fix round 1, item 7: this
// used to claim they are "what a reader actually needs to tell those apart",
// which overclaims -- two workers with the same prompt|working row and
// identical "running tool" screens, one waiting on a slow tool and one
// SIGSTOPped, produce byte-identical last_log_event and pane. They do not
// distinguish those two states; this lane's own rule is report, do not
// infer, and a field that actually discriminated every cause would be doing
// the inferring. Two functions, not one, matching
// inputBoxField/transcriptDirField above: each field owns exactly one
// inclusion gate, and the two gates here are genuinely different
// (reportsAgentStateLog vs. liveness), so fusing them into one helper would
// be this file's only multi-gate field function.
//
// last_log_event: the actor's log, independent of whether the latch moved
// (stateProvenance.ts's lastLogEvent -- see its own comment for why this is
// not the same question deriveProvenance answers). Gated on
// reportsAgentStateLog (stateProvenance.ts): present (possibly null) for a
// claude worker, absent for anything else, since a lead or a non-claude
// command never writes this log the way #72 means it (worker-state.md).
function lastLogEventField(row: AgentRow): { last_log_event: LastLogEvent | null } | Record<string, never> {
  return reportsAgentStateLog(row) ? { last_log_event: lastLogEvent(row.actor_id) } : {};
}

// pane: what the pane shows right now -- describePaneChoice's own three-value
// vocabulary (src/tmux.ts), the same words `hive doctor` renders, so the two
// surfaces cannot drift onto different spellings of the same fact. No tail
// here (fix round 1, item 2): a tail on every alive claude row made agent_list
// -- the hottest read tool -- pay ~1KB/row against CLAUDE.md's "token cost is
// a design input" to save one agent_output call in the rare dialog case, the
// wrong trade for a list response. A lead that sees `pane: "awaiting a choice
// (dialog)"` calls agent_output or agent_status for the tail, which is what
// those tools are for.
//
// AGENT_LIST ONLY, deliberately not folded into agentSummary (fix round 1,
// item 2): agentSummary is shared with agent_status, which already captures
// its own, separately-timed pane snapshot (capturePane + inputBoxField,
// below). A pane field riding along inside agentSummary would be a SECOND,
// older capture of the same pane sitting next to agent_status's own -- if a
// dialog clears between the two captures, one response would carry
// `pane: "awaiting a choice (dialog)"` next to a top-level tail that shows no
// dialog at all. Call this only from agent_list's own row-mapping, using the
// `alive` agentSummary already computed for that row.
//
// This is the one place in this file that spends a capture-pane fork on
// every alive claude row, inside rows.map()'s unbounded loop -- one call per
// row, synchronous, no timeout, so an unresponsive tmux server hangs
// agent_list for as long as that row's fork takes, times however many alive
// rows come before it. The D3 comment on transcript_dir above warns against
// growing the alive-worker path for a payload-size reason; that half no
// longer applies here now that the tail is gone (this field is a few
// bytes). The LATENCY half is real and is not new: liveTargets(), a few
// lines above this field's own call site, already forks tmux unconditionally
// on this exact call path with no timeout of its own, so an unresponsive
// tmux server already hangs agent_list today, before this field exists. What
// this field adds is latency proportional to the number of ALIVE claude
// rows, on top of that pre-existing single fork -- and capture-pane has no
// batched form to call instead of one fork per row, the way liveTargets()
// batches liveness. Accepted deliberately: this project runs at most a
// handful of workers, so N sequential forks on top of the one hive already
// pays is not worth a batching scheme for.
function paneField(row: AgentRow, alive: Liveness): { pane: string } | Record<string, never> {
  if (!reportsAgentStateLog(row) || alive !== true) return {};
  const { awaitingChoice } = paneChoiceCheck(row.tmux_target);
  return { pane: describePaneChoice(awaitingChoice) };
}

function agentSummary(row: AgentRow, snapshot?: AliveSnapshot | null) {
  const alive = summaryLiveness(row, snapshot);
  // `state` is dropped from the nested object below and used directly as
  // agent_state instead: deriveProvenance already applies the "gone" override
  // when alive is false, so re-deriving it here with a second ternary would
  // be the exact kind of duplicated special case this module exists to kill
  // (a caller must trust the derivation's own answer, not recompute it).
  const { state, ...provenance } = deriveProvenance(row, alive);
  return {
    agent_id: row.id,
    kind: row.kind,
    name: row.name,
    actor_id: row.actor_id,
    status: alive === false && row.status === "running" ? "exited" : row.status,
    alive,
    agent_state: state,
    state_changed_at: row.state_changed_at,
    provenance,
    // last_log_event only -- SQL-only, cheap, and useful on both surfaces
    // that build on this shared summary. pane is NOT here; see paneField's
    // own comment for why it stays agent_list-only.
    ...lastLogEventField(row),
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
            "split (default): the worker appears as a pane in the lead's window, auto-tiled, so the whole crew shares one screen. window: its own tmux window (an iTerm tab under control mode).",
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
          // The worker resolves its own scope from this cwd at runtime
          // (src/context.ts's detectFromCwd), independent of what project
          // this spawn resolved above. An unregistered cwd is the ordinary
          // case (a worktree matches by git primary root; a scratch
          // directory belongs to nobody) and stays allowed. Only refuse when
          // cwd names a DIFFERENT project that is already registered: a
          // caller who means it passes project_id for the cwd's project.
          const cwdProject = findProjectForDir(cwd);
          if (cwdProject && cwdProject.id !== project.id) {
            // project_id is the deliberate escape hatch, but only an
            // unlocked caller (a lead) can use it: assertAccessible refuses
            // any project_id but the home one under HIVE_PROJECT_LOCK=1, so
            // a locked worker told to "pass project_id" would just get a
            // second, unrecoverable refusal. Tell it the truth instead.
            const remedy = process.env.HIVE_PROJECT_LOCK === "1"
              ? `This session is locked to project ${project.id} (HIVE_PROJECT_LOCK=1) and cannot spawn outside it.`
              : `Pass project_id: ${cwdProject.id} to spawn into the cwd's project deliberately.`;
            throw new Error(
              `cwd ${cwd} belongs to project "${cwdProject.name}" (id ${cwdProject.id}), but this spawn resolved to project "${project.name}" (id ${project.id}). ${remedy}`,
            );
          }
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
        "Change a worker's display name. Its actor_id (agent:N) does not change, so every pad write, todo comment and lease it has already made stays attributable. A live claude worker is also told to retitle its own session, which shows up in its pane; that arrives as a user turn, so rename between assignments rather than mid-task. Refuses a lead target outright.",
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
        // Issue #27's L4 fix round, DECISION 4/5. "lead" is the name every
        // wake, pad and todo comment addresses this project's lead by, and
        // ensureLeadRow (src/cli.ts) now keys its own lookup on kind='lead' +
        // running rather than on the name - so a rename would not even strand
        // the identity, it would let the NEXT `hive lead` mint a second one
        // under the freed name while the renamed row goes on being the real
        // lead under a name nothing points at any more. Refuse outright,
        // defence in depth alongside the kind='lead' keying: the message is
        // what a human or lead actually needs here, a silent non-strand is not.
        if (agent.kind === LEAD_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session. Its name is the handle ` +
              "every wake, pad and todo addresses it by; agent_rename refuses a lead target.",
          );
        }
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
          // D3: only for a row that is not confirmed alive -- a closed row, a
          // running row whose pane is gone, or one tmux could not be asked
          // about (alive === null). Omitted entirely for a live worker: the
          // common call here is against running workers, and that response
          // must not grow a long path per row for a worker whose terminal is
          // one agent_output away. The unknown case counts as "not confirmed
          // alive" on purpose -- a failed tmux probe is exactly the moment
          // agent_output stops answering, so it is where the transcript is
          // what is left, not a case to withhold it from.
          agents: rows.map((r) => {
            const summary = agentSummary(r, snapshot);
            return {
              ...summary,
              ...(summary.alive !== true ? transcriptDirField(r) : {}),
              // agent_list only -- see paneField's own comment for why this
              // is not inside agentSummary (agent_status must not get a
              // second, independently-timed pane snapshot).
              ...paneField(r, summary.alive),
            };
          }),
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
          // D2: always present for a claude worker here, unlike agent_list's
          // D3 gating -- this is the single-agent query a lead reaches for
          // once a pane is already gone.
          ...transcriptDirField(agent),
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
        //
        // BUT that escape-hatch argument is about a SUPERVISOR unsticking a
        // SUBORDINATE's TUI, and does not reach the lead: nothing supervises
        // it, the same premise agent_close's own refusal rests on (below).
        // Without a kind check here, any worker could type C-c C-c (or C-d)
        // at "lead" and end its session exactly as effectively as the
        // agent_close this lane already refuses - with no dialog guard, no
        // confirm_self, and no kind check of its own (issue #27's L4 fix
        // round R6, todo 169; counselors opus F3). Refused only when the
        // CALLER is not itself a lead: a peer lead keeps the hatch, for the
        // multi-lead direction this lane deliberately preserves
        // addressability for. .claude/rules/tmux-and-panes.md is updated to
        // match - it previously said this path "MUST STAY" unguarded, full
        // stop, and did not have this exception to make.
        //
        // Pre-existing, found by this lane's review rather than introduced by
        // it: passing both used to silently send keys and drop text, still
        // reporting sent: true. "keys won, text vanished" is not a thing any
        // caller can have meant, so this is a caller error, the same way
        // passing neither already is below.
        if (args.keys && args.keys.length > 0 && args.text != null) {
          throw new Error("Pass text or keys, not both.");
        } else if (args.keys && args.keys.length > 0) {
          if (agent.kind === LEAD_KIND && !isRunningLeadActor(currentActor())) {
            throw new Error(
              `Agent ${agent.id} ("${agent.name}") is this project's lead session, the one actor with no ` +
                "supervisor above it. agent_send refuses to send raw keys to a lead from a non-lead caller " +
                "(text still works); unstick or restart it from its own terminal instead.",
            );
          }
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
          // Issue #40. capturePane runs AFTER the send already landed, so a
          // pane that dies during the wait must not turn a successful send
          // into a reported error: a caller reading "error" here reasonably
          // retries, and a duplicated instruction mid-task is worse than a
          // missing tail. Same shape as paneChoiceCheck's wrapped read.
          // tail and note are mutually exclusive, so one field carries either.
          let tailField: { tail: string } | { note: string };
          try {
            tailField = { tail: capturePane(target, 15) };
          } catch {
            tailField = {
              note: "Sent, but the terminal tail could not be read afterward (the pane may have died during the wait). Check agent_status or agent_output to confirm the worker is still there.",
            };
          }
          return {
            agent_id: agent.id,
            name: agent.name,
            sent: true,
            ...tailField,
            // inputBoxField wraps its own read the same way, so it is called
            // unconditionally here rather than inside the try: a capturePane
            // failure must not also cost the input-box read that follows it.
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
        "Kill an agent's tmux window and mark it closed, addressed by name (or agent_id). Capture handoffs (todo comments, pads) BEFORE closing; terminal output is not retained. Closing yourself requires confirm_self=true. Refuses a lead target whose pane is live; retires one whose pane is confirmed dead. A worker may never close a lead, live or dead.",
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
        // Issue #27's L4 fix round R10, todo 181 item 1 (BOTH SEATS). R9's
        // retirement path (below) was written on the premise that closing a
        // lead is "the deliberate human action that replaces the
        // unanswerable question" (.claude/rules/tmux-and-panes.md's own
        // words) - but nothing enforced that premise. Any WORKER could call
        // agent_close(name: "lead") same as a human at a terminal; a worker
        // on a different tmux server even got a false "dead" for a lead
        // that is genuinely still running elsewhere, and retired it. Checked
        // before the probe below, and before the live-lead refusal further
        // down, because a worker has no business here whether the target
        // reads live, dead, or unknown: a plain claude session is
        // user:<name> and a peer lead is lead:N (src/context.ts), so only a
        // spawned worker's HIVE_AGENT_ID-derived agent:<id> trips this.
        if (agent.kind === LEAD_KIND && currentActor().startsWith("agent:")) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session. Retiring a lead - live, ` +
              "confirmed dead, or unprobed - is reserved for a human at a terminal or a peer lead; a " +
              "worker this project spawned may not close it.",
          );
        }
        // Refuse rather than half-close, for every kind. Closing the row
        // while the pane may still be up leaks a running process nothing
        // tracks, and the kill would not land anyway while tmux is
        // unreachable - unknown liveness must never be treated as dead
        // (issue #14).
        const live = isLive(agent);
        if (live === null) throw probeFailed(agent);
        // Issue #27's L4 fix round R9, todo 176 item 2. Used to refuse ANY
        // lead target outright, unconditionally - the argument (nothing
        // supervises the lead, so ending its session is a decision only its
        // own terminal gets to make) still holds while the pane is LIVE, and
        // still refuses here for exactly that reason. But an unconditional
        // refusal also meant a lead row could never be retired: the janitor
        // exempts kind='lead' (DECISION 3) and startYmlCommand cannot reach
        // it, so a lead whose session had genuinely ended stayed
        // status='running' forever, which is what made `hive restore`
        // latch shut permanently (todo 165) and then, after R8's liveness
        // probing attempt, guess wrong in both directions (todo 176's own
        // finding). A lead whose pane is CONFIRMED dead - not merely
        // unprobed - can now be closed like anything else, which is the
        // deliberate human action that replaces the unanswerable question.
        if (agent.kind === LEAD_KIND && live) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session, the one actor with no ` +
              "supervisor above it, and its pane is still live. agent_close refuses to end a running " +
              "lead's session; restart it from its own terminal instead.",
          );
        }
        if (agent.actor_id === currentActor() && args.confirm_self !== true) {
          throw new Error(
            "This would close your own session. Pass confirm_self=true only if the user explicitly asked you to close yourself.",
          );
        }
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
        // Issue #27's L4 fix round R10, todo 181 item 3 (codex F1).
        // Conditional on the target this call actually probed as `live`
        // above, not merely on id and status='running': a concurrent `hive
        // lead` can record a fresh pane on this exact row between the probe
        // and this write (the row this call read as a confirmed-dead lead,
        // CAS'd back to running by a restart that landed in the gap), and an
        // unconditional close would retire it anyway on the strength of a
        // probe that is no longer true - the lead keeps running but stops
        // resolving by name, and a peer store's `hive restore` loses this
        // row as a live-usage signal too. No kill-pane can have hit the
        // WRONG pane from this race (the branch above only kills when this
        // call's own probe said live, and a lead never reaches it live -
        // see the refusal above), so the only thing this guards is the row
        // write itself.
        if (!closeAgentRow(agent.id, agent.tmux_target)) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s row changed since this call probed it - most likely a ` +
              "concurrent `hive lead` recording a fresh pane on it. Nothing was closed. Re-run agent_close " +
              "if the agent is still not what you want.",
          );
        }
        return { agent_id: agent.id, name: agent.name, closed: true };
      }),
  );
}
