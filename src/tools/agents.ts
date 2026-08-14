import { existsSync, statSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  agentBriefPath,
  isClaudeCommand,
  readAgentBrief,
  workerBrief,
  workerCommandString,
  writeAgentBrief,
} from "../brief.js";
import { currentActor, findProjectForDir, getProject, resolveProject } from "../context.js";
import { ensureHooksFile } from "../hooks.js";
import { activeProfile, loadProjectYml } from "../projectYml.js";
import { run } from "../result.js";
import { markGoneReported } from "../scheduler.js";
import {
  branchAt,
  closeAgentRow,
  isReservedAgentName,
  isRunningLeadActor,
  launchAgent,
  LEAD_KIND,
  parkAgentRow,
  releaseParkRow,
  renameAgent,
  resumeAgent,
} from "../spawn.js";
import { resolveTranscriptDir } from "../transcript.js";
import {
  applyLayout,
  capturePane,
  DEFAULT_LAYOUT,
  describePaneChoice,
  ensureAttached,
  findUnsafeControlChar,
  holdsHumanInput,
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
  TEXT_ALLOWED_CONTROL_CHARS,
  tmux,
  waitForPaneInput,
  WINDOW_LAYOUTS,
  windowLayout,
  windowOwner,
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
  session_id: string;
  parked_at: string;
  parked_branch: string;
  resumed_at: string;
}

// One ordering rule, one string, shared by closedAgentNamed here and
// findClosedAgent below - both scan a project's non-running rows for a name
// match, and until todo 364 their ORDER BY clauses were independent, hand-
// copied literals that happened to agree. Todo 364 added parked-first
// priority to findClosedAgent alone; leaving closedAgentNamed's copy
// unchanged would have silently broken the "kept consistent anyway" promise
// closedAgentNamed's own comment below already makes. PARKED FIRST
// ((parked_at != '') reads as 1/0 in SQLite, DESC puts 1 first), then
// most-recently-closed within each group - closed_at, not id, because
// agent_resume can reopen and reclose a row out of id order.
const CLOSED_ROW_ORDER = "(parked_at != '') DESC, closed_at DESC, id DESC";

// The most recently closed agent whose name matches, folded the same way the
// running passes fold. Only reached when no running agent answered, so the
// scan over a project's dead agents stays off the hot path.
//
// This function only feeds an error message naming which closed agent to
// spawn a replacement for, so getting it wrong is cosmetic here, not a
// resume gone to the wrong session - CLOSED_ROW_ORDER is shared anyway so
// the same query does not read two different ways in one file.
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

// Shared by findAgent and findClosedAgent's own agent_id branch below - one
// row-by-id lookup and one not-found sentence, parameterized on the hint
// each caller wants ("Call agent_list." vs "...(include_closed: true)."),
// rather than the identical SELECT and not-found shape written out twice.
function getAgentRow(projectId: number, id: number, notFoundHint: string): AgentRow {
  const row = db.prepare("SELECT * FROM agents WHERE project_id = ? AND id = ?").get(projectId, id) as
    | AgentRow
    | undefined;
  if (!row) throw new Error(`No agent ${id} in project ${projectId}. ${notFoundHint}`);
  return row;
}

// Todo 369. agent_close and agent_park both kill a pane and then take a
// conditional write (closeAgentRow / parkAgentRow) on id + status='running' +
// tmux_target - the same CAS shape, same failure mode. When the CAS loses,
// the row itself already says what actually happened; re-reading it turns a
// guess ("nothing was closed/parked", blaming a fixed cause) into a fact.
// Exactly two things can be true of a row a lost CAS did not write:
// something else already retired it (closed, or closed+parked - the caller's
// real question, and the ONLY case where "nothing changed" is honest), or it
// is running again on a fresh pane (a genuine loss - the only case that
// deserves a refusal). No third status exists (schema CHECK, src/db.ts).
//
// Pure and exported so this is testable by construction: the real race
// this reports on cannot be triggered through the live MCP surface any more
// than closeAgentRow's own CAS can (see test/close-agent-row-target-guard.
// test.mjs's own comment on why), so the outcome this computes is pinned
// directly against a synthetic row rather than a live tmux race.
export type LostCasReport = { outcome: "retired"; parked: boolean } | { outcome: "revived" };

export function classifyLostCas(row: Pick<AgentRow, "status" | "parked_at">): LostCasReport {
  return row.status !== "running" ? { outcome: "retired", parked: !!row.parked_at } : { outcome: "revived" };
}

// The "revived" half of a lost-CAS report, shared by agent_close and
// agent_park (/simplify, todo 364): both name the plausible cause and the
// verb-specific remedy, so only those two fragments vary by caller.
//
// "is running again", not "...on a different pane" (counselors, opus, same
// fix round as classifyLostCas's own retired-branch fix above): this
// classification only knows status='running' again, not that a pane is
// already attached to it. resumeAgent's own flip (src/spawn.ts) commits
// status='running' with tmux_target='' for the span of the resume, so a
// re-read landing in that gap would have asserted a pane that does not yet
// exist. Dropping the clause makes the sentence true in both cases instead
// of only the common one.
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
      // A PARKED LANE IS NOT A CLOSED ONE, AND THIS IS THE MESSAGE A
      // NEXT-MORNING LEAD HITS FIRST (counselors, opus + fable). `agent_send(
      // name: "impl")` or `agent_status(name: "impl")` at 09:00 used to answer
      // "is closed. Spawn a new worker" for the lane the lead deliberately
      // parked at 18:00 - verbatim the confusion issue #156 was filed about,
      // produced by the feature meant to end it. The branch already had the
      // shape for a third remedy; it only lacked the fact.
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

// agent_resume's own resolver: findAgent above only ever returns a RUNNING
// row (the "closed" case is a helpful error, not a result), and that is the
// wrong default for a tool whose whole job is to act on a closed one.
// Exact, case-insensitive match only, no partial fallback - unlike
// findAgent, closed rows are not a namespace anything else has to
// disambiguate against, so a caller who does not remember the exact name
// gets pointed at agent_list rather than a guess.
//
// Todo 364, CLOSED_ROW_ORDER's own mechanics comment above. closed_at, NOT
// id, is what breaks a tie within a priority group (counselors, codex): a
// resumed row keeps its id but gets a FRESH closed_at if it is closed
// again, so id order and close order can disagree the moment agent_resume
// exists - id 10 resumed and reclosed after id 11 first closed is more
// recently closed despite the lower id. A name is only unique among RUNNING
// rows (idx_agents_running_name), so "impl" spawned, closed, and spawned
// again leaves two closed rows sharing it - and PARKING one of them does
// not free the name (a parked row is still status='closed'), so "impl"
// parked at 18:00 then spawned and ORDINARILY closed at 09:00 used to have
// closed_at alone pick the 09:00 row: `agent_resume(name: "impl")` silently
// resumed the wrong lane, with no error to notice by. Lead triage on todo
// 364: a parked lane is a promise this project already makes legible
// (agent_park's whole point), and closed_at ordering it alongside an
// ordinary close breaks that promise the moment the two ever collide on a
// name.
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

// The core liveness rule of the agent model: a row is live only while it is
// open in the store AND its tmux target still exists. Returns null when tmux
// could not be asked, which every caller must handle as its own case: reading
// unknown as dead is what closed live workers (issue #14).
// End an agent's pane and leave the survivors arranged the way hive placed
// them. Shared by agent_close and agent_park (issue #156): the two differ in
// what they write to the ROW, and not at all in how they take the pane down,
// so a second copy of this would be two places for the re-tile reasoning below
// to drift apart. Called only where the caller has already probed the target
// as live - unknown liveness must never be treated as dead (issue #14), and
// that decision stays with the caller because agent_close's own lead-retirement
// path turns on it.
// TODO 371 CHANGED WHICH BRANCH A WINDOW-PLACED WORKER TAKES, AND THAT IS A
// BEHAVIOUR CHANGE, NOT A CONSEQUENCE OF STORING A DIFFERENT ID. Every row now
// records a pane id (placeAgentPane, src/spawn.ts), so a placement="window"
// worker reaches kill-pane where it used to reach kill-window. For the
// ordinary case - that worker alone in its own window - the outcome is
// identical, since tmux reaps a window whose last pane dies. It differs in
// exactly one case, and there the new behaviour is the point rather than the
// price: a window-placed worker's window can hold a second pane, because
// splitTargetWindow places a split-placed CHILD into its parent's window
// (test/split-window-parent-placement.test.mjs pins that), and kill-window
// took that child's pane down too. Closing one worker silently killed
// another. It no longer does.
//
// THE WINDOW BRANCH STAYS, AND IT IS NOT DEAD CODE. A row can still hold a
// window id: an MCP server started before this change keeps running the old
// code against the shared store for the life of its session (see
// .claude/sessions/common-issues/stale-mcp-server-runs-old-code.md), so a
// window-target row can be written into a store whose other sessions are
// already on the new build. Deleting the branch would make agent_close kill
// nothing at all for those rows - kill-pane against a window id fails - and
// the wrong outcome would be a leaked live process rather than a loud error.
//
// WHAT THAT BRANCH STILL COSTS, ACCEPTED AND RECORDED RATHER THAN FIXED
// (counselors, codex seat). A legacy window-target row whose window has since
// gained a split CHILD takes the child's pane down with it, which is exactly
// the collateral kill the pane id removes. The seat's proposed fix - refuse
// loudly on a multi-pane legacy window and tell the human to restart the stale
// server - was weighed and rejected: it turns agent_close into a failure for
// rows a human cannot repair from inside hive (nothing repoints tmux_target),
// and it would be a NEW refusal on a path that has always killed. This is not
// a regression either: it is main's behaviour for EVERY window-placed worker,
// narrowed to the rows a pre-change server writes.
//
// "A POPULATION THAT CAN ONLY SHRINK" WAS THE FIRST WORDING AND IT WAS WRONG
// (counselors round 2, two seats). An old MCP server keeps running old code
// for the LIFE OF ITS SESSION, so it can spawn NEW window-placed workers after
// this ships, and their panes outlive that server because they belong to the
// long-lived shared tmux session. The population is bounded by how long any
// pre-change session stays open, which is hours, not by this build's own
// write sites. The disposal is unchanged - the trade above does not turn on
// the population shrinking - but the reason had to stop claiming something
// false. Revisit if window-target rows ever become writable by a CURRENT
// build, which would mean this whole change had been reverted.
function killAgentPane(target: string): void {
  const pane = isPaneTarget(target);
  // Resolve the window before the pane dies, then re-tile the survivors:
  // tmux's own redistribution otherwise wipes the arrangement hive applied on
  // spawn.
  const window = pane ? paneWindow(target) : null;
  tmux(pane ? "kill-pane" : "kill-window", "-t", target);
  if (!window) return;
  // Todo 269 / counselors F1 on pad 71. The window's OWNER decides its
  // hive.yml, never the CLOSING row's project: once a cross-project worker can
  // share a window with a lead it did not spawn from (todo 268), re-tiling
  // through the closing row's own project lets a foreign repo arrange a window
  // it does not own. windowLayout(window) is consulted FIRST and already reads
  // @hive-layout off the window itself, so this only narrows the FALLBACK,
  // which fires when the window carries no @hive-layout yet. A window with no
  // @hive-project-id stamp (a user-created window, or a placement="window"
  // worker's own - both deliberately unstamped, test/worker-first-window-
  // stamp.test.mjs) has no owner to resolve a layout through either, so
  // DEFAULT_LAYOUT is the honest answer there too - never the closing row's
  // project, which is the defect.
  // SIBLING CALL SITE: agent_spawn's landed_in_project receipt resolves the
  // same windowOwner -> getProject pair and handles a stamp naming a DEAD
  // project row the other way, with a synthesized "project <id>" placeholder.
  // Deliberate, and its own comment carries the argument. Absent is the honest
  // answer HERE because the value feeds a layout: a hive.yml read from a
  // project that no longer exists cannot be produced at all, so there is
  // nothing to fall back to but DEFAULT_LAYOUT.
  const ownerId = windowOwner(window);
  const ownerProject = ownerId != null ? getProject(ownerId) : undefined;
  applyLayout(
    window,
    windowLayout(window) ?? (ownerProject ? loadProjectYml(ownerProject.path).config?.layout : undefined) ?? DEFAULT_LAYOUT,
  );
}

// Issue #156, D2. THE LANE'S TODOS, DERIVED RATHER THAN RECORDED, and the
// reasoning is the whole of D2's second half (todo 353 comment 819).
//
// The issue asks park to record "the lane's todo and pad ids". A parameter for
// them - in a column, in a blob, or in the board line - reintroduces the exact
// failure the issue was filed about: something the lead has to remember at
// 18:00 on a Friday, whose omission is indistinguishable from a lane that
// genuinely has no todo. `todo_comments.author` is already the row's own
// actor_id, written as a side effect of the worker recording its decisions the
// way the runbook requires, so the link exists without anyone deciding to make
// it. Lane A's D2 (resume reuses the row AND the actor_id) is what keeps it
// stable across park/resume cycles; a design that minted a new actor_id per
// resume would break this on the first one.
//
// IT IS AN INFERENCE AND THE RECEIPT SHOULD NOT PRETEND OTHERWISE. A worker
// that never commented yields nothing; one that commented on a neighbouring
// lane's todo yields a spare id. Both fail toward "a missing or extra number
// on a board line", never toward a lost lane, which is the direction a column
// the lead forgot to fill fails in too - with none of the recall this has.
//
// Scoped to the PROJECT as well as the author: an actor that commented on
// another project's todo (the deliberate cross-project write
// .claude/rules/project-scoping.md describes) is not this lane's work.
// Archived todos are excluded for `hive status`'s own stated reason - a
// board line naming a lane's archived scaffolding is noise at cold boot.
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

// THE BOARD LINE, BUILT BY THE TOOL RATHER THAN REMEMBERED BY THE LEAD - the
// half of issue #156 Chris actually asked for ("asking the lead to save to the
// board that we should resume these X sessions tomorrow").
//
// IT IS RETURNED, NOT WRITTEN, and that is a decision rather than a shortcut.
// Chris's own sentence describes the lead putting it on the board; what the
// issue calls the failure is the lead having to COMPOSE it from memory, and
// generating the text removes exactly that. Having this tool append to the
// "board" pad itself would add a write to another resource - into free-form
// content whose structure this tool cannot know, at a position it cannot
// choose, in the one area of this store that has had a destructive incident
// (src/db.ts's todo 331 migration). The row is the system of record here (D2),
// `hive status` reports parked lanes from it, and agent_list surfaces them, so
// the board is a convenience rather than the thing park depends on. If that
// turns out to be the wrong call it is one pad_append to reverse, which is why
// it is worth starting on the cautious side.
//
// Wrapped to fit 80 columns because it is pasted into a pad that is read raw
// in a terminal, matching the runbook's own wrapping rule for that content.
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

// The full agent_park receipt, shared by the ordinary success path and the
// "someone else already parked it first" branch of the lost-CAS report
// below: both describe a row that IS parked, one because this call parked
// it and one because a concurrent agent_park won the race, and a caller
// reading the receipt needs the same facts either way. `note` is the one
// field that tells them apart.
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
// The one query requireNameFree and agent_resume's own collision message
// both need: which RUNNING row, if any, already holds this name. Split out
// (todo 364, /simplify altitude pass) because requireNameFree's OWN refusal
// ("Pick another name") is impossible advice for a resume - the whole
// reported bug ("Park 'impl', spawn a fresh 'impl', try to resume the
// parked one: told to pick another name, but resume does not take one") -
// so a caller-specific message for one caller out of three does not belong
// growing requireNameFree's own signature. Pure and throwless on purpose:
// the two callers below decide what a collision MEANS for them.
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
  // Issue #27's L4 fix round, DECISION 7c. "lead" is reserved, not merely
  // usually taken: ensureLeadRow (src/cli.ts) inserts the lead's own row
  // directly, never through this door, so a worker could take the name the
  // moment no lead row is running (a fresh clone, or between a lead session
  // ending and the next `hive lead`). The next `hive lead` would then INSERT,
  // hit SQLITE_CONSTRAINT_UNIQUE on idx_agents_running_name, and throw out of
  // ensureLeadRow BEFORE ensureSession or attach - the lead does not start,
  // and nothing about that failure names a worker as the cause.
  //
  // Not re-checked at agent_resume's own call site below: a kind='agent' row
  // can never legitimately be named "lead" (this check already refused it at
  // spawn and at rename, its only two doors), and agent_resume refuses any
  // kind='lead' target before it ever reaches a name check at all - so this
  // branch is unreachable from resume by construction, not merely untested.
  if (isReservedAgentName(needle)) {
    throw new Error(`"${name}" is reserved for this project's lead session and cannot be used as a worker name.`);
  }
  const taken = runningAgentNamed(projectId, name, exceptAgentId);
  if (taken) {
    throw new Error(`A running agent named "${taken.name}" already exists. Pick another name.`);
  }
}

// Counselors (fable): agent_spawn's auto-generated --session-id used to be
// injected unconditionally for a claude command, on the reasoning that a
// duplicated flag gets claude's own last-flag-wins behaviour. That reasoning
// does not reach this case: --session-id and --resume/--fork-session are
// DIFFERENT flags, not two copies of the same one, so there is no
// duplicate for claude's parser to resolve between - what actually happens
// with both present is unverified. The pre-#154 manual resume workflow
// (.claude/sessions/workflows/resume-a-closed-worker.md) is exactly
// `agent_spawn(command: "claude", extra_args: ["--resume", "<id>"])`, still
// documented and still callable, so this has to keep working rather than
// silently gain a second, conflicting flag.
function requestsExistingSession(extraArgs: string[] | undefined): boolean {
  return (extraArgs ?? []).some(
    (arg) =>
      arg === "--resume" ||
      arg.startsWith("--resume=") ||
      arg === "--fork-session" ||
      (arg.startsWith("-r") && !arg.startsWith("--")),
  );
}

// A name is not just a label: it gets typed into a terminal, as the pane
// announcement at spawn and as /rename on a live worker. `tmux send-keys -l`
// stops tmux interpreting key NAMES, but it passes a raw control byte
// straight through to the TUI, so a name carrying 0x03 sends Ctrl-C into a
// worker mid-task. Verified directly against tmux rather than reasoned about:
// send-keys -l -- with a literal 0x03 interrupts a running foreground
// process. Both doors validate, because both doors type.
//
// findUnsafeControlChar is the same detector issue #150's wake/agent_send
// text guard uses (src/tmux.ts); a name passes no exceptions, unlike that
// guard's tab/newline allowance, because a name has no legitimate newline.
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

// How long agent_spawn waits for claude's prompt box before returning. A cold
// claude loading plugins and MCP servers routinely needs more than ten
// seconds, and an observed 8s default missed the prompt box outright.
// Waiting costs one tmux fork per 500ms, so the ceiling is generous on
// purpose: a slow start should delay the return, not silently lose whatever
// the caller does next.
//
// THIS WAIT OUTLIVES THE ANNOUNCEMENT IT WAS ADDED FOR (todo 387 fix round
// 1, finding 1). Todo 387 stopped typing anything into a fresh pane, and the
// first version of that change removed this wait along with the typing it
// used to gate - reasoning that with nothing left to type, there was nothing
// left to wait for. That reasoning missed what the wait actually protects:
// waitForPaneInput's own contract is that sending into a pane that has not
// taken the terminal loses the text silently and reports success
// (src/tmux.ts). Removing the wait did not remove that hazard, it moved it
// onto the NEXT thing to type into this pane - which is now the lead's own
// agent_send, landing straight after agent_spawn returns for exactly the
// dispatch shape todo 384 measured (spawn and send in the same tool block).
// Without this wait, that send races a cold claude and can be silently
// swallowed while reporting sent: true - strictly worse than the false-finish
// defect this whole lane exists to fix, and reportUnbriefedWorkers cannot
// catch it either, since resumed_at is no longer stamped at spawn to detect
// against. Keeping the wait closes the window at the one place hive still
// controls it: agent_spawn does not return until the pane can safely be
// typed into, even though agent_spawn itself types nothing.
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
// UPDATE, topology-3c: the second (ENOBUFS) leg is no longer load-bearing on
// its own -- tmux() (src/tmux.ts) now passes TMUX_MAX_BUFFER (16MB) to every
// call, this one included, so the DEFAULT maxBuffer these two captures used
// to risk is not what either one runs under any more. The FIRST leg (the two
// serializers disagreeing on which rows are blank) is untouched and is
// sufficient on its own to keep this split: merging the two captures back
// into one would still silently break the row-blankness property, with
// nothing here to catch it.
//
// Present only when a recognisable input-box line was found: an absent
// field is a plain "nothing to say" (slim receipts), not a claim that the
// box is empty.
function inputBoxField(target: string): { input_box: InputBoxState } | Record<string, never> {
  const box = inputBoxState(target);
  return box ? { input_box: box } : {};
}

// Issue #5 (transcript_dir) and issue #154, D4 (session_id): two facts that
// share one inclusion gate, so they are one field function rather than two.
// isClaudeCommand is the gate both need - codex or aider have neither a
// transcript directory nor a session id, and must not get a confidently
// wrong value for either - and both are called at the identical two sites
// below, so splitting them would only add a duplicated ternary at each call
// site (as it once did) for no discrimination anything actually uses.
// Contrast lastLogEventField/paneField further down, which stay two
// functions because their gates genuinely differ.
//
// transcript_dir: resolution is purely a function of the stored cwd string
// (D7) - recreating a removed worktree at the same path makes `claude
// --resume` work there again, since Claude Code keys its transcript
// directory on cwd alone.
// session_id: '' is "no fact recorded" (the same convention tmux_socket and
// pane_pid already use) and is reported as null here so a caller does not
// have to know that convention to read the field.
//
// Callers decide WHEN to call this, the same way they already decide when
// to call inputBoxField, rather than this function carrying an inclusion
// policy of its own beyond the one isClaudeCommand gate.
function claudeOnlyFields(
  row: AgentRow,
): { transcript_dir: string | null; session_id: string | null } | Record<string, never> {
  return isClaudeCommand(row.command)
    ? { transcript_dir: resolveTranscriptDir(row.cwd), session_id: row.session_id || null }
    : {};
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
// the inferring. Two functions, not one, matching inputBoxField above: each
// field owns exactly one inclusion gate, and the two gates here are
// genuinely different (reportsAgentStateLog vs. liveness) - unlike
// claudeOnlyFields above, whose two facts share one gate and are fused for
// exactly that reason.
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
    // Issue #156. Present only on a row that was actually parked, so a caller
    // reading agent_list(include_closed: true) can tell a paused lane from a
    // finished one - the distinction the issue says a next-morning lead cannot
    // make today, since `closed` currently means both. Absent rather than null
    // for an ordinary close, matching the slim-receipt convention every
    // conditional field on this summary already uses: '' is "no fact
    // recorded", and a reader should not need to know that to read this.
    ...(row.parked_at ? { parked_at: row.parked_at, parked_branch: row.parked_branch || null } : {}),
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
        "Spawn a worker agent in a tmux window (default command: claude). A claude worker is briefed automatically: the full brief is appended to its system prompt and a short [hive] line is typed into its pane as the visible first turn, so send it its assignment directly. Other commands return `instructions` to PREPEND to your first agent_send. The worker is locked to this project. Humans can watch with: tmux attach -t hive-main.",
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
        // Issue #154, D1. Generated here rather than left to the hook to
        // discover, so the id is known at spawn time and correct even for a
        // worker that dies before its first hook fires - src/hook.ts
        // reconciles from the payload afterward, which is what makes this
        // flag non-load-bearing rather than redundant (see its own comment,
        // and the migration in src/db.ts). '' for a non-claude command (D4's
        // gate, since codex or aider have no such id) and for a caller
        // already requesting --resume/--fork-session in extra_args (see
        // requestsExistingSession's own comment).
        const sessionId = isClaude && !requestsExistingSession(args.extra_args) ? randomUUID() : "";
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
            // --session-id first when generated, caller-supplied extra_args
            // after: sessionId is already '' (skipped) for a caller
            // requesting --resume/--fork-session, so this never doubles up
            // on those flags - see requestsExistingSession's own comment for
            // why that pair cannot rely on claude's last-flag-wins behaviour
            // the way an actually-duplicated flag (e.g. two --session-id)
            // could.
            extraArgs: isClaude
              ? [...(sessionId ? ["--session-id", sessionId] : []), ...(args.extra_args ?? [])]
              : args.extra_args,
            settingsPath: isClaude ? ensureHooksFile() : undefined,
            briefPath,
          });
        };
        const placement =
          args.placement ??
          projectConfig?.placement ??
          (process.env.HIVE_SPAWN_PLACEMENT === "window" ? "window" : "split");
        const layout = args.layout ?? projectConfig?.layout ?? DEFAULT_LAYOUT;

        const { agentId, actorId, target, landedInProjectId } = launchAgent({
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
          sessionId,
        });
        ensureAttached(sessionName());

        // NOTHING IS TYPED INTO THE PANE (todo 387, option (e)). This used to
        // type a `[hive]` line and submit it, which created a real turn hive
        // asked for itself - and everything downstream was machinery for
        // managing that turn: the spawn half of agents.resumed_at,
        // SPAWN_ANNOUNCEMENT_PREFIX, isSpawnAnnouncement, and a busy pane
        // absorbing an assignment into that turn with no UserPromptSubmit to
        // clear the latch, silencing the worker for the rest of its life.
        // Every fact that line carried is already in the brief riding the
        // system prompt (--append-system-prompt-file); the one thing it added
        // was an instruction ("wait for your assignment"), which now lives in
        // the brief text itself (src/brief.ts). A human attaching to a fresh
        // pane sees an idle claude with nothing on screen until the lead
        // sends - accepted, not a correctness cost.
        //
        // THE WAIT STAYS, EVEN THOUGH THE TYPING IT ORIGINALLY GATED IS GONE
        // (fix round 1, finding 1). See PANE_READY_MS's own comment for why:
        // this is no longer about protecting agent_spawn's OWN send, it is
        // about not returning until the NEXT send - the lead's own
        // agent_send, which can land in the same tool block as this call -
        // is safe to type into. The dialog check rides along for the same
        // reason it always did: reported information a caller can act on
        // (agent_send keys to clear it) rather than a gate on anything hive
        // itself does here.
        let ready = false;
        let dialogTail: string | undefined;
        if (isClaude) {
          try {
            const paneReady = await waitForPaneInput(target, PANE_READY_MS);
            const { awaitingChoice, tail } = paneChoiceCheck(target);
            if (awaitingChoice === true) {
              dialogTail = tail;
            } else if (paneReady) {
              ready = true;
            }
          } catch {
            // Pane died or tmux refused; the receipt reports it below.
            ready = false;
          }
        }

        return {
          agent_id: agentId,
          actor_id: actorId,
          name,
          tmux_target: target,
          // Todo 268: a caller cannot reconstruct where a pane landed from
          // project_id alone - THE PLACEMENT RULE (pad 71) puts a split
          // worker's pane in its spawning lead's window, which is a
          // different project's window whenever that lead is orchestrating
          // cross-repo work. Slim: omitted whenever the pane landed in this
          // worker's own project's window, which is the ordinary case.
          // SIBLING CALL SITE, and it answers the stale-stamp case
          // DIFFERENTLY on purpose: agent_close's re-tile (further down this
          // file) also resolves windowOwner -> getProject, and when the stamp
          // names a project row that no longer exists it treats the owner as
          // ABSENT and falls to DEFAULT_LAYOUT. Here the same state
          // synthesizes a placeholder name instead. Both are right for their
          // own question - a reader wants to be told SOMETHING about where the
          // pane went, while a layout resolved from a project that no longer
          // exists would be a guess dressed as a fact. Named in both places
          // rather than unified behind one helper (/simplify review, 3b):
          // sharing the lookup would not share the policy, and the policy is
          // the part that differs. The state itself is near-unreachable -
          // project_prune refuses a project that still owns rows, and a
          // stamped window's project owns at least the agents row of whatever
          // is running in it.
          ...(landedInProjectId != null
            ? { landed_in_project: getProject(landedInProjectId)?.name ?? `project ${landedInProjectId}` }
            : {}),
          // The lead has no other channel to learn its hive.yml is malformed:
          // loadProjectYml already fell back to a default, so the spawn looks
          // clean. Reported, never fatal, and omitted when there is nothing to
          // say (slim receipts).
          ...(configWarnings.length > 0 ? { config_warnings: configWarnings } : {}),
          ...(isClaude
            ? {
                brief_path: agentBriefPath(agentId),
                // Renamed from the pre-todo-387 `announced` (fix round 1,
                // finding 2/3): this reports whether the pane took the
                // terminal cleanly, not whether hive typed anything into it -
                // nothing does anymore. `false` here is exactly the signal
                // callers (scripts/part-c-gate.mjs, a lead deciding whether
                // to send yet) need before their own first send: the pane may
                // still be mid-boot or sitting on a dialog agent_send would
                // refuse or silently lose text against.
                ready,
                ...(ready
                  ? {}
                  : dialogTail !== undefined
                    ? {
                        note: "The pane is waiting on a choice (e.g. a folder-trust or permission prompt). Clear it with agent_send keys, then send the worker its assignment.",
                        tail: dialogTail,
                      }
                    : {
                        note: "The pane never became ready. The system-prompt brief is loaded regardless; check agent_output before sending the worker its assignment - typing into it now risks losing the text silently.",
                      }),
              }
            : {
                instructions: workerBrief(briefFor(actorId)),
              }),
        };
      }),
  );

  server.registerTool(
    "agent_resume",
    {
      description:
        "Resume a CLOSED claude worker from its recorded Claude Code session id (claude --resume): a fresh pane, the same actor_id, and the worker's full prior context. Addressed by name or agent_id among closed agents (agent_list(include_closed: true)). Send it its next instruction with agent_send once resumed - this tool does not.",
      inputSchema: {
        name: agentNameParam,
        agent_id: agentIdParam,
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(async () => {
        const project = resolveProject(args.project_id);
        const agent = findClosedAgent(project.id, args);
        // agent_resume is for workers; a lead's restart path is `hive lead`
        // (ensureLeadRow, src/cli.ts), which already reuses its row and
        // actor_id the same way D2 has this tool do for a worker - a second,
        // unrelated mechanism for the identical row, not a gap.
        if (agent.kind === LEAD_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session. agent_resume is for workers; ` +
              "start a lead session with `hive lead`.",
          );
        }
        if (!isClaudeCommand(agent.command)) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") was not a claude worker (command: "${agent.command}"), so it ` +
              "has no session id to resume from.",
          );
        }
        if (!agent.session_id) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") has no recorded session id, so it cannot be resumed. It may ` +
              "predate this feature, or it may have closed before its first hook event ever fired. Spawn a new " +
              "worker instead.",
          );
        }
        // ISSUE #156: A REMOVED WORKTREE, REFUSED HERE WITH THE ONE FACT THAT
        // REBUILDS IT, rather than surfacing as tmux's own failure or, worse,
        // as an ENOENT naming a binary. Node reports a spawn whose cwd is gone
        // as ENOENT against the EXECUTABLE, not against the directory
        // (.claude/sessions/common-issues/enoent-names-the-binary-when-the-
        // cwd-is-gone.md, measured 2026-08-11), which sends the reader after
        // PATH, the interpreter pin and the dispatcher - three dead ends this
        // project has a real, similar-looking failure class in.
        //
        // The remedy is reachable precisely because park recorded the branch
        // (D2): transcript resolution is a pure function of the cwd string
        // (issue #5 D7), so recreating the worktree at the SAME PATH on the
        // SAME BRANCH restores resumability completely. That is the whole
        // return on the parked_branch column, and it is why park records a
        // fact instead of refusing to let anyone remove a worktree.
        //
        // Checked for any closed row, not only a parked one: a resume into a
        // missing directory fails the same way whichever it is. A row with no
        // recorded branch says so rather than inventing one.
        if (!existsSync(agent.cwd)) {
          const recreate = agent.parked_branch
            ? `git worktree add ${agent.cwd} ${agent.parked_branch}`
            : `recreate a checkout at ${agent.cwd} (no branch was recorded for it - agent_park records one)`;
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s working directory is gone: ${agent.cwd}. Its transcript is ` +
              `resolved from that path, so recreate it and the resume works unchanged: ${recreate}`,
          );
        }
        // A BRANCH THAT MOVED IS REPORTED, NOT REFUSED. The session resumes
        // from the cwd string alone, so a different branch under the same path
        // is a working resume into a lane whose code has changed - worth
        // saying out loud on the receipt, and not worth blocking, since
        // resuming a lane onto a rebased or renamed branch is an ordinary
        // reason to resume at all. Silence is the failure mode to avoid here:
        // a resumed worker's own context still describes the branch it was
        // parked on.
        const branchNow = agent.parked_branch ? branchAt(agent.cwd) : "";
        const branchDrift =
          branchNow && branchNow !== agent.parked_branch
            ? { parked_branch: agent.parked_branch, branch_now: branchNow }
            : null;
        // Counselors (opus): idx_agents_running_name's COLLATE NOCASE folds
        // ASCII only, so it alone would let a resumed "café" and a running
        // "CAFÉ" both stay running - the exact pair requireNameFree exists to
        // refuse for a fresh spawn, folded in JS for that reason. The closed
        // row this call resumes was never checked against it (findClosedAgent
        // only excludes RUNNING rows by name, not closed ones), so this is
        // the resume path's own equivalent call, not a redundant one.
        // resumeAgent's own SQL-level catch (src/spawn.ts) is the backstop
        // for the TOCTOU race between this check and its write, the same
        // two-layer shape launchAgent + asNameClash already use.
        //
        // Todo 364. runningAgentNamed, not requireNameFree: this call's own
        // message, not the generic "Pick another name" - see
        // runningAgentNamed's own comment for why that split exists.
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

        // No brief file and no pane announcement here, unlike agent_spawn:
        // the resumed session already carries its original brief and its
        // prior conversation in its own transcript, and typing an
        // assignment into the pane is lane B's job (issues #154/#156's plan
        // pad), not this tool's - it hands back a live pane and lets the
        // caller send the next instruction with agent_send.
        //
        // Counselors (all three seats): this used to hardcode command:
        // "claude", discarding the original binary path a caller may have
        // spawned with (e.g. an absolute path needed because a bare `claude`
        // does not resolve on the pane's PATH - the exact class
        // .claude/rules/tmux-and-panes.md documents for iTerm's own minimal
        // PATH). The binary is recovered from the closed row's own recorded
        // command, the one fact this tool has about how it actually ran.
        // --model and any other extra_args (permission mode, --add-dir, ...)
        // are NOT recovered - hive does not record them separately from the
        // command string they were folded into, and re-parsing arbitrary
        // flags out of that string is its own hazard. This is the same
        // "settings can drift on resume" limitation
        // .claude/sessions/workflows/resume-a-closed-worker.md already
        // documents for the brief; recorded here as a known residual for the
        // same reason, not silently reintroduced.
        //
        // A plain string, not a callback: agent.id and agent.actor_id are
        // already known here, unlike agent_spawn's buildCommand above, whose
        // callback shape exists because launchAgent's ids do not exist until
        // its own INSERT runs.
        const claudeBinary = agent.command.trim().split(/\s+/)[0] || "claude";
        const commandString = workerCommandString({
          command: claudeBinary,
          displayName: agent.name,
          extraArgs: ["--resume", agent.session_id],
          settingsPath: ensureHooksFile(),
        });

        const { target, landedInProjectId } = resumeAgent({
          agentId: agent.id,
          actorId: agent.actor_id,
          name: agent.name,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          cwd: agent.cwd,
          commandString,
          placement,
          layout,
          parentActor: currentActor(),
        });
        ensureAttached(sessionName());

        // ACCEPTED RESIDUAL, todo 365. This receipt can name a session that
        // has already exited by the time the caller reads it: `claude
        // --resume <id>` against a transcript that is gone (pruned past
        // Claude Code's own cleanupPeriodDays, default 30 - measured against
        // the installed binary, not assumed) errors loudly ("No conversation
        // found with session ID: <id>", exit 1) within about a second, and
        // nothing here sets tmux's remain-on-exit, so the pane closes right
        // behind it. Accepted rather than pre-flighted, because the failure
        // is loud and SELF-CORRECTING: isLive/agent_status/agent_list all
        // read the row fresh on their own next probe, and the janitor sweeps
        // it within its normal cadence regardless. A one-second window where
        // a receipt can be stale is a different animal from a row that reads
        // running forever over a dead pane - which is the shape this whole
        // lane exists to refuse. REOPEN TRIGGER: `claude --resume` ceasing
        // to error loudly on a missing transcript (empty session, or a fresh
        // one) would turn this from "corrects itself in a beat" into exactly
        // that shape, and would need a pre-flight transcript check here.
        return {
          agent_id: agent.id,
          actor_id: agent.actor_id,
          name: agent.name,
          tmux_target: target,
          resumed_session_id: agent.session_id,
          // Issue #156: tells a parked resume from an ordinary one on the
          // receipt itself, so a lead resuming a morning's crew can see which
          // of them it actually parked last night and which were merely
          // closed. Absent, not false, when the row was never parked - the
          // same "no fact recorded" convention the column itself uses.
          ...(agent.parked_at ? { was_parked_at: agent.parked_at } : {}),
          ...(branchDrift ? { branch_drift: branchDrift } : {}),
          ...(landedInProjectId != null
            ? { landed_in_project: getProject(landedInProjectId)?.name ?? `project ${landedInProjectId}` }
            : {}),
        };
      }),
  );

  // ISSUE #156. THE RETIRE CELL OF .claude/rules/tool-contract.md's LIFECYCLE
  // MATRIX, which read "n/a, folded into agent_close" for agents until this
  // tool. That rule defines Retire as "soft, reversible, still readable by id
  // afterward" and Remove as "hard, permanent"; park is the first and
  // agent_close is the second, so this is not a new slot invented for it.
  //
  // WHY A TOOL AND NOT A `park` BOOLEAN ON agent_close (the issue names both).
  // Written without naming that parameter in a callable shape on purpose:
  // test/wire-surface.test.mjs reads every tool call in this source and
  // requires its parameters to be real, so a rejected design spelled out as a
  // call reads to that check as a tool this file suggests. A boolean that
  // verb MEANS makes one description answer for two operations, and
  // agent_close's refusals - the live-lead refusal, the worker-caller gate -
  // carry reasoning about ENDING a lane that was never made about pausing one.
  // The naming rule's own escape hatch covers the verb: Retire defaults to
  // `<resource>_archive` and may take a domain verb when retirement does more
  // than flip a row, which killing a live pane is - the same reason
  // `agent_close` overrides Remove.
  server.registerTool(
    "agent_park",
    {
      description:
        "Park a claude worker for the night: kill its pane, mark the row PARKED rather than plain closed, record the branch, and hand back a board line plus the one call that brings it back. Use this instead of agent_close when the lane is paused, not finished - `closed` alone cannot tell a next-morning lead which is which. Resume it with agent_resume.",
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
        // A LEAD IS NEVER PARKED, refused before anything is probed or killed.
        // agent_resume already refuses a lead on the other side (its restart
        // path is `hive lead`, which reuses the row and actor_id by its own
        // mechanism), so a parked lead would be a row nothing could ever
        // un-park - the state this tool exists to make legible would be the
        // one state with no way out of it.
        if (agent.kind === LEAD_KIND) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is this project's lead session, which is not a lane to pause. ` +
              "Leads restart with `hive lead`, which recovers the same row and actor id.",
          );
        }
        // PARK PROMISES RESUMABILITY, SO IT REFUSES WHAT IT CANNOT RESUME.
        // Both conditions below are exactly agent_resume's own, checked here
        // rather than only there, because the cost of learning it tomorrow
        // morning is the whole lane: a row marked parked is a promise the
        // next-morning lead reads off `hive status` and plans around, and
        // discovering at 09:00 that the promise was empty is worse than being
        // told at 18:00 to use agent_close instead. Same facts, twelve hours
        // earlier, when there is still a live pane to do something about.
        if (!isClaudeCommand(agent.command)) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") is not a claude worker (command: "${agent.command}"), so it has ` +
              "no session to resume and nothing to park. Close it with agent_close.",
          );
        }
        if (!agent.session_id) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}") has no recorded session id, so parking it would promise a resume ` +
              "that cannot happen. It may predate this feature, or have closed before its first hook event fired. " +
              "Close it with agent_close and spawn a fresh worker tomorrow.",
          );
        }
        // THE THIRD OF agent_resume's PRECONDITIONS, and the one this tool
        // originally left out - found by this lane's own /simplify altitude
        // pass, which is the shape of mistake the pass is for: park's promise
        // had quietly outlived resume's requirements INSIDE THE SAME COMMIT
        // that added the requirement.
        //
        // What it costs when it is missing is exactly the case parked_branch
        // was built for. Park a worker whose worktree was already removed out
        // from under it (which the lead did to a running worker on
        // 2026-08-11): the park succeeds and marks the lane resumable,
        // branchAt has nothing to read so it records '', the board line says
        // "branch (unrecorded)", and next morning agent_resume refuses with
        // advice telling you agent_park would have recorded a branch - which
        // it did run, and could not. Unactionable, and false.
        if (!existsSync(agent.cwd)) {
          throw new Error(
            `Agent ${agent.id} ("${agent.name}")'s working directory is already gone: ${agent.cwd}. Parking it ` +
              "would record a lane that cannot be resumed, and its branch can no longer be read. Recreate that " +
              "path first if you want this lane back tomorrow, or close it with agent_close.",
          );
        }
        const live = isLive(agent);
        // Unknown liveness is never dead (issue #14), the same refusal
        // agent_close makes one tool down and for the same reason: parking the
        // row while the pane may still be up leaks a running process nothing
        // tracks, and the kill would not land anyway while tmux is unreachable.
        if (live === null) throw probeFailed(agent);
        if (agent.actor_id === currentActor() && args.confirm_self !== true) {
          throw new Error(
            "This would park your own session. Pass confirm_self=true only if the user explicitly asked you to park yourself.",
          );
        }
        // READ THE BRANCH BEFORE THE PANE DIES. Nothing here depends on the
        // pane, but a park whose kill throws must not have already stamped the
        // row, and a park that stamped the row must have the branch: doing the
        // read first keeps both true whichever way the kill goes.
        const branch = branchAt(agent.cwd);
        if (live) killAgentPane(agent.tmux_target);
        // The same conditional write agent_close makes, for the same race: a
        // concurrent writer recording a fresh pane on this row between the
        // probe above and this write must not have its row retired on the
        // strength of a probe that is no longer true.
        const parkedAt = parkAgentRow(agent.id, agent.tmux_target, branch);
        if (parkedAt === undefined) {
          // Todo 369. This call may already have killed a live pane above -
          // that cannot be undone by a lost CAS, and the message must not
          // pretend otherwise. Re-read the row (classifyLostCas's own
          // comment) rather than assume "nothing happened".
          const after = getAgentRow(project.id, agent.id, "Call agent_list(include_closed: true).");
          const report = classifyLostCas(after);
          if (report.outcome === "retired") {
            if (report.parked) {
              // A concurrent agent_park already parked this exact row -
              // the caller's goal was reached, just not by this call.
              return buildParkReceipt(
                project,
                agent,
                after.parked_at,
                after.parked_branch,
                `Already parked by a concurrent agent_park before this call's own write landed` +
                  (live ? " (this call's kill-pane already took the pane down)." : "."),
              );
            }
            // Closed, but not as a park: an ordinary agent_close (or the
            // janitor) won the race instead. The end state is NOT what this
            // call promised - no branch was recorded through this path, so
            // resuming it may not work the way a park would have set up.
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
        // The one fact a slim receipt cannot leave to the caller to
        // reconstruct (.claude/rules/tool-contract.md): the board_line IS the
        // deliverable half of issue #156. Paste it onto the board.
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
        // A worker that has a window of its own carries its name in that
        // window's title too, which is hive's own to set. WHICH workers those
        // are is renameAgent's question now, not this call site's, and it
        // answers it by asking the window rather than by reading the KIND of
        // id in tmux_target - see ownsItsWindow (src/spawn.ts, todo 371).
        // Every row records a pane id now, so the old `!isPaneTarget(...)`
        // test here answered "no" for every worker in existence.
        renameAgent(agent, newName, live ? project.name : null);

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
          // Todo 317, found by the lane's own /simplify altitude pass rather
          // than by the capture that opened it. This path cannot reach the
          // LEAD - the kind='lead' refusal above throws before any typing -
          // which is what made it look exempt. It types into a live WORKER
          // pane, and a human attached to a worker pane is ordinary: the
          // `lessons` pad's "unsubmitted pane text has happened three times"
          // is about worker panes specifically.
          //
          // THE FAILURE IS WORSE HERE THAN A PLAIN MERGE, which is why this
          // is worth a fork on a rare call. A slash command only executes
          // when it starts the line. Pasted onto a half-typed sentence,
          // "/rename foo" is submitted as ordinary prose along with whatever
          // the human was writing: the human's unfinished text goes as a
          // message, the retitle silently does not happen, and this function
          // still returns retitled: true. The receipt lies about the one
          // thing it exists to report.
          //
          // Same predicate and same narrowness as agent_send's, and it reuses
          // this path's existing refusal shape (heldNote/heldTail/retitled
          // false) rather than adding one - the row is still renamed either
          // way, exactly as it is for the dialog case; only the keystroke is
          // skipped.
          const box = awaitingChoice === true ? null : inputBoxState(agent.tmux_target);
          if (awaitingChoice === true) {
            heldNote =
              "Not retitled: the pane is waiting on a choice, so typing /rename would answer it instead of setting the title. Clear the prompt first (agent_send with keys), then retry.";
            heldTail = tail;
          } else if (holdsHumanInput(box)) {
            // "rename again" has to name the NEW name, not the one the caller
            // typed: renameAgent already ran, so the old name resolves to
            // nothing and a caller retrying its original call gets "no agent
            // named <old>". requireNameFree excludes self, so renaming a row
            // to the name it already has is allowed and is exactly the
            // retry that retitles the pane. Counselors caught this in
            // passing on todo 317; the dialog branch above has never had the
            // problem because it says nothing about retrying.
            heldNote =
              `Not retitled: the pane's input box holds unsubmitted text, so /rename would be pasted onto the end of it and submitted as prose rather than run as a command. The row IS renamed - it is "${newName}" now - and only the pane's own title was left alone. Clear the line with agent_send(keys: ["C-a", "C-k"]) once you can attribute the text, then call agent_rename(name: "${newName}", new_name: "${newName}") to retitle the pane.`;
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
              ...(summary.alive !== true ? claudeOnlyFields(r) : {}),
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
          ...claudeOnlyFields(agent),
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
        // The bound is the one this tool's own description already states,
        // "(250-10000)". Before zod 4 the schema said {"type": "integer"} and
        // the handler clamped, so the wire carried two range statements that
        // disagreed; after zod 4 it advertised +/-9007199254740991 and made the
        // disagreement wider. Declaring the real domain is what makes the
        // description enforceable instead of aspirational. See src/tools/params.ts.
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
          // Issue #150. Checked before any pane read, both because it is the
          // cheapest possible rejection (no tmux fork) and because a bad byte
          // means send it via keys instead - not "read the pane and try
          // anyway". src/tmux.ts's own comment on this detector explains why
          // a control byte reaches tmux as a keystroke rather than as text.
          const badChar = findUnsafeControlChar(args.text, TEXT_ALLOWED_CONTROL_CHARS);
          if (badChar) {
            throw new Error(
              `text cannot contain ${badChar.label} at offset ${badChar.index}: it is typed literally into ` +
                "the pane, and a raw control byte reaches tmux as a keystroke instead of as text, silently " +
                "turning a text call into a keys call. Tab and newline are the only control characters " +
                'allowed. To send an actual keystroke on purpose, use keys instead (e.g. keys: ["C-c"]).',
            );
          }
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
          // Todo 317. The sibling of the dialog check above: a modal REPLACES
          // the input box, so that check needs it ABSENT and cannot see this
          // case at all, while a human mid-sentence has a box very much
          // PRESENT with real text in it. Which states count is
          // holdsHumanInput's call (src/tmux.ts); the rest of that argument,
          // and why this path had no such check for a full release, is in
          // .claude/rules/tmux-and-panes.md, which fires on this file.
          //
          // Local to this call site, and not stated anywhere else:
          //
          // REFUSES rather than holds. The scheduler holds because a wake is
          // a timer that retries; every typing path in this file has a
          // synchronous caller standing right there, so it returns a receipt
          // naming the condition and carrying the pane tail instead.
          //
          // SUBMIT=FALSE IS EXEMPT ON PURPOSE, and this exemption exists
          // nowhere else because no other typing path has the parameter. The
          // destructive event is the ENTER, not the paste: a submitted merge
          // sends a human's half-written sentence as a message he never
          // finished, which he cannot take back, while submit=false leaves
          // characters in a box where they are visible and editable - the
          // `keys` category, drive this TUI deliberately, not the
          // inject-a-user-turn category this guard is for. That argument is
          // the whole of it and stands on its own.
          //
          // IT USED TO REST ON A SECOND ARGUMENT THAT WAS FACTUALLY WRONG,
          // and the correction is worth keeping because the wrong version is
          // the intuitive one. It claimed that guarding submit=false would
          // break compose-then-send, since the second call would refuse on
          // the first call's own text. Backwards: the guard is on the
          // SUBMITTING call, and the submitting call IS the second one. So
          // agent_send(text:"a", submit:false) then agent_send(text:"b")
          // refuses at "b" - the exact failure the wrong argument was used to
          // justify avoiding. Text typed by send-keys -l carries no faint
          // attribute (it is how test/fixtures/panes/real-input.txt was
          // produced), so classifyInputBox correctly calls it "pending" and
          // cannot tell a composing caller's own fragment from a human's.
          //
          // SO COMPOSE-THEN-SEND IS TWO TEXT CALLS NO LONGER. It is
          // agent_send(text, submit:false), as many times as needed, then
          // agent_send(keys:["Enter"]) to submit what was composed. The note
          // below says so, because a caller that discovers the refusal has no
          // way to work this out. Accepted rather than fixed: distinguishing
          // "text this caller put there" from "text a human typed" needs
          // provenance the pane does not carry, and getting it wrong in the
          // permissive direction is exactly the clobber. A composing caller
          // knows it is composing; a human mid-sentence does not know anyone
          // is about to type over them.
          //
          // COST, measured on this project's own machine rather than
          // estimated (tmux 3.7b, 200x50 pane, 54-row window, through the
          // same execFileSync path): a capture-pane fork is 3.5ms median,
          // 4.2ms p90, with plain and -e indistinguishable. It is spent only
          // when submitting, which is exactly the branch that already sleeps
          // ENTER_DELAY_MS (300ms) between paste and Enter, so it is ~1.2% of
          // a call that path already pays for. The submit=false path, which
          // has no sleep and would wear the overhead worst, skips it
          // entirely. Order matters too and is deliberate: the dialog check
          // runs FIRST so a modal still refuses on one fork, and reversing
          // would cost two there, since a modal makes INPUT_BOX_PRESENT false
          // and inputBoxState can never short-circuit a dialog.
          //
          // The receipt reports the box that DECIDED rather than a fresh read
          // of the same pane: re-reading to fill input_box would fork twice
          // and could report a box that had already changed, so a caller
          // shown "pending" could not trust it as the reason for its own
          // refusal.
          const submitting = args.submit !== false;
          if (submitting) {
            const box = inputBoxState(target);
            if (holdsHumanInput(box)) {
              return {
                agent_id: agent.id,
                name: agent.name,
                sent: false,
                // THE REMEDY BRANCHES ON WHETHER THE KEYS PATH WOULD ACTUALLY
                // WORK FOR THIS CALLER, tested with the identical predicate
                // that path uses a few lines above, so the two can never
                // disagree: telling a worker to clear a LEAD's line sends it
                // straight into that path's throw. src/scheduler.ts's
                // howToClearIt makes the same branch for the same reason, on
                // isLead alone, because a wake body is written before anyone
                // knows who will read it; here the caller is known, so the
                // condition can be the real one.
                //
                // It does NOT mention submit=false as a remedy, deliberately.
                // That is a one-step path to arming the very clobber this
                // refusal just prevented: the append lands on the human's
                // half-typed line, and the next thing he does is press Enter
                // on a line that starts with his own words. submit=false is
                // discoverable from the schema by a caller that means to
                // compose; it has no business being suggested to one that
                // has just been told a human is mid-sentence.
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
          await sendText(target, args.text, submitting);
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
        // 1-200, the range this tool's description already states ("default 50
        // lines, max 200"). A negative reached `tmux capture-pane -S "--5"`,
        // which tmux rejects as an unknown option, so the schema was calling
        // valid an input the tool could never serve. See src/tools/params.ts.
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
        // ISSUE #156: CLOSING A PARKED LANE IS HOW A PARK IS ABANDONED, and
        // without this there is no way to abandon one at all. A parked row is
        // already closed, so nothing here has a pane to kill; what it has is a
        // stamp that `hive status` reports and a next-morning lead plans
        // around. Leaving that stamp on a lane nobody will resume is precisely
        // the "a parked crew that exists only on the board goes stale" failure
        // this feature was built to end, reached from inside the feature.
        //
        // It is the Remove-after-Retire flow .claude/rules/tool-contract.md's
        // matrix already describes for pads (pad_archive, then pad_delete),
        // not a second meaning for agent_close: the row ends up exactly where
        // an ordinary close leaves one, plain closed.
        //
        // Reachable only by agent_id, and that is findAgent's shape rather
        // than a restriction chosen here - its name branch resolves among
        // RUNNING rows and reports a closed match as an error. Fine for this
        // case: `hive status` prints the agent_id beside every parked lane, so
        // the caller reading the stale entry already has the one thing this
        // needs.
        if (agent.status === "closed" && agent.parked_at) {
          // Conditional, and it throws on a loss for the same reason the
          // ordinary close below does: a concurrent agent_resume can flip this
          // row running and clear the stamp between findAgent and this write,
          // and an unconditional release would then report `closed: true` over
          // a live worker with a live pane (counselors, all three seats).
          // ONE TRANSACTION, because the gap between these two writes is a
          // real window rather than a theoretical one: a scheduler ticks every
          // three seconds in EVERY hive session on the machine, so a tick
          // landing between the release and the ledger write files exactly the
          // obituary the ledger write exists to prevent. The two statements
          // are one fact - "this lane was deliberately abandoned" - so they
          // commit together or not at all.
          //
          // A plain db.transaction is safe here: this handler never calls
          // withWindowClaim, which is the one transaction in this codebase
          // that must be outermost on its call stack
          // (.claude/rules/store-and-datadir.md).
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
          // ABANDONING A PARK IS A DECISION, NOT A DEATH, AND THE SCHEDULER
          // WAS TOLD SO in the transaction above. Do not delete that
          // markGoneReported call without reading its own comment
          // (src/scheduler.ts).
          //
          // The park exclusion in standingGoneRows is `parked_at = ''`, a
          // FILTER rather than a claim: while the lane sits parked, no cursor
          // row is ever written for it. The release above clears parked_at and
          // deliberately touches nothing else - not closed_at, not
          // agent_state - so without this line the very next scheduler tick
          // sees a closed row, still 'working', no longer parked, with an
          // episode nothing has reported, and tells the lead that worker DIED
          // and to go and excavate its branch. Last night's timestamp, at
          // 09:00, about a lane the lead just deliberately abandoned.
          //
          // A fourth filter would not close it - the release is exactly the
          // moment a filter's condition stops holding. The ledger is durable:
          // it records that this episode has been dealt with, which is what a
          // deliberate release means, and it survives any later change to the
          // columns standingGoneRows reads.
          return { agent_id: agent.id, name: agent.name, closed: true, park_released: true };
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
        if (live) killAgentPane(agent.tmux_target);
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
          // Todo 369, measured live tearing down issue #156's own lane. This
          // call may have just killed a live pane above (`if (live)
          // killAgentPane(...)`), and that cannot be undone by a lost CAS -
          // the old message here claimed "Nothing was closed" over exactly
          // that case, which is false: the pane this call killed stayed
          // killed. Re-read the row (classifyLostCas's own comment) rather
          // than assume, and name the janitor as the plausible winner when
          // this call's own kill is what gave it something to reap - the old
          // message named only a concurrent `hive lead`, which is real for a
          // dead-lead retirement race but was never the cause of the case
          // that was actually measured.
          const after = getAgentRow(project.id, agent.id, "Call agent_list(include_closed: true).");
          const report = classifyLostCas(after);
          if (report.outcome === "retired") {
            // Counselors (all three seats), fix round on this same commit.
            // `live` alone conflates two different facts: isLive(agent)
            // (above) returns false WITHOUT EVER PROBING TMUX whenever
            // agent.status !== "running" - so a row that was ALREADY closed
            // when this call read it produces live===false with no tmux
            // check behind it at all, same as a row this call genuinely
            // probed and found dead. The old wording claimed "this call
            // found the pane already dead" for BOTH, which is false for the
            // first: test/agent-close-honest-cas.test.mjs's own fixture
            // pre-closes the row via SQL and never touches the real pane,
            // which stays genuinely alive - proving the claim wrong against
            // this lane's own test data.
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
        return { agent_id: agent.id, name: agent.name, closed: true };
      }),
  );
}
