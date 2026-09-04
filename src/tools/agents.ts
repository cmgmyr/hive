import { existsSync, rmSync, statSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  agentBriefPath,
  mergedBriefVars,
  readAgentBrief,
  workerBrief,
  workerCommandString,
  writeAgentBrief,
} from "../brief.js";
import { codexHomeDir, codexInstructionsPhrase, codexLaunchArgs, ensureCodexHome } from "../codexHome.js";
import { currentActor, findProjectForDir, getProject, linkedWorktreePrimaryRoot, resolveProject } from "../context.js";
import {
  commandHead,
  harnessFor,
  harnessNames,
  paneClassifierFor,
  resolvedCommandPrefix,
  screenClassifiable,
} from "../harnesses.js";
import { ensureHooksFile } from "../hooks.js";
import { activeProfile, allowedAgents, loadProjectYml, type ProjectYml } from "../projectYml.js";
import {
  classifyMiss,
  LEAD_MESSAGE_THRESHOLD,
  leadPointerMarker,
  missMessage,
  readLeadMessage,
  renderLeadPointer,
  shortenedSendFailureClause,
  shortenedSendNote,
  storeLeadMessage,
} from "../leadMessage.js";
import { run } from "../result.js";
import { markGoneReported } from "../scheduler.js";
import {
  branchAt,
  closeAgentRow,
  discardOrphanedPane,
  isReservedAgentName,
  isRunningLeadActor,
  killAgentPane,
  launchAgent,
  LEAD_KIND,
  parkAgentRow,
  reapCodexHomeForClosedAgent,
  releaseParkRow,
  renameAgent,
  resumeAgent,
} from "../spawn.js";
import { COMMAND_KIND, runningCommandRow, stopLine, stopProcess, STOP_REASONS } from "../processes.js";
import { readContextTokens, resolveTranscriptDir } from "../transcript.js";
import {
  capturePane,
  captureFinalScreen,
  DEFAULT_LAYOUT,
  describePaneChoice,
  ensureAttached,
  findUnsafeControlChar,
  holdsHumanInput,
  liveTargets,
  paneCurrentCommand,
  paneInCopyMode,
  paneWindow,
  pollPaneReadiness,
  rowAlive,
  rowLive,
  sendText,
  sessionName,
  setRemainOnExit,
  sleep,
  TEXT_ALLOWED_CONTROL_CHARS,
  tmux,
  TmuxTimeoutError,
  WINDOW_LAYOUTS,
  type AliveSnapshot,
  type InputBoxState,
  type Liveness,
} from "../tmux.js";
import { agentIdParam, agentNameParam, idParam, projectIdParam } from "./params.js";
import {
  deriveProvenance,
  lastLogEvent,
  lastPermissionMode,
  reportsAgentStateLog,
  type LastLogEvent,
} from "../stateProvenance.js";

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
  session_id: string;
  parked_at: string;
  parked_branch: string;
  resumed_at: string;
  codex_home: string;
  exit_tail: string;
}

const CLOSED_ROW_ORDER = "(parked_at != '') DESC, closed_at DESC, id DESC";

function closedAgentNamed(
  projectId: number,
  needle: string,
): { id: number; name: string; kind: string; parked_at: string } | undefined {
  return (
    db
      .prepare(
        `SELECT id, name, kind, parked_at FROM agents WHERE project_id = ? AND status != 'running' ORDER BY ${CLOSED_ROW_ORDER}`,
      )
      .all(projectId) as { id: number; name: string; kind: string; parked_at: string }[]
  ).find((r) => r.name.toLowerCase() === needle);
}

function getAgentRow(projectId: number, id: number, notFoundHint: string): AgentRow {
  const row = db.prepare("SELECT * FROM agents WHERE project_id = ? AND id = ?").get(projectId, id) as
    | AgentRow
    | undefined;
  if (!row) throw new Error(`No agent ${id} in project ${projectId}. ${notFoundHint}`);
  return row;
}

export type LostCasReport = { outcome: "retired"; parked: boolean } | { outcome: "revived" };

export function classifyLostCas(row: Pick<AgentRow, "status" | "parked_at">): LostCasReport {
  return row.status !== "running" ? { outcome: "retired", parked: !!row.parked_at } : { outcome: "revived" };
}

function revivedError(agent: { id: number; name: string }, live: boolean, cause: string, remedy: string): Error {
  return new Error(
    `Agent ${agent.id} ("${agent.name}") is running again: its row changed since this call probed it, most ` +
      `likely ${cause}` +
      (live ? " after this call's kill-pane took the old one down" : "") +
      `. ${remedy}`,
  );
}

export function findAgent(projectId: number, ref: { agent_id?: number; name?: string }): AgentRow {
  if (ref.agent_id != null) {
    return getAgentRow(projectId, ref.agent_id, "Call agent_list.");
  }
  if (ref.name) {
    const rows = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
      .all(projectId) as AgentRow[];

    const exact = rows.filter((r) => r.name === ref.name);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`Multiple running agents named "${ref.name}". Target by agent_id instead.`);
    }

    const needle = ref.name.toLowerCase();
    const sameName = rows.filter((r) => r.name.toLowerCase() === needle);
    if (sameName.length === 1) return sameName[0];

    const closed = closedAgentNamed(projectId, needle);
    if (closed) {

      if (closed.parked_at) {
        throw new Error(
          `Agent ${closed.id} ("${closed.name}") is PARKED, not finished - it was paused on ` +
            `${closed.parked_at} and its session is waiting. Bring it back with agent_resume(agent_id: ` +
            `${closed.id}), or abandon the park with agent_close(agent_id: ${closed.id}).`,
        );
      }
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

function findClosedAgent(projectId: number, ref: { agent_id?: number; name?: string }): AgentRow {
  if (ref.agent_id != null) {
    const row = getAgentRow(projectId, ref.agent_id, "Call agent_list(include_closed: true).");
    if (row.status !== "closed") {
      throw new Error(`Agent ${row.id} ("${row.name}") is not closed (status: ${row.status}).`);
    }
    return row;
  }
  if (ref.name) {
    const needle = ref.name.toLowerCase();
    const match = (
      db
        .prepare(`SELECT * FROM agents WHERE project_id = ? AND status = 'closed' ORDER BY ${CLOSED_ROW_ORDER}`)
        .all(projectId) as AgentRow[]
    ).find((r) => r.name.toLowerCase() === needle);
    if (!match) {
      throw new Error(`No closed agent matching "${ref.name}" in project ${projectId}. Call agent_list(include_closed: true).`);
    }
    return match;
  }
  throw new Error("Pass agent_id or name.");
}

function laneTodoIds(projectId: number, actorId: string): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT c.todo_id AS id FROM todo_comments c
           JOIN todos t ON t.id = c.todo_id
          WHERE c.author = ? AND t.project_id = ? AND t.archived_at IS NULL
          ORDER BY c.todo_id`,
      )
      .all(actorId, projectId) as { id: number }[]
  ).map((r) => r.id);
}

function parkedBoardLine(fields: {
  parkedAt: string;
  name: string;
  agentId: number;
  branch: string;
  cwd: string;
  todoIds: number[];
}): string {
  const day = fields.parkedAt.slice(0, 10);
  const todos = fields.todoIds.length > 0 ? `  todos ${fields.todoIds.join(", ")}` : "";
  return (
    `PARKED ${day}  ${fields.name}  agent_id ${fields.agentId}${todos}\n` +
    `  branch ${fields.branch || "(unrecorded)"}  cwd ${fields.cwd}\n` +
    `  resume: agent_resume(agent_id: ${fields.agentId})`
  );
}

function buildParkReceipt(
  project: { id: number },
  agent: { id: number; name: string; actor_id: string; cwd: string; session_id: string },
  parkedAt: string,
  branch: string,
  note?: string,
) {
  const todoIds = laneTodoIds(project.id, agent.actor_id);
  return {
    agent_id: agent.id,
    name: agent.name,
    parked: true,
    parked_at: parkedAt,
    parked_branch: branch,
    cwd: agent.cwd,
    session_id: agent.session_id,
    todo_ids: todoIds,
    board_line: parkedBoardLine({ parkedAt, name: agent.name, agentId: agent.id, branch, cwd: agent.cwd, todoIds }),
    ...(note ? { note } : {}),
  };
}

export function isLive(agent: AgentRow): Liveness {
  if (agent.status !== "running") return false;
  return rowLive(agent.tmux_socket, agent.tmux_target);
}

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

function runningAgentNamed(
  projectId: number,
  name: string,
  exceptAgentId?: number,
): { id: number; name: string } | undefined {
  const needle = name.toLowerCase();
  return (
    db
      .prepare("SELECT id, name FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
      .all(projectId) as { id: number; name: string }[]
  ).find((r) => r.id !== exceptAgentId && r.name.toLowerCase() === needle);
}

function requireNameFree(projectId: number, name: string, exceptAgentId?: number): void {
  const needle = name.toLowerCase();

  if (isReservedAgentName(needle)) {
    throw new Error(`"${name}" is reserved for this project's lead session and cannot be used as a worker name.`);
  }
  const taken = runningAgentNamed(projectId, name, exceptAgentId);
  if (taken) {
    throw new Error(`A running agent named "${taken.name}" already exists. Pick another name.`);
  }
}

// Recovers a flag's value from a row's own recorded command string - the only place agent_resume
// can read it back from, since ResumeSpec is built fresh and does not carry agent_spawn's original
// args. Model ids are shell-safe by construction (gpt-5.6-luna, sonnet), so shellQuote never quotes
// this token and a plain whitespace split is enough - no quote-stripping to get wrong.
function extractCommandFlag(command: string, flag: string): string | undefined {
  const tokens = command.split(/\s+/);
  const i = tokens.indexOf(flag);
  if (i === -1 || i + 1 >= tokens.length) return undefined;
  return tokens[i + 1];
}

function requestsExistingSession(extraArgs: string[] | undefined): boolean {
  return (extraArgs ?? []).some(
    (arg) =>
      arg === "--resume" ||
      arg.startsWith("--resume=") ||
      arg === "--fork-session" ||
      (arg.startsWith("-r") && !arg.startsWith("--")),
  );
}

function normalizeAgentName(raw: string, field: "name" | "new_name"): string {
  const name = raw.trim();
  if (!name) throw new Error(`${field} cannot be empty.`);
  const bad = findUnsafeControlChar(name, new Set());
  if (bad) {
    throw new Error(
      `${field} cannot contain ${bad.label} at offset ${bad.index}: it is typed into the worker's terminal, ` +
        "where a raw control byte reaches tmux as a keystroke instead of as text. No control characters are " +
        "allowed in a name, including tabs and newlines.",
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

const PANE_READY_MS = Number(process.env.HIVE_SPAWN_READY_MS ?? 45_000);

export function summaryLiveness(row: AgentRow, snapshot?: AliveSnapshot | null): Liveness {

  if (row.status !== "running") return false;
  if (snapshot === undefined) return rowLive(row.tmux_socket, row.tmux_target);
  if (snapshot === null) return null;
  return rowAlive(row.tmux_socket, row.tmux_target, snapshot);
}

function capturePaneQuietly(target: string): string {
  try {
    return capturePane(target, 15);
  } catch {
    return "";
  }
}

function inputBoxField(
  command: string,
  target: string,
): { input_box: Omit<InputBoxState, "text"> & { text?: string } } | Record<string, never> {
  const box = paneClassifierFor(command)?.inputBoxState(target) ?? null;
  if (!box) return {};
  if (box.state === "ghost") {
    const { state } = box;
    return { input_box: { state } };
  }
  return { input_box: box };
}

export function claudeOnlyFields(
  row: AgentRow,
): { transcript_dir: string | null; session_id: string | null } | Record<string, never> {
  return harnessFor(row.command).transcriptDir
    ? { transcript_dir: resolveTranscriptDir(row.cwd), session_id: row.session_id || null }
    : {};
}

function lastLogEventField(row: AgentRow): { last_log_event: LastLogEvent | null } | Record<string, never> {
  return reportsAgentStateLog(row) ? { last_log_event: lastLogEvent(row.actor_id) } : {};
}

function permissionModeField(row: AgentRow): { permission_mode: string | null } | Record<string, never> {
  return reportsAgentStateLog(row) ? { permission_mode: lastPermissionMode(row.actor_id) } : {};
}

// Reads its own contextTokens capability, distinct from claudeOnlyFields' transcriptDir: agent_status
// is the only caller, and claudeOnlyFields also feeds agent_list's closed-row path, which this must not.
export function contextTokensField(row: AgentRow): { context_tokens: number | null } | Record<string, never> {
  return harnessFor(row.command).contextTokens
    ? { context_tokens: readContextTokens(row.cwd, row.session_id) }
    : {};
}

function paneField(row: AgentRow, alive: Liveness): { pane: string } | Record<string, never> {
  if (!reportsAgentStateLog(row) || alive !== true) return {};
  const awaitingChoice = paneClassifierFor(row.command)?.choiceCheck(row.tmux_target).awaitingChoice ?? null;
  return { pane: describePaneChoice(awaitingChoice) };
}

function agentSummary(row: AgentRow, snapshot?: AliveSnapshot | null) {
  const alive = summaryLiveness(row, snapshot);

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

    ...lastLogEventField(row),
    ...permissionModeField(row),

    ...(row.parked_at ? { parked_at: row.parked_at, parked_branch: row.parked_branch || null } : {}),
    tmux_target: row.tmux_target,
    command: row.command,
    cwd: row.cwd,
    parent_actor_id: row.parent_actor_id,
    created_at: row.created_at,
  };
}

export function worktreeInstallNotice(cwd: string, projectPath: string, config: ProjectYml | null): string | undefined {
  const install = config?.vars?.install?.trim();
  if (!install) return undefined;
  const primaryRoot = linkedWorktreePrimaryRoot(cwd);
  if (primaryRoot === null || primaryRoot !== projectPath) return undefined;
  return install;
}

export function registerAgents(server: McpServer): void {
  server.registerTool(
    "agent_spawn",
    {
      description:
        "Spawn a worker agent (default: claude, or the project's hive.yml agents: default). A claude worker is briefed automatically: the full brief is appended to its system prompt, so send it its assignment directly. A command or harness that resolves to a known harness (claude, codex) not listed in the project's hive.yml agents: is refused; absent agents: means claude only. A command hive cannot classify the screen of (claude and codex both do; a harness with no entry does not) can be spawned but NOT typed into: the receipt carries brief_path and says so, and agent_send's text path and wakes both refuse that pane. The worker is locked to this project. Humans can watch with: tmux attach -t hive-main.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Display name; defaults to worker-N. This is how you address the worker later."),
        model: z.string().optional().describe("Passed as --model to the agent command."),
        command: z
          .string()
          .optional()
          .describe(
            "Raw agent command to run. Overrides harness when both are given. Defaults to the project's hive.yml agents: default, or claude. Refused if it resolves to a known harness the project's agents: list does not allow.",
          ),
        harness: z
          .string()
          .optional()
          .describe(
            "Spawn a known harness by name (e.g. \"codex\") instead of a raw command. Ignored when command is also given. Must be in the project's hive.yml agents: list (default: claude only).",
          ),
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
      outputSchema: {
        agent_id: idParam,
        actor_id: z.string(),
        name: z.string(),
        tmux_target: z.string(),
        layout: z.enum(WINDOW_LAYOUTS).optional(),
        landed_in_project: z.string().optional(),
        config_warnings: z.array(z.string()).optional(),
        worktree_install: z.string().optional(),
        brief_path: z.string().optional(),
        codex_home: z.string().optional(),
        codex_instructions: z.string().optional(),
        ready: z.boolean().optional(),
        exited: z.boolean().optional(),
        note: z.string().optional(),
        tail: z.string().optional(),
        instructions: z.string().optional(),
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

          const cwdProject = findProjectForDir(cwd);
          if (cwdProject && cwdProject.id !== project.id) {

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

        const { config: projectConfig, warnings: configWarnings } = loadProjectYml(project.path);

        let baseCommand: string;
        if (args.command) {
          baseCommand = args.command;
        } else if (args.harness) {
          if (!harnessNames().includes(args.harness)) {
            throw new Error(`Unknown harness "${args.harness}". Known harnesses: ${harnessNames().join(", ")}.`);
          }
          baseCommand = args.harness;
        } else {
          baseCommand = allowedAgents(projectConfig)[0];
        }

        // Gates only a command hive actually recognizes as one of its own harnesses (matched by
        // basename, todo 521's known blind spot: a command whose basename merely LOOKS like "claude"
        // or "codex" is gated exactly as strongly as it is classified elsewhere, no more). A command
        // hive cannot classify at all (harnessFor -> "unknown", not in harnessNames()) was never part
        // of the crew-harness pool this key governs and stays ungated, same as before this lane.
        const harness = harnessFor(baseCommand);
        const allowed = allowedAgents(projectConfig);
        if (harnessNames().includes(harness.name) && !allowed.includes(harness.name)) {
          throw new Error(
            `[agent_spawn:harness-not-allowed] "${harness.name}" is not in this project's hive.yml ` +
              `agents: list (${allowed.join(", ")}). Add it to agents: to allow spawning it.`,
          );
        }
        const mintsSession = harness.mintsSessionId;

        const sessionId = mintsSession && !requestsExistingSession(args.extra_args) ? randomUUID() : "";

        const worktreeInstall = worktreeInstallNotice(cwd, project.path, projectConfig);
        const briefFor = (actorId: string) => ({
          name,
          actorId,
          projectName: project.name,
          projectPath: project.path,
          cwd,
          profile: activeProfile(projectConfig),
          vars: mergedBriefVars(projectConfig?.vars, harness.name),
        });
        // Minted before the agent row exists (unlike agentId/actorId), so CODEX_HOME's own path can
        // go straight into launchAgent's static env below rather than needing agentId to name it.
        const codexHomeKey = harness.needsHome ? randomUUID() : undefined;
        // Set inside buildCommand (below), which ensureCodexHome runs in - captured here so the
        // receipt built after launchAgent returns can still name which layers were found.
        let codexInstructionLayers: string[] = [];
        const buildCommand = ({ agentId, actorId }: { agentId: number; actorId: string }) => {
          const brief = harness.briefDelivery || codexHomeKey ? workerBrief(briefFor(actorId)) : undefined;
          const briefPath = harness.briefDelivery ? writeAgentBrief(agentId, brief!) : undefined;
          let homeArgs: string[] = [];
          if (codexHomeKey) {
            const home = ensureCodexHome({ key: codexHomeKey, actorId, cwd, brief: brief! });
            homeArgs = home.extraArgs;
            codexInstructionLayers = home.instructionLayers;
          }
          return workerCommandString({
            command: baseCommand,
            displayName: name,
            model: args.model,

            extraArgs: [
              ...homeArgs,
              ...(mintsSession
                ? [...(sessionId ? ["--session-id", sessionId] : []), ...(args.extra_args ?? [])]
                : (args.extra_args ?? [])),
            ],
            settingsPath: harness.briefDelivery ? ensureHooksFile() : undefined,
            briefPath,
          });
        };
        const placement =
          args.placement ??
          projectConfig?.placement ??
          (process.env.HIVE_SPAWN_PLACEMENT === "window" ? "window" : "split");
        const layout = args.layout ?? projectConfig?.layout ?? DEFAULT_LAYOUT;

        let spawned;
        try {
          spawned = launchAgent({
            projectId: project.id,
            projectName: project.name,
            projectPath: project.path,
            name,
            kind: "agent",
            commandString: buildCommand,
            cwd,
            env: codexHomeKey ? { CODEX_HOME: codexHomeDir(codexHomeKey) } : {},
            placement,
            layout,
            parentActor: parent,
            sessionId,
            codexHome: codexHomeKey,
            retainOnExit: harness.classifiesPaneScreen,
          });
        } catch (e) {
          // buildCommand already wrote CODEX_HOME to disk (auth.json symlink included) before
          // launchAgent's own failure paths run; a codex worker that never got a pane must not
          // leave that home orphaned. Narrow on purpose - the wider "nothing ever reaps
          // codex-homes/briefs/postures" question is a separate, filed concern, not this fix.
          if (codexHomeKey) rmSync(codexHomeDir(codexHomeKey), { recursive: true, force: true });
          throw e;
        }
        const { agentId, actorId, target, landedInProjectId, layoutApplied } = spawned;
        ensureAttached(sessionName());

        let ready = false;
        let dialogTail: string | undefined;
        let exited = false;
        let exitTail: string | undefined;
        if (harness.classifiesPaneScreen) {
          const classifier = harness.paneClassifier!;
          // Captured before anything below can kill the pane: remain-on-exit is a WINDOW option,
          // and the pane id itself stops being addressable once discardOrphanedPane has run.
          const windowTarget = paneWindow(target) ?? target;
          try {
            const outcome = await pollPaneReadiness(target, PANE_READY_MS, classifier.hasInputBox);
            if (outcome === "gone") {
              // remain-on-exit held the pane so its final screen is still readable; capture it,
              // persist it onto the row (the pane below is about to be killed), then release it.
              // Never run choiceCheck against a retained-but-dead pane: it is frozen content, not
              // a live dialog, and choiceCheck's own capture is tuned to read a live screen.
              exited = true;
              exitTail = captureFinalScreen(target, 30);
              db.prepare("UPDATE agents SET exit_tail = ? WHERE id = ?").run(exitTail, agentId);
              discardOrphanedPane(target);
            } else {
              const { awaitingChoice, tail } = classifier.choiceCheck(target);
              if (awaitingChoice === true) {
                dialogTail = tail;
              } else if (outcome === "ready") {
                ready = true;
              }
            }
          } catch {

            ready = false;
          } finally {
            // Unconditional: every early return, throw, or timeout between arming remain-on-exit
            // and here must still clear it, or the shared window (the default split placement's)
            // is left silently retaining every later exit in it, not just this one.
            setRemainOnExit(windowTarget, false);
          }
        }

        const codexInstructions = codexHomeKey ? codexInstructionsPhrase(codexInstructionLayers) : undefined;

        return {
          agent_id: agentId,
          actor_id: actorId,
          name,
          tmux_target: target,
          ...(layoutApplied ? { layout } : {}),

          ...(landedInProjectId != null
            ? { landed_in_project: getProject(landedInProjectId)?.name ?? `project ${landedInProjectId}` }
            : {}),

          ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),

          ...(worktreeInstall ? { worktree_install: worktreeInstall } : {}),
          ...(harness.briefDelivery || codexHomeKey
            ? {
                ...(harness.briefDelivery ? { brief_path: agentBriefPath(agentId) } : {}),
                ...(codexHomeKey ? { codex_home: codexHomeDir(codexHomeKey) } : {}),
                ...(codexInstructions ? { codex_instructions: codexInstructions } : {}),

                ready,
                ...(ready
                  ? {}
                  : dialogTail !== undefined
                    ? {
                        note: "The pane is waiting on a choice (e.g. a folder-trust or permission prompt). Clear it with agent_send keys, then send the worker its assignment.",
                        tail: dialogTail,
                      }
                    : exited
                      ? {
                          exited: true,
                          note: "The pane's process exited before it became ready. Its final screen (likely the reason) is in tail.",
                          tail: exitTail,
                        }
                      : {
                          note: "The pane never became ready. The brief is loaded regardless; check agent_output before sending the worker its assignment - typing into it now risks losing the text silently.",
                        }),
              }
            : harness.classifiesPaneScreen
              ? {
                  instructions: workerBrief(briefFor(actorId)),
                }
              : {
                  brief_path: writeAgentBrief(agentId, workerBrief(briefFor(actorId))),
                  note:
                    `This worker runs ${JSON.stringify(commandHead(baseCommand))}, which hive cannot brief and ` +
                    "cannot type into: the guards that make typing safe read claude's chrome, so agent_send's " +
                    "text path refuses this pane. There are no instructions to prepend, because there is no " +
                    "supported way to send them. The brief is written to brief_path - open that pane " +
                    "(tmux attach) and paste it in yourself, or drive the worker with agent_send(keys: [...]). " +
                    "Wakes aimed at this worker are refused for the same reason.",
                }),
        };
      }),
  );

  server.registerTool(
    "agent_resume",
    {
      description:
        "Resume a CLOSED claude or codex worker from its recorded session id (claude --resume / codex resume): a fresh pane, the same actor_id, and the worker's full prior context. Addressed by name or agent_id among closed agents (agent_list(include_closed: true)). Send it its next instruction with agent_send once resumed - this tool does not.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
        project_id: projectIdParam,
      },
      outputSchema: {
        agent_id: idParam,
        actor_id: z.string(),
        name: z.string(),
        tmux_target: z.string(),
        resumed_session_id: z.string(),
        was_parked_at: z.string().optional(),
        branch_drift: z
          .object({ parked_branch: z.string(), branch_now: z.string() })
          .optional(),
        landed_in_project: z.string().optional(),
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const agent = findClosedAgent(project.id, args);

        if (agent.kind === LEAD_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session. agent_resume is for workers; ` +
              "start a lead session with `hive lead`.",
          );
        }
        const resumeHarness = harnessFor(agent.command);
        if (!resumeHarness.supportsResume) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s harness ("${resumeHarness.name}", command: "${agent.command}") ` +
              "does not support resume, so it has no session id to resume from.",
          );
        }
        if (!agent.session_id) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") has no recorded session id, so it cannot be resumed. It may ` +
              "predate this feature, or it may have closed before its first hook event ever fired. Spawn a new " +
              "worker instead.",
          );
        }
        if (resumeHarness.name === "codex" && !agent.codex_home) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") has no recorded CODEX_HOME, so its session cannot be resumed. ` +
              (agent.parked_at
                ? "This should not happen for a parked codex worker - its home is only reaped on agent_close. " +
                  "Check agent_status for how it actually got here."
                : "It was closed with agent_close, which reaps a codex worker's home (rollout files included) " +
                  "immediately - only a PARKED codex worker keeps its home. Nothing here to resume; spawn a new " +
                  "worker instead."),
          );
        }

        if (!existsSync(agent.cwd)) {
          const recreate = agent.parked_branch
            ? `git worktree add ${agent.cwd} ${agent.parked_branch}`
            : `recreate a checkout at ${agent.cwd} (no branch was recorded for it - agent_park records one)`;
          const reason =
            resumeHarness.name === "codex"
              ? "It resumes into that directory as its working directory"
              : "Its transcript is resolved from that path";
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s working directory is gone: ${agent.cwd}. ${reason}, so ` +
              `recreate it and the resume works unchanged: ${recreate}`,
          );
        }

        const branchNow = agent.parked_branch ? branchAt(agent.cwd) : "";
        const branchDrift =
          branchNow && branchNow !== agent.parked_branch
            ? { parked_branch: agent.parked_branch, branch_now: branchNow }
            : null;

        const collision = runningAgentNamed(project.id, agent.name);
        if (collision) {
          throw new Error(
            `Cannot resume agent ${agent.id} ("${agent.name}") under its recorded name: a running agent ` +
              `(agent ${collision.id}) already has it. agent_resume does not rename on your behalf - the ` +
              `${agent.parked_at ? "parked" : "closed"} lane is not lost, it just cannot come back under a name ` +
              "someone else is using. Free the name first (agent_rename or agent_close on the running one), " +
              `then retry agent_resume(agent_id: ${agent.id}).`,
          );
        }

        const { config: projectConfig } = loadProjectYml(project.path);
        const placement =
          projectConfig?.placement ?? (process.env.HIVE_SPAWN_PLACEMENT === "window" ? "window" : "split");
        const layout = projectConfig?.layout ?? DEFAULT_LAYOUT;

        let commandString: string;
        let resumeEnv: Record<string, string> = {};
        if (resumeHarness.name === "codex") {
          commandString = workerCommandString({
            command: resolvedCommandPrefix(agent.command) || "codex",
            // Recovered from the row's own recorded command: every codex worker hive spawns
            // carries a pinned model (codex has no bare alias), so dropping this would silently
            // resume on codex's default model instead of the one the lane actually chose.
            model: extractCommandFlag(agent.command, "--model"),
            displayName: agent.name,
            // Subcommand positional, not a flag - live-verified on v0.149.0 (`codex resume --help`:
            // "Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]"). No --settings/hooks file: a
            // codex worker's hooks come from its own home's hooks.json, never claude's shared one.
            extraArgs: [...codexLaunchArgs(agent.cwd), "resume", agent.session_id],
          });
          resumeEnv = { CODEX_HOME: codexHomeDir(agent.codex_home) };
        } else {
          const claudeBinary = resolvedCommandPrefix(agent.command) || "claude";
          commandString = workerCommandString({
            command: claudeBinary,
            displayName: agent.name,
            extraArgs: ["--resume", agent.session_id],
            settingsPath: ensureHooksFile(),
          });
        }

        const { target, landedInProjectId } = resumeAgent({
          agentId: agent.id,
          actorId: agent.actor_id,
          name: agent.name,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          cwd: agent.cwd,
          commandString,
          env: resumeEnv,
          placement,
          layout,
          parentActor: currentActor(),
        });
        ensureAttached(sessionName());

        return {
          agent_id: agent.id,
          actor_id: agent.actor_id,
          name: agent.name,
          tmux_target: target,
          resumed_session_id: agent.session_id,

          ...(agent.parked_at ? { was_parked_at: agent.parked_at } : {}),
          ...(branchDrift ? { branch_drift: branchDrift } : {}),
          ...(landedInProjectId != null
            ? { landed_in_project: getProject(landedInProjectId)?.name ?? `project ${landedInProjectId}` }
            : {}),
        };
      }),
  );

  server.registerTool(
    "agent_park",
    {
      description:
        "Park a claude or codex worker for the night: kill its pane, mark the row PARKED rather than plain closed, record the branch, and hand back a board line plus the one call that brings it back. Use this instead of agent_close when the lane is paused, not finished - `closed` alone cannot tell a next-morning lead which is which. Resume it with agent_resume.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
        confirm_self: z.boolean().optional(),
        project_id: projectIdParam,
      },
      outputSchema: {
        agent_id: idParam,
        name: z.string(),
        parked: z.boolean(),
        parked_at: z.string(),
        parked_branch: z.string(),
        cwd: z.string(),
        session_id: z.string(),
        todo_ids: z.array(idParam),
        board_line: z.string(),
        note: z.string().optional(),
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        if (agent.kind === COMMAND_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is a hive.yml process, not a worker session, so there is no ` +
              "conversation to resume and parking it would promise one. Stop it with agent_close, or " +
              `hive stop "${agent.name}".`,
          );
        }

        if (agent.kind === LEAD_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session, which is not a lane to pause. ` +
              "Leads restart with `hive lead`, which recovers the same row and actor id.",
          );
        }

        const parkHarness = harnessFor(agent.command);
        if (!parkHarness.supportsResume) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s harness ("${parkHarness.name}", command: "${agent.command}") ` +
              "does not support resume, so it has no session to resume and nothing to park. Close it with agent_close.",
          );
        }
        if (!agent.session_id) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") has no recorded session id, so parking it would promise a resume ` +
              "that cannot happen. It may predate this feature, or have closed before its first hook event fired. " +
              "Close it with agent_close and spawn a fresh worker tomorrow.",
          );
        }

        if (!existsSync(agent.cwd)) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s working directory is already gone: ${agent.cwd}. Parking it ` +
              "would record a lane that cannot be resumed, and its branch can no longer be read. Recreate that " +
              "path first if you want this lane back tomorrow, or close it with agent_close.",
          );
        }
        const live = isLive(agent);

        if (live === null) throw probeFailed(agent);
        if (agent.actor_id === currentActor() && args.confirm_self !== true) {
          throw new Error(
            "This would park your own session. Pass confirm_self=true only if the user explicitly asked you to park yourself.",
          );
        }

        const branch = branchAt(agent.cwd);
        if (live) killAgentPane(agent.tmux_target);

        const parkedAt = parkAgentRow(agent.id, agent.tmux_target, branch);
        if (parkedAt === undefined) {

          const after = getAgentRow(project.id, agent.id, "Call agent_list(include_closed: true).");
          const report = classifyLostCas(after);
          if (report.outcome === "retired") {
            if (report.parked) {

              return buildParkReceipt(
                project,
                agent,
                after.parked_at,
                after.parked_branch,
                `Already parked by a concurrent agent_park before this call's own write landed` +
                  (live ? " (this call's kill-pane already took the pane down)." : "."),
              );
            }

            throw new Error(
              `Agent ${agent.id} ("${agent.name}") was closed by someone else, not parked, before this call's ` +
                `own write landed` +
                (live ? " - this call's kill-pane already took the pane down" : "") +
                ". It is closed, but has no recorded branch through this call, so resuming it may not work the " +
                "way this park was meant to. Check how it was actually closed with agent_list(include_closed: true).",
            );
          }
          throw revivedError(
            agent,
            live,
            "a concurrent agent_resume reviving it",
            "Nothing was parked. Re-read it with agent_status and try again.",
          );
        }

        return buildParkReceipt(project, agent, parkedAt, branch);
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
      outputSchema: {
        agent_id: idParam,
        actor_id: z.string(),
        name: z.string(),
        previous_name: z.string(),
        retitled: z.boolean(),
        note: z.string().optional(),
        tail: z.string().optional(),
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);

        if (agent.kind === LEAD_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session. Its name is the handle ` +
              "every wake, pad and todo addresses it by; agent_rename refuses a lead target.",
          );
        }

        if (agent.status !== "running") {
          throw new Error(`Agent ${agent.id} ("${agent.name}") is closed and cannot be renamed.`);
        }
        const newName = normalizeAgentName(args.new_name, "new_name");
        requireNameFree(project.id, newName, agent.id);

        const live = isLive(agent) === true;

        renameAgent(agent, newName, live ? project.name : null);

        let retitled = false;
        let heldNote: string | undefined;
        let heldTail: string | undefined;
        const renameHarness = harnessFor(agent.command);
        if (live && renameHarness.supportsRename) {
          const classifier = renameHarness.paneClassifier!;
          const { awaitingChoice, tail } = classifier.choiceCheck(agent.tmux_target);

          const box = awaitingChoice === false ? classifier.inputBoxState(agent.tmux_target) : null;
          if (awaitingChoice === true) {
            heldNote =
              "Not retitled: the pane is waiting on a choice, so typing /rename would answer it instead of setting the title. Clear the prompt first (agent_send with keys), then retry.";
            heldTail = tail;
          } else if (awaitingChoice === null) {
            // A read that did not answer is a THIRD outcome, never "no dialog". /rename is a paste
            // followed by Enter, so this path types blind exactly as agent_send's did.
            heldNote =
              "Not retitled: the pane could not be read, so hive cannot tell whether a dialog is on screen, and " +
              "typing /rename into one answers it instead of setting the title. The row IS renamed - it is " +
              `"${newName}" now - and only the pane's own title was left alone. This is usually a tmux call that ` +
              "timed out rather than anything about the target; check it with agent_output, then call " +
              `agent_rename(name: "${newName}", new_name: "${newName}") to retitle the pane.`;
            heldTail = tail;
          } else if (holdsHumanInput(box)) {

            heldNote =
              `Not retitled: the pane's input box holds unsubmitted text, so /rename would be pasted onto the end of it and submitted as prose rather than run as a command. The row IS renamed - it is "${newName}" now - and only the pane's own title was left alone. Clear the line with agent_send(keys: ["C-a", "C-k"]) once you can attribute the text, then call agent_rename(name: "${newName}", new_name: "${newName}") to retitle the pane.`;
            heldTail = tail;
          } else {

            let pasted = false;
            try {
              await sendText(agent.tmux_target, `/rename ${newName}`, true, () => {
                pasted = true;
              });
              retitled = true;
            } catch {
              if (pasted) {
                heldNote =
                  `Not retitled: the rename command reached the pane but the Enter that submits it failed, so "/rename ${newName}" is sitting on screen unsubmitted. The row IS renamed - it is "${newName}" now - only the pane's own title was left alone. Do not resend /rename: agent_send(name: ${JSON.stringify(newName)}, keys: ["Enter"]) finishes this exact delivery, or agent_send(name: ${JSON.stringify(newName)}, keys: ["C-a", "C-k"]) clears it.`;
                try {
                  heldTail = capturePane(agent.tmux_target, 15);
                } catch {

                }
              }

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

          ...(snapshot === null
            ? {
                note: `${PROBE_FAILED_NOTE} These rows are what the store holds; do not conclude a worker died.`,
              }
            : {}),

          agents: rows.map((r) => {
            const summary = agentSummary(r, snapshot);
            return {
              ...summary,
              ...(summary.alive !== true ? claudeOnlyFields(r) : {}),

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

          ...(summary.alive === null ? { note: PROBE_FAILED_NOTE } : {}),
          closed_at: agent.closed_at,
          current_command: summary.alive ? paneCurrentCommand(agent.tmux_target) : null,

          brief_path: existsSync(briefPath) ? briefPath : null,
          ...(args.include_brief ? { brief: readAgentBrief(agent.id) } : {}),
          tail: summary.alive ? capturePane(agent.tmux_target, 15) : "",
          ...(summary.alive ? inputBoxField(agent.command, agent.tmux_target) : {}),
          ...(agent.exit_tail ? { exit_tail: agent.exit_tail } : {}),

          ...claudeOnlyFields(agent),
          ...contextTokensField(agent),
        };
      }),
  );

  server.registerTool(
    "agent_send",
    {
      description:
        "Type into an agent's terminal, addressed by name (or agent_id). text of any shape is delivered as one bracketed paste and submitted with Enter unless submit=false. ONE EXCEPTION: text over 300 characters sent to a LEAD by anyone who is not that lead is stored and delivered as a one-line pointer instead, because a lead's pane is a human's own window; the receipt says so and names agent_message_get for the full text. Worker-bound text is never shortened at any length. Alternatively pass keys (tmux key names like Escape, C-c, Enter). wait_ms (250-10000) returns the terminal tail after sending. A claude worker is already briefed by agent_spawn. A worker whose screen hive cannot classify is REFUSED on the text path entirely (its brief is at the spawn receipt's brief_path); keys still reaches it. A pane in tmux copy mode is REFUSED too, and retriably: tmux clears its bracketed-paste flag there, so the paste would lose its markers and the Enter would be eaten - leave copy mode and send again.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
        text: z.string().optional(),
        keys: z.array(z.string()).optional().describe("tmux key names, e.g. [\"Escape\"] or [\"C-c\"]."),
        submit: z.boolean().optional().describe("Append Enter after text. Defaults to true."),

        wait_ms: z.number().int().min(250).max(10000).optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);
        requireLive(agent);
        const target = agent.tmux_target;
        let outgoing = args.text ?? "";
        let shortened: { message_id: number; note: string; marker: string } | null = null;
        const withShortened = <T extends Record<string, unknown> & { note?: string }>(receipt: T) =>
          shortened === null
            ? receipt
            : {
                ...receipt,
                shortened: true,
                message_id: shortened.message_id,
                note: receipt.note == null ? shortened.note : `${receipt.note} ${shortened.note}`,
              };

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

          const badChar = findUnsafeControlChar(args.text, TEXT_ALLOWED_CONTROL_CHARS);
          if (badChar) {
            throw new Error(
              `text cannot contain ${badChar.label} at offset ${badChar.index}: it is typed literally into ` +
                "the pane, and a raw control byte reaches tmux as a keystroke instead of as text, silently " +
                "turning a text call into a keys call. Tab and newline are the only control characters " +
                'allowed. To send an actual keystroke on purpose, use keys instead (e.g. keys: ["C-c"]).',
            );
          }
          if (!screenClassifiable(agent.command)) {
            return {
              agent_id: agent.id,
              name: agent.name,
              sent: false,
              note:
                `Text was NOT sent: this pane runs ${JSON.stringify(commandHead(agent.command))}, and hive can ` +
                "only classify a claude screen. Both guards that make typing safe read that chrome, so on this " +
                "pane neither can answer: a dialog would not be seen (the Enter after the paste would answer " +
                "it), and unsubmitted text in the box would not be seen (the paste would land on the end of it " +
                "and Enter would submit both - on a shell, execute both). A predicate that cannot answer is not " +
                "a predicate that answered \"safe\". " +
                'Drive this pane deliberately instead: agent_send(name: ' +
                `${JSON.stringify(agent.name)}, keys: [...]) is unguarded for exactly this reason, and reaches ` +
                "an arbitrary TUI a text turn cannot. Read it first with agent_output.",
              tail: capturePaneQuietly(agent.tmux_target),
            };
          }

          if (paneInCopyMode(target) === true) {
            return {
              agent_id: agent.id,
              name: agent.name,
              sent: false,
              note:
                "The pane is in tmux copy mode, so text was NOT sent: tmux clears a pane's bracketed-paste " +
                "flag there, so the paste would arrive with no markers - anything past one 1022-byte write " +
                "loses its head - and the Enter after it is eaten by the mode rather than submitting. Both " +
                "failures are silent: tmux reports success for each call. Someone is reading or scrolling " +
                "this pane. Leave copy mode (press q or Escape there, or " +
                `agent_send(name: ${JSON.stringify(agent.name)}, keys: ["-X", "cancel"]) to cancel it ` +
                "deliberately), then retry - this refusal is retriable and nothing was lost.",
              tail: capturePaneQuietly(agent.tmux_target),
            };
          }

          const sendClassifier = harnessFor(agent.command).paneClassifier!;
          const submitting = args.submit !== false;
          const { awaitingChoice, tail } = sendClassifier.choiceCheck(target);
          // Unreadable refuses only when an Enter follows: with submit=false there is no keypress
          // for a dialog to eat, the same reasoning that exempts submit=false from the box check.
          if (awaitingChoice === true || (submitting && awaitingChoice === null)) {
            return {
              agent_id: agent.id,
              name: agent.name,
              sent: false,
              note:
                awaitingChoice === true
                  ? "The pane is waiting on a choice (e.g. a permission or trust prompt), so text was NOT sent: typing here would answer the prompt instead of reaching the worker. Use keys to answer or dismiss it deliberately (e.g. [\"Escape\"], or the option's number plus Enter), then retry."
                  : "The pane could not be read, so text was NOT sent: hive cannot tell whether a dialog is on " +
                    "screen, and typing into one answers it instead of reaching the worker. This is usually a " +
                    "tmux call that timed out (the server may be wedged or heavily loaded) rather than anything " +
                    "about the target. Retry; if it persists, check the pane with agent_output and run hive doctor.",
              tail,
            };
          }

          if (submitting) {
            const box = sendClassifier.inputBoxState(target);
            if (holdsHumanInput(box)) {
              return {
                agent_id: agent.id,
                name: agent.name,
                sent: false,

                note:
                  "The pane's input box holds unsubmitted text, so text was NOT sent: it would be pasted onto the end of that text and Enter would submit both as one message. Someone is mid-sentence at this terminal, or an earlier agent_send used submit=false and has not been submitted yet. " +
                  (agent.kind === LEAD_KIND && !isRunningLeadActor(currentActor())
                    ? "That target is a LEAD session, so agent_send's keys path is refused against it from a non-lead caller: you cannot clear or submit that line yourself. A human at that terminal, or another lead, has to. Leave it and try again later."
                    : "Read the pane with agent_output first. If the text is your own composition, submit it with agent_send(keys: [\"Enter\"]). If it is a human's, leave it alone, or clear the line with agent_send(keys: [\"C-a\", \"C-k\"]) once you can attribute it, then retry."),
                tail,
                input_box: box,
              };
            }
          }

          if (
            agent.kind === LEAD_KIND &&
            !isRunningLeadActor(currentActor()) &&
            args.text.length > LEAD_MESSAGE_THRESHOLD
          ) {
            // Stored BEFORE the paste, deliberately: storing after a successful paste lets a pointer
            // reach the pane naming a row that does not exist yet, which is worse than the orphan row a
            // failed paste leaves behind.
            const { id, fromName } = storeLeadMessage(project.id, currentActor(), agent.id, args.text);
            const pointer = renderLeadPointer(id, fromName, args.text);
            shortened = {
              message_id: id,
              note: shortenedSendNote(id, pointer.length),
              marker: leadPointerMarker(id, fromName, args.text),
            };
            outgoing = pointer;
          }

          let pasted = false;
          let buffered = false;
          try {
            await sendText(
              target,
              outgoing,
              submitting,
              () => {
                pasted = true;
              },
              () => {
                buffered = true;
              },
            );
          } catch (err) {
            const shortenedClause =
              shortened === null ? "" : shortenedSendFailureClause(shortened.marker, shortened.message_id);
            if (!pasted) {

              if (buffered && err instanceof TmuxTimeoutError) {
                throw new Error(
                  `[agent_send:paste-timeout-ambiguous] agent_send's paste call to ${agent.name}'s pane timed out. A timed-out tmux call does not prove nothing happened - the server can finish a command after the client gives up waiting on it - so the text MAY already be on that screen, unsubmitted. Do not resend blindly: read the pane first with agent_output(name: ${JSON.stringify(agent.name)}), and only send again if the text genuinely is not there.${shortenedClause}`,
                  { cause: err },
                );
              }
              throw err;
            }

            const canFinishItself = !(agent.kind === LEAD_KIND && !isRunningLeadActor(currentActor()));
            throw new Error(
              `[agent_send:paste-landed-enter-failed] agent_send's Enter failed after the paste to ${agent.name}'s pane already succeeded: that text was on the target's screen, unsubmitted, the moment the paste returned - it was pasted, not lost, though a concurrent send could have changed the screen since. Do NOT resend it: retrying pastes a second copy onto the end of the first, and the Enter that follows submits both as one message (on a non-claude pane, that merged line EXECUTES). ` +
                (canFinishItself
                  ? `Finish this exact delivery instead: agent_send(name: ${JSON.stringify(agent.name)}, keys: ["Enter"]).`
                  : `That target is a LEAD session, so agent_send's keys path is refused against it from a non-lead caller: you cannot finish this yourself. A human at that terminal, or another lead, has to press Enter there. Leave it and try again later.${shortened === null ? "" : " Pressing Enter there is the INTENDED finish, not a stray paste: that stranded line is hive's own pointer, and submitting it is exactly what this send was supposed to do."}`) +
                shortenedClause,
              { cause: err },
            );
          }
        } else {
          throw new Error("Pass text or keys.");
        }

        if (args.wait_ms != null) {
          await sleep(Math.min(Math.max(args.wait_ms, 250), 10000));

          let tailField: { tail: string } | { note: string };
          try {
            tailField = { tail: capturePane(target, 15) };
          } catch {
            tailField = {
              note: "Sent, but the terminal tail could not be read afterward (the pane may have died during the wait). Check agent_status or agent_output to confirm the worker is still there.",
            };
          }
          return withShortened({
            agent_id: agent.id,
            name: agent.name,
            sent: true,
            ...tailField,

            ...inputBoxField(agent.command, target),
          });
        }

        return withShortened({ agent_id: agent.id, name: agent.name, sent: true });
      }),
  );

  server.registerTool(
    "agent_message_get",
    {
      description:
        "Read one agent-to-lead message in full, by the id in a \"[hive message #N ...]\" pointer line. hive stores a message here only when it shortens one: text over 300 characters sent to a lead by someone who is not that lead. Every other send is typed verbatim and stores nothing, so there is no id to read. Messages are pruned after 7 days, and a lookup for a pruned id says so rather than reporting it missing.",
      inputSchema: {
        message_id: idParam,
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const row = readLeadMessage(project.id, args.message_id);
        if (row === undefined) {
          throw new Error(missMessage(args.message_id, classifyMiss(args.message_id)));
        }
        return {
          message_id: row.id,
          from: row.from_name,
          from_actor: row.from_actor,
          to_agent_id: row.to_agent_id,
          chars: row.text.length,
          created_at: row.created_at,
          text: row.text,
        };
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

        lines: z.number().int().min(1).max(200).optional(),
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
          ...(alive ? inputBoxField(agent.command, agent.tmux_target) : {}),
          ...(alive === true
            ? {}
            : {
                note:
                  alive === null
                    ? PROBE_FAILED_NOTE
                    : "No live tmux window; output is not retained after exit.",
              }),
          ...(alive !== true && agent.exit_tail ? { exit_tail: agent.exit_tail } : {}),
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
      outputSchema: {
        agent_id: idParam,
        name: z.string(),
        closed: z.boolean(),
        park_released: z.boolean().optional(),
        parked: z.boolean().optional(),
        note: z.string().optional(),
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const agent = findAgent(project.id, args);

        if (agent.kind === LEAD_KIND && currentActor().startsWith("agent:")) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session. Retiring a lead - live, ` +
              "confirmed dead, or unprobed - is reserved for a human at a terminal or a peer lead; a " +
              "worker this project spawned may not close it.",
          );
        }

        if (agent.status === "closed" && agent.parked_at) {

          const released = db.transaction(() => {
            if (!releaseParkRow(agent.id)) return false;
            markGoneReported(agent.id, project.id);
            return true;
          })();
          if (!released) {
            throw new Error(
              `Agent ${agent.id} ("${agent.name}")'s row changed since this call probed it - most likely a ` +
                "concurrent agent_resume. Nothing was released and nothing was closed. Re-read it with " +
                "agent_status and try again.",
            );
          }

          // Best-effort: a failed reap must not fail the close it rides on. The janitor's own
          // backstop sweep retries it (codex_home stays set until reapCodexHome actually succeeds).
          if (agent.codex_home) {
            try {
              reapCodexHomeForClosedAgent(agent.id, agent.codex_home);
            } catch {

            }
          }

          return { agent_id: agent.id, name: agent.name, closed: true, park_released: true };
        }

        const live = isLive(agent);
        if (live === null) throw probeFailed(agent);

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
        // A hive.yml process gets the graceful leg and the stopping marker, exactly as `hive stop`
        // does: kill-pane alone is SIGHUP, and a kill without the marker can be reported as a crash.
        const commandRow = agent.kind === COMMAND_KIND ? runningCommandRow(project.id, agent.name) : undefined;
        if (commandRow && live) {
          const stopped = stopProcess(commandRow, STOP_REASONS.byHand);
          return {
            agent_id: agent.id,
            name: agent.name,
            closed: stopped.leg !== "still-running",
            stop_leg: stopped.leg,
            note: stopLine(stopped),
          };
        }
        if (live) killAgentPane(agent.tmux_target);

        if (!closeAgentRow(agent.id, agent.tmux_target)) {

          const after = getAgentRow(project.id, agent.id, "Call agent_list(include_closed: true).");
          const report = classifyLostCas(after);
          if (report.outcome === "retired") {

            const probedTmux = agent.status === "running";
            return {
              agent_id: agent.id,
              name: agent.name,
              closed: true,
              ...(report.parked ? { parked: true } : {}),
              note: report.parked
                ? `Already retired as a park by a concurrent agent_park before this call's own close landed` +
                  (live ? " (this call's kill-pane already took the pane down)." : ".")
                : live
                  ? "Already closed by someone else before this call's own close landed - most likely the " +
                    "janitor (or a peer closer), reaping the pane this call's own kill left dead. End state is " +
                    "the same as a successful close."
                  : probedTmux
                    ? "Already closed by someone else before this call's own close landed. This call's own " +
                      "probe already found the pane dead, so nothing was left running either way. End state is " +
                      "the same as a successful close."
                    : "Already closed by someone else before this call ever probed it, so this call never " +
                      "checked the pane - it may still be running. Re-read it with agent_status if that matters.",
            };
          }
          throw revivedError(
            agent,
            live,
            "a concurrent `hive lead` restart or agent_resume recording a fresh pane on it",
            "Nothing further was closed. Re-read it with agent_status and decide what you want.",
          );
        }
        // Best-effort, same as the park-release branch above: a failed reap must not fail the close,
        // and the janitor's backstop sweep retries it.
        if (agent.codex_home) {
          try {
            reapCodexHomeForClosedAgent(agent.id, agent.codex_home);
          } catch {

          }
        }

        return { agent_id: agent.id, name: agent.name, closed: true };
      }),
  );
}
