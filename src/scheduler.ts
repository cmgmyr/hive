import type { Statement } from "better-sqlite3";
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { dataDir, db, storeReplaced } from "./db.js";
import { maybeBackupHourly } from "./backup.js";
import { renderDashboardForWrite } from "./dashboard.js";
import { loadProjectYml } from "./projectYml.js";
import { listProjects } from "./context.js";
import { closeAgentRow, isLeadActorId, LEAD_ACTOR_PREFIX, LEAD_KIND } from "./spawn.js";
import { awaitingFirstPrompt, awaitingFirstPromptSql } from "./firstPrompt.js";
import {
  describeLiveTasks,
  describeOneTask,
  liveBackgroundTasks,
  type LiveBackgroundTask,
} from "./backgroundTasks.js";
import { MESSAGE_MAX_ROWS, MESSAGE_RETENTION } from "./leadMessage.js";
import { transcriptDir } from "./transcript.js";
import {
  ageSecondsSince,
  describeLastLogEvent,
  humanizeAge,
  lastLogEvent,
  reportsAgentStateLog,
} from "./stateProvenance.js";
import {
  capturePane,
  foreignSocket,
  holdsHumanInput,
  inputBoxState,
  liveTargets,
  maskChoiceMarker,
  paneAwaitingChoice,
  paneReissued,
  rowAlive,
  rowAliveProbe,
  rowLive,
  rowLiveProbe,
  sanitizeTail,
  sendText,
  tailCaptureLines,
  type AliveSnapshot,
  type InputBoxState,
} from "./tmux.js";

export interface TimerRow {
  id: number;
  project_id: number;
  owner: string;
  body: string;
  kind: string;
  watch: string;
  deliver_actor: string;
  deliver_pane: string;
  due_at: string | null;
  max_wait_at: string | null;
  repeat_every_ms: number | null;
  created_at: string;
  fired_at: string | null;
  cancelled_at: string | null;
  fire_count: number;
  typed_at: string | null;
  held_at: string | null;
  held_reason: string | null;
  confirmed_at: string | null;
  typed_busy: number | null;

  typed_seen: string | null;

  first_held_at: string | null;

  deliver_socket: string;

  deliver_pane_pid: string;

  watch_scope: string | null;

  parent_timer_id: number | null;
}

export const WATCH_SCOPE_PROJECT = "project";

const isStandingWatch = (timer: TimerRow): boolean => timer.watch_scope === WATCH_SCOPE_PROJECT;

export const DELIVER_SOCKET_JOIN = `LEFT JOIN agents ON agents.id = (
  SELECT a.id FROM agents a WHERE a.actor_id = timers.deliver_actor
   ORDER BY (a.status = 'running') DESC, a.id DESC LIMIT 1
)`;

export const ACTIVE_TIMER_WHERE =
  "cancelled_at IS NULL AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)";

const SETTLE_WINDOW = "-15 seconds";

interface WatchedState {
  idle: boolean;
  gone: boolean;
  since: string | null;
}

const prepared = new Map<string, Statement>();
function stmt(sql: string): Statement {
  let s = prepared.get(sql);
  if (!s) {
    s = db.prepare(sql);
    prepared.set(sql, s);
  }
  return s;
}

function bestEffortRun(sql: string, ...params: unknown[]): void {
  try {
    stmt(sql).run(...params);
  } catch {

  }
}

let ticking = false;
let schedulerInterval: NodeJS.Timeout | undefined;

export function startScheduler(intervalMs = 3000): void {

  schedulerInterval = setInterval(() => {
    void tick();
  }, intervalMs).unref();
}

export function janitor(snapshot: AliveSnapshot | null = liveTargets()): {
  closed_agents: number;
  cancelled_timers: number;
  probed: boolean;
} {

  if (snapshot === null) return { closed_agents: 0, cancelled_timers: 0, probed: false };
  let closedAgents = 0;
  let cancelledTimers = 0;

  const agents = stmt(
    `SELECT id, tmux_target, tmux_socket, pane_pid FROM agents WHERE status = 'running' AND kind != ? AND tmux_target != ''
     AND created_at < datetime('now', ?)`,
  ).all(LEAD_KIND, SETTLE_WINDOW) as {
    id: number;
    tmux_target: string;
    tmux_socket: string;
    pane_pid: string;
  }[];
  for (const agent of agents) {

    const probe = rowAliveProbe(agent.tmux_socket, agent.tmux_target, snapshot);
    if (probe.live === false || paneReissued(agent.pane_pid, probe)) {
      closeAgentRow(agent.id);
      closedAgents += 1;
    }
  }

  const timers = stmt(
    `SELECT timers.id, timers.due_at, timers.held_reason, timers.deliver_pane,
            COALESCE(agents.tmux_socket, '') AS deliver_socket
       FROM timers ${DELIVER_SOCKET_JOIN}
      WHERE ${ACTIVE_TIMER_WHERE} AND timers.deliver_actor NOT LIKE ?
        AND timers.created_at < datetime('now', ?)`,
  ).all(`${LEAD_ACTOR_PREFIX}%`, SETTLE_WINDOW) as {
    id: number;
    due_at: string | null;
    held_reason: string | null;
    deliver_pane: string;
    deliver_socket: string;
  }[];
  for (const timer of timers) {
    if (rowAlive(timer.deliver_socket, timer.deliver_pane, snapshot) === false) {
      if (wasHeldForPaneReissue(timer.held_reason)) {
        holdTimer(timer, HELD_REASON_PANE_REISSUED_THEN_DEAD);
      } else {
        cancelTimer(timer.id);
        cancelledTimers += 1;
      }
    }
  }
  return { closed_agents: closedAgents, cancelled_timers: cancelledTimers, probed: true };
}

function cancelTimer(timerId: number): void {
  stmt("UPDATE timers SET cancelled_at = datetime('now') WHERE id = ?").run(timerId);
}

export const LOG_RETENTION = "-7 days";
const LOG_MAX_ROWS = 20_000;

function pruneStateLog(): void {
  try {
    const stale = stmt(
      "SELECT 1 AS hit FROM agent_state_log WHERE created_at < datetime('now', ?) LIMIT 1",
    ).get(LOG_RETENTION);
    if (stale) {
      stmt("DELETE FROM agent_state_log WHERE created_at < datetime('now', ?)").run(LOG_RETENTION);
    }

    const hi = (stmt("SELECT MAX(id) AS v FROM agent_state_log").get() as { v: number | null }).v;
    const lo = (stmt("SELECT MIN(id) AS v FROM agent_state_log").get() as { v: number | null }).v;
    if (hi != null && lo != null && hi - lo >= LOG_MAX_ROWS) {
      stmt("DELETE FROM agent_state_log WHERE id <= ?").run(hi - LOG_MAX_ROWS);
    }

    const staleNotices = stmt(
      "SELECT 1 AS hit FROM wake_block_notices WHERE notified_at < datetime('now', ?) LIMIT 1",
    ).get(LOG_RETENTION);
    if (staleNotices) {
      stmt("DELETE FROM wake_block_notices WHERE notified_at < datetime('now', ?)").run(LOG_RETENTION);
    }

    const staleMessages = stmt(
      "SELECT 1 AS hit FROM agent_messages WHERE created_at < datetime('now', ?) LIMIT 1",
    ).get(MESSAGE_RETENTION);
    if (staleMessages) {
      stmt("DELETE FROM agent_messages WHERE created_at < datetime('now', ?)").run(MESSAGE_RETENTION);
    }

    const messageHi = (stmt("SELECT MAX(id) AS v FROM agent_messages").get() as { v: number | null }).v;
    const messageLo = (stmt("SELECT MIN(id) AS v FROM agent_messages").get() as { v: number | null }).v;
    if (messageHi != null && messageLo != null && messageHi - messageLo >= MESSAGE_MAX_ROWS) {
      stmt("DELETE FROM agent_messages WHERE id <= ?").run(messageHi - MESSAGE_MAX_ROWS);
    }

    const staleIdleNotices = stmt(
      "SELECT 1 AS hit FROM wake_idle_notices WHERE notified_at < datetime('now', ?) LIMIT 1",
    ).get(LOG_RETENTION);
    if (staleIdleNotices) {
      stmt("DELETE FROM wake_idle_notices WHERE notified_at < datetime('now', ?)").run(LOG_RETENTION);
    }
  } catch {

  }
}

const DASHBOARD_MIN_INTERVAL_SECONDS = 5;

function claimDashboardAttempt(projectId: number): boolean {
  bestEffortRun("INSERT OR IGNORE INTO dashboard_meta (project_id) VALUES (?)", projectId);
  return (
    stmt(
      `UPDATE dashboard_meta SET last_attempt_at = datetime('now')
       WHERE project_id = ? AND (last_attempt_at IS NULL
         OR last_attempt_at <= datetime('now', '-${DASHBOARD_MIN_INTERVAL_SECONDS} seconds'))`,
    ).run(projectId).changes === 1
  );
}

function writeDashboardAtomically(dashboardDir: string, html: string): void {
  const target = join(dashboardDir, "index.html");
  const temp = join(dashboardDir, `.index.html.tmp-${process.pid}`);
  try {
    writeFileSync(temp, html);
    renameSync(temp, target);
  } catch (e) {
    try {
      unlinkSync(temp);
    } catch {

    }
    throw e;
  }
}

function realpathContained(existingPath: string, projectPath: string): boolean {
  const resolved = realpathSync(existingPath);
  const resolvedProjectPath = realpathSync(projectPath);
  return resolved === resolvedProjectPath || resolved.startsWith(resolvedProjectPath + sep);
}

export function resolveDashboardDir(projectPath: string): string | null {
  const dashboardDir = join(projectPath, ".claude", "dashboard");
  let ancestor = dashboardDir;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!realpathContained(ancestor, projectPath)) return null;
  return dashboardDir;
}

export function dashboardFileContained(dashboardFile: string, projectPath: string): boolean {
  return realpathContained(dashboardFile, projectPath);
}

function maybeGenerateDashboard(project: { id: number; path: string }): void {
  try {

    if (!loadProjectYml(project.path).config?.dashboard) return;

    const dashboardDir = resolveDashboardDir(project.path);
    if (dashboardDir === null) return;

    mkdirSync(dashboardDir, { recursive: true });

    if (!claimDashboardAttempt(project.id)) return;

    const { html, contentHash } = renderDashboardForWrite(project.id);
    const known = stmt("SELECT last_mark FROM dashboard_meta WHERE project_id = ?").get(project.id) as {
      last_mark: string | null;
    };

    const target = join(dashboardDir, "index.html");
    if (known.last_mark === contentHash && existsSync(target)) return;
    writeDashboardAtomically(dashboardDir, html);
    bestEffortRun("UPDATE dashboard_meta SET last_mark = ? WHERE project_id = ?", contentHash, project.id);
  } catch {

  }
}

function maybeGenerateDashboards(): void {
  try {
    for (const project of listProjects()) {
      maybeGenerateDashboard(project);
    }
  } catch {

  }
}

export function checkConfirmations(): void {
  const confirmationQuery = `
       SELECT MIN(created_at) FROM agent_state_log
        WHERE actor_id = timers.deliver_actor AND event = 'prompt' AND created_at >= timers.typed_at
          AND (payload LIKE '%[hive wake #' || timers.id || ']%'
               OR payload LIKE '%[hive wake #' || timers.id || ',%')`;
  try {
    const pending = stmt(
      `SELECT 1 AS hit FROM timers
        WHERE typed_at IS NOT NULL AND confirmed_at IS NULL AND typed_at >= datetime('now', ?) LIMIT 1`,
    ).get(LOG_RETENTION);
    if (!pending) return;
    stmt(
      `UPDATE timers SET confirmed_at = (${confirmationQuery})
       WHERE typed_at IS NOT NULL AND confirmed_at IS NULL AND typed_at >= datetime('now', ?)
         AND EXISTS (${confirmationQuery.replace("MIN(created_at)", "1")})`,
    ).run(LOG_RETENTION);
  } catch {

  }
}

export async function tick(snapshot?: AliveSnapshot | null): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {

    if (storeReplaced()) {
      clearInterval(schedulerInterval);
      schedulerInterval = undefined;
      return;
    }

    if (snapshot === undefined) snapshot = liveTargets();
    janitor(snapshot);

    checkConfirmations();
    pruneStateLog();

    maybeBackupHourly(db, dataDir);

    maybeGenerateDashboards();
    const now = (stmt("SELECT datetime('now') AS now").get() as { now: string }).now;

    const candidates = stmt(
      `SELECT timers.*, COALESCE(agents.tmux_socket, '') AS deliver_socket,
              COALESCE(agents.pane_pid, '') AS deliver_pane_pid
         FROM timers ${DELIVER_SOCKET_JOIN}
        WHERE timers.cancelled_at IS NULL AND (
         (timers.kind = 'delay' AND timers.due_at <= datetime('now')
           AND (timers.fired_at IS NULL OR timers.repeat_every_ms IS NOT NULL))
         OR (timers.kind != 'delay' AND timers.fired_at IS NULL)
       )`,
    ).all() as TimerRow[];

    const choices: ChoiceCache = new Map();
    for (const timer of candidates) {
      if (timer.kind === "delay") await fireDelay(timer, snapshot, choices);
      else await maybeFireIdle(timer, snapshot, now, choices);
    }
  } catch {

  } finally {
    ticking = false;
  }
}

type ChoiceCache = Map<string, { choice?: boolean | null; box?: InputBoxState | null }>;

function cacheEntry(pane: string, cache: ChoiceCache): { choice?: boolean | null; box?: InputBoxState | null } {
  let entry = cache.get(pane);
  if (!entry) {
    entry = {};
    cache.set(pane, entry);
  }
  return entry;
}

function awaitingChoice(pane: string, cache: ChoiceCache): boolean | null {
  const entry = cacheEntry(pane, cache);
  if (entry.choice === undefined) entry.choice = paneAwaitingChoice(pane);
  return entry.choice;
}

function inputBoxHoldsWake(pane: string, cache: ChoiceCache): boolean {
  const entry = cacheEntry(pane, cache);
  if (entry.box === undefined) entry.box = inputBoxState(pane);
  return holdsHumanInput(entry.box);
}

const NO_DIALOG_TTL_MS = 30_000;

const NO_DIALOG_MAX_ENTRIES = 512;

const noDialogUntil = new Map<string, { socket: string; until: number }>();

function recentlyHadNoDialog(socket: string, pane: string): boolean {
  const seen = noDialogUntil.get(pane);
  if (seen === undefined || seen.socket !== socket) return false;
  if (seen.until > Date.now()) return true;
  noDialogUntil.delete(pane);
  return false;
}

function rememberNoDialog(socket: string, pane: string): void {
  const now = Date.now();
  if (noDialogUntil.size >= NO_DIALOG_MAX_ENTRIES) {
    for (const [key, seen] of noDialogUntil) if (seen.until <= now) noDialogUntil.delete(key);

    if (noDialogUntil.size >= NO_DIALOG_MAX_ENTRIES) noDialogUntil.clear();
  }
  noDialogUntil.set(pane, { socket, until: now + NO_DIALOG_TTL_MS });
}

function forgetPaneAnswers(pane: string, choices: ChoiceCache): void {
  choices.delete(pane);
  noDialogUntil.delete(pane);
}

function holdTimer(timer: Pick<TimerRow, "id" | "due_at">, reason: string): void {
  bestEffortRun(
    `UPDATE timers SET held_at = datetime('now'), held_reason = ?,
       first_held_at = COALESCE(CASE WHEN held_at IS NULL THEN NULL ELSE first_held_at END, datetime('now'))
     WHERE id = ? AND cancelled_at IS NULL
       AND (fired_at IS NULL OR (repeat_every_ms IS NOT NULL AND due_at = ?))`,
    reason,
    timer.id,
    timer.due_at,
  );
}

const HELD_REASON_MODAL_CHOICE = "pane is awaiting a modal choice (folder-trust or /model picker)";
export const HELD_REASON_LEAD_PANE_DEAD =
  "the lead's pane is not live right now (likely mid-restart); lead-owned wakes are exempt from " +
  "cancellation for this alone, so it is held rather than lost";

const HELD_REASON_PANE_REISSUED_PREFIX =
  "the pane id recorded for this wake now belongs to a different pane than the one it was set " +
  "against (its pid no longer matches, most likely a tmux server restart reissuing the id); held " +
  "rather than typed into the wrong pane - ";
const HELD_REASON_PANE_REISSUED_LEAD =
  `${HELD_REASON_PANE_REISSUED_PREFIX}run \`hive lead\` to re-point it at the live one`;
const HELD_REASON_PANE_REISSUED_WORKER =
  `${HELD_REASON_PANE_REISSUED_PREFIX}nothing re-points a worker's wake automatically, so cancel ` +
  "it with wake_cancel and set a fresh one once the worker's pane is confirmed live, or leave it: " +
  "it will keep holding rather than deliver wrongly";

const HELD_REASON_PANE_REISSUED_THEN_DEAD =
  `${HELD_REASON_PANE_REISSUED_PREFIX}the pane it was reissued to has since gone dead too; nothing ` +
  "re-points a worker's wake automatically, so cancel it with wake_cancel (any running lead may do " +
  "this even though the wake is not theirs) if it is no longer needed";
export function wasHeldForPaneReissue(heldReason: string | null): boolean {
  return heldReason != null && heldReason.startsWith(HELD_REASON_PANE_REISSUED_PREFIX);
}

export const HELD_REASON_UNSUBMITTED_INPUT_PREFIX = "the pane's input box has unsubmitted human text; ";
export const HELD_REASON_UNSUBMITTED_INPUT =
  `${HELD_REASON_UNSUBMITTED_INPUT_PREFIX}delivering now would paste the wake body onto it and submit ` +
  "both as one message";

// Distinct from HELD_REASON_UNSUBMITTED_INPUT so the claim's debounce doesn't latch a transient
// pane-resolution failure shut forever - the next tick retries instead of giving up permanently.
const HELD_REASON_UNSUBMITTED_INPUT_OWNER_UNRESOLVED =
  `${HELD_REASON_UNSUBMITTED_INPUT_PREFIX}hive could not resolve a live pane for the wake's owner on ` +
  "this tick - retrying, since that may be transient rather than permanent";

export function isUnsubmittedInputHold(heldReason: string | null): boolean {
  return heldReason != null && heldReason.startsWith(HELD_REASON_UNSUBMITTED_INPUT_PREFIX);
}

export const HELD_REASON_CONVERSATION =
  "a human talked to this lead more recently than the conversation-hold window; holding so a wake " +
  "does not split an in-progress discussion - it delivers once the window passes or the hold's own " +
  "ceiling is reached, whichever comes first";

// A human message keeps a lead-bound wake held for this long after it lands. Measured deferral rates
// for this and CONVERSATION_HOLD_MAX are in hive-internals/references/worker-state.md.
const CONVERSATION_HOLD_TTL_SECONDS = 5 * 60;
const CONVERSATION_HOLD_TTL = `-${CONVERSATION_HOLD_TTL_SECONDS} seconds`;

// Must stay well under NOTICE_MAX_AGE, past which noticeDisposition cancels a held notice rather than
// typing stale news (it says so in a replacement wake; it is not silent). Measured against due_at, not first_held_at: cli.ts's hive-lead
// re-point clears held_at (and so first_held_at) on every ordinary reattach, which would otherwise
// launder this ceiling indefinitely.
const CONVERSATION_HOLD_MAX = "-15 minutes";

function conversationHoldsWake(timer: TimerRow): boolean {
  if (timer.due_at !== null) {
    const withinCeiling = stmt(`SELECT ? >= datetime('now', ?) AS within`).get(
      timer.due_at,
      CONVERSATION_HOLD_MAX,
    ) as { within: number };
    if (!withinCeiling.within) return false;
  }
  return (
    stmt(
      `SELECT 1 AS hit FROM agent_state_log
        WHERE actor_id = ? AND event = 'prompt' AND payload NOT LIKE '%[hive wake #%'
          AND created_at >= datetime('now', ?)
        ORDER BY id DESC LIMIT 1`,
    ).get(timer.deliver_actor, CONVERSATION_HOLD_TTL) !== undefined
  );
}

function heldTarget(timer: TimerRow): {
  name: string;
  isLead: boolean;
  agentId: number | null;
  blockedSince: string;
} {
  const row = stmt(
    `SELECT id, name, kind, COALESCE(state_changed_at, '') AS blocked_since FROM agents WHERE actor_id = ?
      ORDER BY (status = 'running') DESC, id DESC LIMIT 1`,
  ).get(timer.deliver_actor) as
    | { id: number; name: string; kind: string; blocked_since: string }
    | undefined;
  return {
    name: row?.name ?? timer.deliver_actor,
    isLead: row?.kind === LEAD_KIND,

    agentId: row?.id ?? null,
    blockedSince: row?.blocked_since ?? "",
  };
}

const readPaneCall = (name: string) => `agent_output(name: ${JSON.stringify(name)})`;
const answerDialogCall = (name: string) => `agent_send(name: ${JSON.stringify(name)}, keys: ["1", "Enter"])`;

const howToClearIt = (name: string, isLead: boolean): string =>
  isLead
    ? `That target is a LEAD session, so agent_send's keys path is refused against it from a worker: a human ` +
      `at that terminal, or another lead, has to answer the dialog.`
    : `Read its pane with ${readPaneCall(name)} FIRST, since this notice can arrive after the dialog ` +
      `was already answered, and if it is still up answer it with ${answerDialogCall(name)} or whichever ` +
      `keys that dialog wants - keys is the only supported way to answer one, because ` +
      `agent_send's text path refuses a pane that is on a dialog.`;

function holdNoticeBody(timer: TimerRow, target: { name: string; isLead: boolean }): string {
  return (
    `"${target.name}" has a dialog up in its pane and is waiting for a human to answer it. hive is HOLDING ` +
    `wake #${timer.id} for it rather than typing the wake body into the dialog. That wake is not lost: it ` +
    `stays pending and delivers on its own once the dialog clears. ${howToClearIt(target.name, target.isLead)}`
  );
}

function unsubmittedInputNoticeBody(timer: TimerRow, target: { name: string }): string {
  return (
    `"${target.name}" has unsubmitted text sitting in its own pane's input box - something was typed there and ` +
    `never submitted. hive is HOLDING wake #${timer.id} for it rather than pasting the wake body on top of that ` +
    `text and submitting both together as one message. That wake is not lost: it stays pending and delivers on ` +
    `its own once the box is empty. Clearing it needs a human at "${target.name}"'s own terminal to submit or ` +
    `delete what's there - hive will not type into a pane holding unsubmitted human text, because that is ` +
    `exactly the merge this hold exists to prevent.`
  );
}

function blockNoticeBody(timer: TimerRow, name: string): string {
  return (
    `"${name}" is stopped on a dialog in its pane, waiting for a human to answer it, so it cannot go idle. ` +
    `wake #${timer.id} is waiting for exactly that, so it will not fire until the dialog is answered (or its ` +
    `max wait runs out, if it has one). The wake is not lost and nothing has been typed into the dialog. ` +
    `${howToClearIt(name, false)}`
  );
}

function standingBlockNoticeBody(timer: TimerRow, names: string[]): string {
  const lines = [
    `${names.length} crew member(s) in this project are stopped on a dialog in their pane, waiting for a ` +
      "human to answer it, so they cannot finish:",
  ];
  for (const name of names) {
    lines.push(
      `  ${name}: read its pane with ${readPaneCall(name)}, then answer the dialog with ` +
        `${answerDialogCall(name)} or whichever keys that dialog wants.`,
    );
  }
  lines.push(
    `Read each pane FIRST: this notice can arrive after a dialog was already answered. keys is the only ` +
      "supported way to answer one, because agent_send's text path refuses a pane that is on a dialog.",
  );
  lines.push(
    `Standing watch #${timer.id} is watching this project's crew and reports each finish as it happens, so ` +
      "it will report nothing about the workers above until their dialogs are answered (or a worker goes " +
      "away, which it reports as such). The watch is " +
      "unaffected - still watching, still pending - and nothing has been typed into any dialog.",
  );
  return lines.join("\n");
}

function ownerPaneIfLive(timer: TimerRow, snapshot: AliveSnapshot | null): string | null {
  const row = stmt(
    `SELECT tmux_target, tmux_socket FROM agents WHERE actor_id = ? AND status = 'running'
      ORDER BY id DESC LIMIT 1`,
  ).get(timer.owner) as { tmux_target: string; tmux_socket: string } | undefined;
  if (!row?.tmux_target || snapshot === null) return null;
  return rowAlive(row.tmux_socket, row.tmux_target, snapshot) === true ? row.tmux_target : null;
}

function blockNoticeTarget(timer: TimerRow, snapshot: AliveSnapshot | null): { actor: string; pane: string } | null {
  const pane = ownerPaneIfLive(timer, snapshot);
  if (pane !== null) return { actor: timer.owner, pane };
  return timer.deliver_pane ? { actor: timer.deliver_actor, pane: timer.deliver_pane } : null;
}

function ownerPaneToTell(timer: TimerRow, snapshot: AliveSnapshot | null): string | null {
  if (timer.owner === timer.deliver_actor) return null;
  const pane = ownerPaneIfLive(timer, snapshot);
  if (pane === null || pane === timer.deliver_pane) return null;
  return pane;
}

function insertNotice(
  timer: TimerRow,
  deliverActor: string,
  pane: string,
  body: string,
  parentTimerId: number | null,
): number {
  return (
    stmt(
      `INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, parent_timer_id)
       VALUES (?, ?, ?, 'delay', ?, ?, datetime('now'), ?)
       RETURNING id`,
    ).get(timer.project_id, timer.owner, body, deliverActor, pane, parentTimerId) as { id: number }
  ).id;
}

function pendingNoticeFor(parentTimerId: number, conditions: readonly string[]): { id: number } | undefined {
  const placeholders = conditions.map(() => "?").join(", ");
  return stmt(
    `SELECT t.id FROM timers t
      WHERE t.parent_timer_id = ? AND t.fired_at IS NULL AND t.cancelled_at IS NULL
        AND EXISTS (
          SELECT 1 FROM wake_idle_notices n WHERE n.notice_timer_id = t.id AND n.condition IN (${placeholders})
        )
      ORDER BY t.id DESC LIMIT 1`,
  ).get(parentTimerId, ...conditions) as { id: number } | undefined;
}

function updateNoticeInPlace(noticeId: number, body: string): boolean {
  return (
    stmt(
      `UPDATE timers SET body = ?, created_at = datetime('now')
        WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL`,
    ).run(body, noticeId).changes === 1
  );
}

function claimBlockNotice(timerId: number, agentId: number, blockedSince: string): boolean {
  return (
    stmt(
      `INSERT OR IGNORE INTO wake_block_notices (timer_id, agent_id, blocked_since)
       VALUES (?, ?, ?)`,
    ).run(timerId, agentId, blockedSince).changes === 1
  );
}

const claimModalHoldWithNotice = db.transaction(
  (timer: TimerRow, pane: string, body: string, target: { agentId: number | null; blockedSince: string }): boolean => {

    const claimed =
      stmt(
        `UPDATE timers SET held_at = datetime('now'), held_reason = ?,
           first_held_at = COALESCE(CASE WHEN held_at IS NULL THEN NULL ELSE first_held_at END, datetime('now'))
          WHERE id = ? AND cancelled_at IS NULL
            AND due_at IS ? AND body IS ? AND repeat_every_ms IS ?
            AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)
            AND held_reason IS NOT ?`,
      ).run(
        HELD_REASON_MODAL_CHOICE,
        timer.id,
        timer.due_at,
        timer.body,
        timer.repeat_every_ms,
        HELD_REASON_MODAL_CHOICE,
      ).changes === 1;
    if (!claimed) return false;

    if (
      target.agentId !== null &&
      target.blockedSince !== "" &&
      !claimBlockNotice(timer.id, target.agentId, target.blockedSince)
    ) {
      return false;
    }
    insertNotice(timer, timer.owner, pane, body, null);
    return true;
  },
);

function noteModalHold(timer: TimerRow, snapshot: AliveSnapshot | null): void {

  if (timer.held_reason !== HELD_REASON_MODAL_CHOICE) {
    try {
      const pane = ownerPaneToTell(timer, snapshot);
      if (pane !== null) {
        const target = heldTarget(timer);
        const body = holdNoticeBody(timer, target);
        if (claimModalHoldWithNotice.immediate(timer, pane, body, target)) return;
      }
    } catch {

    }
  }
  holdTimer(timer, HELD_REASON_MODAL_CHOICE);
}

const claimUnsubmittedInputHoldWithNotice = db.transaction(
  (timer: TimerRow, pane: string, body: string): boolean => {

    const claimed =
      stmt(
        `UPDATE timers SET held_at = datetime('now'), held_reason = ?,
           first_held_at = COALESCE(CASE WHEN held_at IS NULL THEN NULL ELSE first_held_at END, datetime('now'))
          WHERE id = ? AND cancelled_at IS NULL
            AND due_at IS ? AND body IS ? AND repeat_every_ms IS ?
            AND (fired_at IS NULL OR repeat_every_ms IS NOT NULL)
            AND held_reason IS NOT ?`,
      ).run(
        HELD_REASON_UNSUBMITTED_INPUT,
        timer.id,
        timer.due_at,
        timer.body,
        timer.repeat_every_ms,
        HELD_REASON_UNSUBMITTED_INPUT,
      ).changes === 1;
    if (!claimed) return false;

    insertNotice(timer, timer.owner, pane, body, null);
    return true;
  },
);

function noteUnsubmittedInputHold(timer: TimerRow, snapshot: AliveSnapshot | null): void {

  if (timer.held_reason === HELD_REASON_UNSUBMITTED_INPUT) {
    holdTimer(timer, HELD_REASON_UNSUBMITTED_INPUT);
    return;
  }

  if (timer.owner === timer.deliver_actor) {

    holdTimer(timer, HELD_REASON_UNSUBMITTED_INPUT);
    return;
  }

  try {
    const pane = ownerPaneToTell(timer, snapshot);
    if (pane !== null) {
      const target = heldTarget(timer);
      const body = unsubmittedInputNoticeBody(timer, target);
      if (claimUnsubmittedInputHoldWithNotice.immediate(timer, pane, body)) return;

      holdTimer(timer, HELD_REASON_UNSUBMITTED_INPUT);
      return;
    }
  } catch {

  }
  holdTimer(timer, HELD_REASON_UNSUBMITTED_INPUT_OWNER_UNRESOLVED);
}

const BLOCKED_EPISODE = `COALESCE(a.state_changed_at, '') AS episode`;

const oneShotBlockedRows = (timer: TimerRow): CrewRow[] => {
  const ids = JSON.parse(timer.watch) as number[];
  if (ids.length === 0) return [];
  return stmt(
    `SELECT ${CREW_COLUMNS}, ${BLOCKED_EPISODE}
       FROM agents a
      WHERE a.id IN (${ids.map(() => "?").join(",")})
        AND a.status = 'running' AND a.agent_state = 'waiting'`,
  ).all(...ids) as CrewRow[];
};

const standingBlockedRows = (timer: TimerRow, tellActor: string): CrewRow[] =>
  stmt(
    `SELECT ${CREW_COLUMNS}, ${BLOCKED_EPISODE}
       FROM agents a
      WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running' AND a.actor_id != ?
        AND a.agent_state = 'waiting'
      ORDER BY a.id`,
  ).all(timer.project_id, tellActor) as CrewRow[];

function blockedWatchedAgents(
  timer: TimerRow,
  snapshot: AliveSnapshot,
  tellActor: string,
): { id: number; name: string; pane: string; socket: string; blockedSince: string }[] {
  const rows = isStandingWatch(timer) ? standingBlockedRows(timer, tellActor) : oneShotBlockedRows(timer);
  return rows

    .filter((r) => rowAlive(r.tmux_socket, r.tmux_target, snapshot) === true)
    .map((r) => ({
      id: r.id,
      name: r.name,
      pane: r.tmux_target,
      socket: r.tmux_socket,
      blockedSince: r.episode,
    }));
}

const stillPending = (timerId: number): boolean =>
  stmt(
    `SELECT 1 AS hit FROM timers WHERE id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
  ).get(timerId) !== undefined;

const claimBlockNoticeWithNotice = db.transaction(
  (
    timer: TimerRow,
    agentId: number,
    blockedSince: string,
    tell: { actor: string; pane: string },
    body: string,
  ): boolean => {
    if (!stillPending(timer.id)) return false;
    if (!claimBlockNotice(timer.id, agentId, blockedSince)) return false;
    insertNotice(timer, tell.actor, tell.pane, body, null);
    return true;
  },
);

const claimBlockBatch = db.transaction(
  (
    timer: TimerRow,
    tell: { actor: string; pane: string },
    blocked: { id: number; name: string; blockedSince: string }[],
  ): boolean => {
    if (!stillPending(timer.id)) return false;

    const won = blocked.filter((a) => claimBlockNotice(timer.id, a.id, a.blockedSince));
    if (won.length === 0) return false;
    insertNotice(
      timer,
      tell.actor,
      tell.pane,
      standingBlockNoticeBody(
        timer,
        won.map((a) => a.name),
      ),
      null,
    );
    return true;
  },
);

function noteBlockedWatched(timer: TimerRow, snapshot: AliveSnapshot, choices: ChoiceCache): void {
  try {
    const tell = blockNoticeTarget(timer, snapshot);
    if (tell === null) return;
    const tellPane = tell.pane;
    const batched: { id: number; name: string; blockedSince: string }[] = [];
    for (const agent of blockedWatchedAgents(timer, snapshot, tell.actor)) {

      if (agent.pane === tellPane) continue;
      if (alreadyToldAbout(timer.id, agent.id, agent.blockedSince)) continue;

      if (recentlyHadNoDialog(agent.socket, agent.pane)) continue;
      const choice = awaitingChoice(agent.pane, choices);
      if (choice !== true) {

        if (choice === false) rememberNoDialog(agent.socket, agent.pane);
        continue;
      }

      if (isStandingWatch(timer)) {
        batched.push(agent);
        continue;
      }
      claimBlockNoticeWithNotice.immediate(
        timer,
        agent.id,
        agent.blockedSince,
        tell,
        blockNoticeBody(timer, agent.name),
      );
    }
    if (batched.length > 0) claimBlockBatch.immediate(timer, tell, batched);
  } catch {

  }
}

function alreadyToldAbout(timerId: number, agentId: number, blockedSince: string): boolean {
  return (
    stmt(
      `SELECT 1 AS hit FROM wake_block_notices
        WHERE timer_id = ? AND agent_id = ? AND blocked_since = ?`,
    ).get(timerId, agentId, blockedSince) !== undefined
  );
}

const CONDITION_IDLE = "idle";
const CONDITION_GONE = "gone";

const NOTICE_RETRY_AFTER = "-60 seconds";

const NOTICE_MAX_AGE = "-1 hours";

const ROSTER_STILL_GOING = 8;

const FINISHED_SHOWN_CAP = ROSTER_STILL_GOING;

const STANDING_EXPIRED_NOTE =
  "this standing watch has expired and nothing is watching now; set a new one if the crew is still working";

const unreported = (condition: string, episode: string): string => `NOT EXISTS (
    SELECT 1 FROM wake_idle_notices n LEFT JOIN timers nt ON nt.id = n.notice_timer_id
     WHERE n.timer_id = ? AND n.agent_id = a.id AND n.condition = '${condition}' AND n.episode = ${episode}
       AND NOT (nt.fired_at IS NOT NULL AND nt.typed_at IS NULL AND nt.cancelled_at IS NULL
                AND nt.fired_at < datetime('now', '${NOTICE_RETRY_AFTER}')))`;

const CREW_COLUMNS =
  `a.id, a.name, a.actor_id, a.tmux_target, a.tmux_socket, a.agent_state,
   a.state_changed_at, a.status, a.command, a.kind, a.resumed_at, a.closed_at`;

interface CrewRow {
  id: number;
  name: string;
  actor_id: string;
  tmux_target: string;
  tmux_socket: string;
  agent_state: string;
  state_changed_at: string | null;
  status: string;
  command: string;
  kind: string;
  resumed_at: string;
  closed_at: string | null;
  episode: string;
}

interface StandingCandidate {
  condition: string;
  row: CrewRow;
}

// Scopes a standing watch to the OWNER's own crew (bound to owner, not deliver_actor - a watch can
// deliver elsewhere). Keeps a NULL parent_actor_id in rather than filtering it. Does not apply to
// stallCandidateRows below - see .claude/skills/hive-internals/references/worker-state.md.
export const OWNED_BY_WATCH = "AND (a.parent_actor_id = ? OR a.parent_actor_id IS NULL)";

function standingIdleRows(timer: TimerRow): CrewRow[] {
  return (
    stmt(
      `SELECT ${CREW_COLUMNS}, a.state_changed_at AS episode
         FROM agents a
        WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running' AND a.actor_id != ?
          AND a.agent_state = 'idle' AND a.state_changed_at IS NOT NULL
          ${OWNED_BY_WATCH}
          AND ${unreported(CONDITION_IDLE, "a.state_changed_at")}
        ORDER BY a.id`,
    ).all(timer.project_id, timer.deliver_actor, timer.owner, timer.id) as CrewRow[]
  ).filter((row) => !awaitingFirstPrompt(row));
}

function standingGoneRows(timer: TimerRow): CrewRow[] {
  return stmt(
    `SELECT ${CREW_COLUMNS}, a.closed_at AS episode
       FROM agents a
      WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'closed' AND a.actor_id != ?
        AND (a.agent_state != 'idle' OR ${awaitingFirstPromptSql("a")})
        AND a.parked_at = ''
        AND a.closed_at IS NOT NULL
        ${OWNED_BY_WATCH}
        AND ${unreported(CONDITION_GONE, "a.closed_at")}
      ORDER BY a.id`,
  ).all(timer.project_id, timer.deliver_actor, timer.owner, timer.id) as CrewRow[];
}

export function markGoneReported(agentId: number, projectId: number): void {
  stmt(
    `INSERT OR IGNORE INTO wake_idle_notices (timer_id, agent_id, condition, episode)
       SELECT t.id, a.id, '${CONDITION_GONE}', a.closed_at
         FROM timers t
         JOIN agents a ON a.id = ?
        WHERE t.project_id = ? AND t.kind = 'idle_any' AND t.watch_scope IS NOT NULL
          AND t.cancelled_at IS NULL AND t.fired_at IS NULL
          AND a.closed_at IS NOT NULL`,
  ).run(agentId, projectId);
}

export function seedGoneCursor(timerId: number, projectId: number): void {
  stmt(
    `INSERT OR IGNORE INTO wake_idle_notices (timer_id, agent_id, condition, episode)
       SELECT ?, a.id, '${CONDITION_GONE}', a.closed_at
         FROM agents a
        WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'closed'
          AND a.closed_at IS NOT NULL`,
  ).run(timerId, projectId);
}

function idleIsAFreshTransition(timerId: number, row: CrewRow): boolean {
  const previous = (
    stmt(
      `SELECT MAX(episode) AS episode FROM wake_idle_notices
        WHERE timer_id = ? AND agent_id = ? AND condition = '${CONDITION_IDLE}'`,
    ).get(timerId, row.id) as { episode: string | null }
  ).episode;
  if (previous === null) return true;

  const log = stmt(
    "SELECT MIN(created_at) AS oldest, datetime(?, '+1 seconds') AS bound FROM agent_state_log",
  ).get(previous) as { oldest: string | null; bound: string };
  if (log.oldest === null || log.oldest >= log.bound) return true;
  return (
    stmt(
      `SELECT 1 AS hit FROM agent_state_log
        WHERE actor_id = ? AND state IN ('working', 'waiting')
          AND created_at > ? AND created_at < datetime(?, '+1 seconds') LIMIT 1`,
    ).get(row.actor_id, previous, row.episode) !== undefined
  );
}

// A GONE report whose underlying row has moved since it was claimed as GONE is a warning about a
// wrong fact already sitting in this same notice, not mere detail - it must stay visible even in the
// short lead-facing render below, or a lead reading only the one-line summary would trust a stale
// obituary with nothing telling it not to.
const isStaleGoneReport = (c: StandingCandidate): boolean =>
  c.condition === CONDITION_GONE && (c.row.status !== "closed" || c.row.closed_at !== c.row.episode);

interface StillGoingRow {
  name: string;
  actor_id: string;
  agent_state: string;
  state_changed_at: string | null;
  status: string;
  command: string;
  kind: string;
  resumed_at: string;
}

// Shared by the crew render and the full render's own roster, so both agree on who a standing watch
// will ever report - OWNED_BY_WATCH excludes a grandchild the same way the finish rosters above do,
// or "N still going" promises an update the watch will never deliver.
function stillGoingRows(timer: TimerRow): StillGoingRow[] | null {
  try {
    return stmt(
      `SELECT a.name, a.actor_id, a.agent_state, a.state_changed_at, a.status, a.command, a.kind, a.resumed_at
         FROM agents a
        WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running'
          AND (a.agent_state != 'idle' OR ${awaitingFirstPromptSql("a")}) AND a.actor_id != ?
          ${OWNED_BY_WATCH}
        ORDER BY a.id`,
    ).all(timer.project_id, timer.deliver_actor, timer.owner) as StillGoingRow[];
  } catch {
    return null;
  }
}

// The Stop payload that latched THIS episode idle, and only that one: `stateFor("stop")` is the sole
// branch that can write idle, so the event filter names the writer rather than assuming it, and the
// floor AND ceiling together tie the row to the episode the notice is reporting (the notify branch's
// `unchanged` rows are what fooled issue #38). The ceiling is not symmetry for its own sake: this
// renders at DELIVERY time, so a held notice outlives the episode it claimed, and the newest stop row
// is then a different episode's - naming ITS tasks, or blanking the clause on a finish that really did
// leave a shell running. The 2s slack either side is clock granularity, the state write being seconds
// and the log write milliseconds later, and bounds nothing.
function liveTasksAtIdle(actorId: string, episode: string | null): LiveBackgroundTask[] {
  if (episode === null) return [];
  try {
    const row = stmt(
      `SELECT payload FROM agent_state_log
        WHERE actor_id = ? AND event = 'stop'
          AND created_at >= datetime(?, '-2 seconds') AND created_at <= datetime(?, '+2 seconds')
        ORDER BY id DESC LIMIT 1`,
    ).get(actorId, episode, episode) as { payload: string } | undefined;
    if (row === undefined) return [];
    return liveBackgroundTasks((JSON.parse(row.payload) as { background_tasks?: unknown }).background_tasks);
  } catch {
    return [];
  }
}

// A worker that backgrounded a shell and ended its turn IS idle - the latch is right - and it is also
// not finished. A GONE row gets no clause: its pane is gone, so what it was waiting on is not
// actionable. Both renders carry the fact: the crew render puts it on that worker's own line, the
// full one adds each task's own description.
function liveTasksForFinish(c: StandingCandidate): LiveBackgroundTask[] {
  return c.condition === CONDITION_IDLE ? liveTasksAtIdle(c.row.actor_id, c.row.episode) : [];
}

// One entry per WORKER, in the state hive reads at DELIVERY time, however many turns that worker
// finished while the notice was held. The claim rows stay per-episode - they are what stops a finish
// being re-reported - and only this render collapses them, keeping the LAST claim per worker because
// that is the episode whose background tasks and whose state are still current.
function crewFromClaims(finished: StandingCandidate[]): StandingCandidate[] {
  const byAgent = new Map<number, StandingCandidate>();
  for (const c of finished) byAgent.set(c.row.id, c);
  return [...byAgent.values()];
}

// Every clause here is a fact about NOW, never about the episode that was claimed, so that a worker
// which took new work while the notice sat held reads as working rather than as a second crew member.
// The two states that are NOT forward progress get said in words rather than by their enum name: this
// render is the only text a lead reads, so `waiting` reading as work resumed would contradict, in the
// pane, the warning the full render prints - and a resumed worker has no state yet at all.
function crewStateClause(c: StandingCandidate): string {
  if (isStaleGoneReport(c)) {
    return "STALE - its GONE report has moved since; verify with agent_output before trusting it";
  }
  if (c.row.status !== "running") return "gone";
  if (awaitingFirstPrompt(c.row)) return "resumed, awaiting its first assignment";
  if (c.row.agent_state === "waiting") return "waiting - may be stopped on a dialog; read its pane";
  if (c.row.agent_state === "unknown") return "state unknown - read its pane";
  if (c.row.agent_state !== "idle") return `${c.row.agent_state} again since it reported in`;
  const live = liveTasksForFinish(c);
  return live.length === 0 ? "idle" : `idle, ${describeLiveTasks(live)} running - may not be done`;
}

// Rendered at DELIVERY time only, from the notice row's own wake_idle_notices claim rows - never at
// write time. The stored body (below) always carries the full text, so wake_get(noticeId) returns
// real detail. A stale-GONE diagnostic (isStaleGoneReport) stays inline: it corrects a fact THIS SAME
// line asserts, not detail deferrable to a lookup.
// The still-going tally counts only workers this render has NOT already described, and says "other"
// so the exclusion is on the page rather than inferred: a worker named above and also counted here
// read as a crew of two. It subtracts `shown`, never the whole crew: a worker past the cap was
// claimed but never described, so subtracting it can print "Nothing else is running" while it works.
function standingNoticeBodyShort(timer: TimerRow, finished: StandingCandidate[], noticeId: number): string {
  const crew = crewFromClaims(finished);
  const shown = crew.slice(0, FINISHED_SHOWN_CAP);
  const lines = shown.map((c) => `${c.row.name}: ${crewStateClause(c)}.`);

  const reported = new Set(shown.map((c) => c.row.actor_id));
  const rows = stillGoingRows(timer);
  const others = rows === null ? null : rows.filter((r) => !reported.has(r.actor_id)).length;

  const tail: string[] = [];
  const omitted = crew.length - shown.length;
  if (omitted > 0) tail.push(`And ${omitted} more not shown.`);
  if (others !== null) {
    tail.push(others === 0 ? "Nothing else is running." : `${others} other${others === 1 ? "" : "s"} still going.`);
  }
  tail.push(`wake_get(${noticeId}) for detail.`);
  return [...lines, tail.join(" ")].join("\n");
}

function backgroundTaskSentence(c: StandingCandidate): string {
  const live = liveTasksForFinish(c);
  if (live.length === 0) return "";
  return (
    `. It went idle with ${describeLiveTasks(live)} still running ` +
    `(${live.map(describeOneTask).join("; ")}), so it may be WAITING on that rather than finished - ` +
    "read its pane before you act on this line."
  );
}

function standingNoticeBody(
  timer: TimerRow,
  finished: StandingCandidate[],
  totalFinished: number,
  carriedTotal: number,
  span: { lo: string; hi: string } | null,
): string {
  const lines = [
    `${totalFinished} worker(s) in this project have finished or gone away since standing watch ` +
      `#${timer.id} last spoke:`,
  ];
  for (const c of finished) {
    lines.push(
      c.condition === CONDITION_GONE
        ?

          isStaleGoneReport(c)
            ? `  ${c.row.name}: was reported GONE earlier in this hold, but its row's state has moved since - ` +
              `it may have been resumed, or closed again at a different time. Read its CURRENT state with ` +
              `agent_output(name: "${c.row.name}") rather than trusting this line; do not treat it as gone ` +
              "based on this notice alone."
            :

              reportsAgentStateLog(c.row) && c.row.state_changed_at === null
              ? `  ${c.row.name}: GONE - hive last read it as ${c.row.agent_state}, and its row was closed at ` +
                `${c.row.episode}. It was never given an assignment, so nothing was in flight.`
              : `  ${c.row.name}: GONE - hive last read it as ${c.row.agent_state}, and its row was closed at ` +
                `${c.row.episode}, so there is no terminal left to read. Check its branch, its todo and any ` +
                "pad it was writing for what landed before it stopped."
        : `  ${c.row.name}: ${stateNowClause(c.row)}${backgroundTaskSentence(c)}`,
    );
  }

  if (totalFinished > finished.length) {
    lines.push(`...and ${totalFinished - finished.length} more finish(es) not shown above.`);
  }

  if (carriedTotal > 0 && span !== null) {
    lines.push(
      `This notice was updated in place rather than queued behind the one before it: ${carriedTotal} of the ` +
        `${totalFinished} above were already known before this update. Every finish this notice covers spans ` +
        `${span.lo} to ${span.hi}.`,
    );
  }
  const rows = stillGoingRows(timer);
  let shown: string[] = [];
  let more = 0;
  const asked = rows !== null;
  if (rows !== null) {
    more = Math.max(0, rows.length - ROSTER_STILL_GOING);

    shown = rows
      .slice(0, ROSTER_STILL_GOING)
      .map((r) =>
        awaitingFirstPrompt(r) && r.agent_state === "idle"
          ? `${r.name} (awaiting first assignment)`
          : `${r.name} (${stateNowClause(r)})`,
      );
  }
  if (shown.length > 0) {
    lines.push(`Still going: ${shown.join("; ")}${more > 0 ? `, and ${more} more` : ""}.`);
  } else if (asked) {
    lines.push("Nothing else in this project is running right now.");
  }
  lines.push(
    'Read each finished worker with agent_output(name: "<name>") before acting on it. hive fires this on ' +
      "each worker's own hook state, so a terminal still showing work means that worker is NOT finished. A " +
      "worker reading `waiting` may be stopped on a dialog nobody has answered; read its pane.",
  );

  lines.push(`--- what you asked to be told when this happened ---\n${timer.body}`);
  lines.push(
    `Wake #${timer.id} is STILL WATCHING this project and speaks again on the next finish - you do not have ` +
      `to re-arm it. It expires at ${timer.max_wait_at ?? "an unrecorded time"}; stop it with ` +
      `wake_cancel(wake_id: ${timer.id}).`,
  );
  return lines.join("\n");
}

function rearmSpentEpisode(timerId: number, agentId: number, condition: string, episode: string): void {
  stmt(
    `DELETE FROM wake_idle_notices
      WHERE timer_id = ? AND agent_id = ? AND condition = ? AND episode = ?
        AND notice_timer_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM timers t WHERE t.id = wake_idle_notices.notice_timer_id
                      AND t.fired_at IS NOT NULL AND t.typed_at IS NULL AND t.cancelled_at IS NULL
                      AND t.fired_at < datetime('now', '${NOTICE_RETRY_AFTER}'))`,
  ).run(timerId, agentId, condition, episode);
}

function claimEpisode(timerId: number, agentId: number, condition: string, episode: string): boolean {
  return (
    stmt(
      `INSERT OR IGNORE INTO wake_idle_notices (timer_id, agent_id, condition, episode)
       VALUES (?, ?, ?, ?)`,
    ).run(timerId, agentId, condition, episode).changes === 1
  );
}

function stampEpisodeNotice(
  noticeId: number,
  timerId: number,
  agentId: number,
  condition: string,
  episode: string,
): void {
  stmt(
    `UPDATE wake_idle_notices SET notice_timer_id = ?
      WHERE timer_id = ? AND agent_id = ? AND condition = ? AND episode = ?`,
  ).run(noticeId, timerId, agentId, condition, episode);
}

function crewRowForRender(agentId: number, episode: string): CrewRow | null {
  const row = stmt(`SELECT ${CREW_COLUMNS} FROM agents a WHERE a.id = ?`).get(agentId) as
    | Omit<CrewRow, "episode">
    | undefined;
  return row === undefined ? null : { ...row, episode };
}

const claimStandingBatch = db.transaction(
  (timer: TimerRow, candidates: StandingCandidate[]): boolean => {
    if (!stillPending(timer.id)) return false;
    const won: StandingCandidate[] = [];
    for (const c of candidates) {
      rearmSpentEpisode(timer.id, c.row.id, c.condition, c.row.episode);
      if (claimEpisode(timer.id, c.row.id, c.condition, c.row.episode)) won.push(c);
    }
    if (won.length === 0) return false;

    const pending = pendingNoticeFor(timer.id, [CONDITION_IDLE, CONDITION_GONE]);
    if (pending !== undefined) {

      const priorStats = stmt(
        `SELECT COUNT(*) AS n, MIN(episode) AS lo, MAX(episode) AS hi
           FROM wake_idle_notices WHERE notice_timer_id = ?`,
      ).get(pending.id) as { n: number; lo: string | null; hi: string | null };
      const priorCap = Math.max(0, FINISHED_SHOWN_CAP - won.length);
      const prior = stmt(
        `SELECT agent_id, condition, episode FROM wake_idle_notices WHERE notice_timer_id = ?
           ORDER BY episode DESC LIMIT ?`,
      ).all(pending.id, priorCap) as { agent_id: number; condition: string; episode: string }[];
      const carried: StandingCandidate[] = [];
      for (const p of prior) {
        const row = crewRowForRender(p.agent_id, p.episode);

        if (row !== null) carried.push({ condition: p.condition, row });
      }
      const finished = [...carried, ...won];
      const totalFinished = priorStats.n + won.length;

      const spanValues = [priorStats.lo, priorStats.hi, ...won.map((c) => c.row.episode)].filter(
        (v): v is string => v !== null,
      );
      const span =
        spanValues.length > 0
          ? {
              lo: spanValues.reduce((a, b) => (a < b ? a : b)),
              hi: spanValues.reduce((a, b) => (a > b ? a : b)),
            }
          : null;
      if (
        updateNoticeInPlace(pending.id, standingNoticeBody(timer, finished, totalFinished, priorStats.n, span))
      ) {
        for (const c of won) stampEpisodeNotice(pending.id, timer.id, c.row.id, c.condition, c.row.episode);
        return true;
      }

    }
    const noticeId = insertNotice(
      timer,
      timer.deliver_actor,
      timer.deliver_pane,
      standingNoticeBody(timer, won.slice(0, FINISHED_SHOWN_CAP), won.length, 0, null),
      timer.id,
    );
    for (const c of won) {
      stampEpisodeNotice(noticeId, timer.id, c.row.id, c.condition, c.row.episode);
    }
    return true;
  },
);

function noteStandingTransitions(timer: TimerRow, snapshot: AliveSnapshot | null): void {
  try {
    const pane = timer.deliver_pane;
    const candidates: StandingCandidate[] = [];
    for (const row of standingGoneRows(timer)) {
      candidates.push({ condition: CONDITION_GONE, row });
    }

    if (snapshot !== null) {
      for (const row of standingIdleRows(timer)) {
        if (row.tmux_target === pane) continue;
        if (rowAlive(row.tmux_socket, row.tmux_target, snapshot) !== true) continue;
        if (!idleIsAFreshTransition(timer.id, row)) continue;
        candidates.push({ condition: CONDITION_IDLE, row });
      }
    }
    if (candidates.length === 0) return;
    claimStandingBatch.immediate(timer, candidates);
  } catch {

  }
}

const CONDITION_STALL = "stall";

export const STALL_BOUND_SECONDS = 15 * 60;
const STALL_BOUND_SQL = `-${STALL_BOUND_SECONDS} seconds`;

interface StallRow extends CrewRow {
  cwd: string;
  session_id: string;
}

function stallCandidateRows(timer: TimerRow, tellActor: string): StallRow[] {
  return stmt(
    `SELECT ${CREW_COLUMNS}, a.cwd, a.session_id, a.state_changed_at AS episode
       FROM agents a
      WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running' AND a.actor_id != ?
        AND a.agent_state IN ('working', 'waiting')
        AND a.state_changed_at IS NOT NULL
        AND a.state_changed_at < datetime('now', ?)
        AND ${unreported(CONDITION_STALL, "a.state_changed_at")}
      ORDER BY a.id`,
  ).all(timer.project_id, tellActor, STALL_BOUND_SQL, timer.id) as StallRow[];
}

export type TranscriptStaleness = { seconds: number } | "never";

export function transcriptStaleness(
  row: { cwd: string; session_id: string },
  now: number = Date.now(),
): TranscriptStaleness {
  const path = join(transcriptDir(row.cwd), `${row.session_id}.jsonl`);
  try {
    return { seconds: Math.max(0, Math.round((now - statSync(path).mtimeMs) / 1000)) };
  } catch {
    return "never";
  }
}

export function describeStall(agentState: string, latchedSeconds: number, stale: TranscriptStaleness): string {
  const latched = `has claimed \`${agentState}\` for ${humanizeAge(latchedSeconds)}`;
  if (stale === "never") return `${latched} and has never written a transcript at all.`;
  const quiet = `its transcript has not been written for ${humanizeAge(stale.seconds)}`;
  return agentState === "waiting"
    ? `${latched}, its pane shows no dialog, and ${quiet}.`
    : `${latched} and ${quiet}.`;
}

interface StallCandidate {
  row: StallRow;
  stale: TranscriptStaleness;
}

function stallNoticeBody(timer: TimerRow, stalled: StallCandidate[], observedAt: string): string {
  const lines = [
    `${stalled.length} worker(s) in this project have stopped writing to their transcript while still ` +
      `claiming to be mid-turn. Observed at ${observedAt} (store time):`,
  ];
  for (const c of stalled) {
    lines.push(
      `  ${c.row.name}: ${describeStall(c.row.agent_state, ageSecondsSince(c.row.episode), c.stale)} ` +
        `Read it with ${readPaneCall(c.row.name)}.`,
    );
  }
  lines.push(
    "hive is reporting what it OBSERVED and is NOT saying these workers are dead: a worker inside one very " +
      "long tool call looks identical from here. Read each pane before acting. If a turn really did die, send " +
      "that worker a message AND TELL IT WHAT STATE YOU FOUND - after an API error it does not reliably " +
      "remember what it was doing (.claude/rules/worker-state.md).",
  );
  lines.push(
    `Standing watch #${timer.id} is UNAFFECTED by this notice: nothing was fired, held, cancelled or typed ` +
      "into any of the panes above, and no finish has been suppressed.",
  );
  return lines.join("\n");
}

const claimStallBatch = db.transaction(
  (
    timer: TimerRow,
    tell: { actor: string; pane: string },
    candidates: StallCandidate[],
    observedAt: string,
  ): boolean => {
    if (!stillPending(timer.id)) return false;
    const won: StallCandidate[] = [];
    for (const c of candidates) {
      if (c.row.agent_state === "waiting" && !claimBlockNotice(timer.id, c.row.id, c.row.episode)) continue;
      rearmSpentEpisode(timer.id, c.row.id, CONDITION_STALL, c.row.episode);
      if (claimEpisode(timer.id, c.row.id, CONDITION_STALL, c.row.episode)) won.push(c);
    }

    if (won.length === 0) return false;
    const noticeId = insertNotice(timer, tell.actor, tell.pane, stallNoticeBody(timer, won, observedAt), timer.id);
    for (const c of won) {
      stampEpisodeNotice(noticeId, timer.id, c.row.id, CONDITION_STALL, c.row.episode);
    }
    return true;
  },
);

const storeNow = (): string => (stmt("SELECT datetime('now') AS now").get() as { now: string }).now;

function noteStalledCrew(timer: TimerRow, snapshot: AliveSnapshot | null, choices: ChoiceCache): void {
  try {

    const tell = blockNoticeTarget(timer, snapshot);
    if (tell === null) return;
    const now = Date.now();
    const candidates: StallCandidate[] = [];
    for (const row of stallCandidateRows(timer, tell.actor)) {

      if (row.tmux_target === tell.pane) continue;
      if (!reportsAgentStateLog(row)) continue;
      if (row.session_id === "") continue;

      const stale = transcriptStaleness(row, now);
      if (stale !== "never" && stale.seconds < STALL_BOUND_SECONDS) continue;
      if (row.agent_state === "waiting") {

        if (snapshot === null) continue;
        if (rowAlive(row.tmux_socket, row.tmux_target, snapshot) !== true) continue;
        if (awaitingChoice(row.tmux_target, choices) !== false) continue;
      }
      candidates.push({ row, stale });
    }

    if (candidates.length === 0) return;
    claimStallBatch.immediate(timer, tell, candidates, storeNow());
  } catch {

  }
}

// Two facts, kept apart because they earn opposite endings: a notice whose watch was cancelled is
// one the lead asked for no more of, and a notice too old to type is a finish about to be destroyed
// with nothing said (todo 465).
type NoticeDisposition = "deliver" | "aged" | "orphaned";

function noticeDisposition(timer: TimerRow): NoticeDisposition {
  if (timer.parent_timer_id === null) return "deliver";
  try {
    const parent = stmt(
      `SELECT (p.cancelled_at IS NULL) AS live, (? >= datetime('now', ?)) AS fresh
         FROM timers p WHERE p.id = ?`,
    ).get(timer.created_at, NOTICE_MAX_AGE, timer.parent_timer_id) as
      | { live: number; fresh: number }
      | undefined;
    if (parent === undefined || parent.live !== 1) return "orphaned";
    return parent.fresh === 1 ? "deliver" : "aged";
  } catch {
    return "deliver";
  }
}

const AGED_OUT_CONDITION: Readonly<Record<string, string>> = {
  [CONDITION_IDLE]: "finished",
  [CONDITION_GONE]: "gone",
  [CONDITION_STALL]: "stalled",
};

function agedOutBody(timer: TimerRow): string {
  const rows = stmt(
    `SELECT a.name, n.condition FROM wake_idle_notices n JOIN agents a ON a.id = n.agent_id
      WHERE n.notice_timer_id = ? ORDER BY n.episode`,
  ).all(timer.id) as { name: string; condition: string }[];
  const shown = rows
    .slice(0, FINISHED_SHOWN_CAP)
    .map((r) => `${r.name} (${AGED_OUT_CONDITION[r.condition] ?? r.condition})`);
  const omitted = rows.length - shown.length;
  const who =
    shown.length > 0
      ? `${rows.length} report(s) about your crew: ${shown.join(", ")}${omitted > 0 ? `, and ${omitted} more` : ""}`
      : "a report about your crew";
  return (
    `hive could not deliver ${who}. The notice sat over an hour waiting for this pane, which is past ` +
    "the age where hive will type one as news, so it was cancelled - and this line exists so that a " +
    "finish is never destroyed silently. Read each one with agent_output(name: \"<name>\") for its " +
    `CURRENT state rather than trusting the ages above; wake_get(wake_id: ${timer.id}) still holds the ` +
    `full text hive was going to type. ${watchStillWatchingClause(timer)}`
  );
}

// A watch that hit max_wait_at is FIRED, not cancelled, so it reaches here reading perfectly healthy.
// Telling a lead it need not re-arm, in hive's own generated prose, when it must, is how a lane ends
// up sitting finished and unnoticed - which this project has paid for twice.
function watchStillWatchingClause(timer: TimerRow): string {
  const parent = stmt(
    `SELECT (cancelled_at IS NULL AND fired_at IS NULL
             AND (max_wait_at IS NULL OR max_wait_at > datetime('now'))) AS watching
       FROM timers WHERE id = ?`,
  ).get(timer.parent_timer_id) as { watching: number } | undefined;
  return parent !== undefined && parent.watching === 1
    ? `Standing watch #${timer.parent_timer_id} is unaffected and still watching.`
    : `Standing watch #${timer.parent_timer_id} is NOT watching any more; set a new one if the crew is ` +
      "still working.";
}

// Cancel and replacement are one transaction: if the replacement cannot be written the cancel rolls
// back and the notice is retried, rather than the finish going missing after all. The replacement
// carries NO parent, which is the branch above that exempts it - so the thing that reports an
// age-out cannot itself age out, and nothing re-queues, so nothing loops.
const ageOutNotice = db.transaction((timer: TimerRow): void => {
  const cancelled =
    stmt("UPDATE timers SET cancelled_at = datetime('now') WHERE id = ? AND created_at IS ? AND cancelled_at IS NULL")
      .run(timer.id, timer.created_at).changes === 1;
  if (!cancelled) return;
  insertNotice(timer, timer.deliver_actor, timer.deliver_pane, agedOutBody(timer), null);
});

type DeliverableResult = { ok: true; typedSeen: string; firstHeldAt: string | null } | { ok: false };

function deliverable(timer: TimerRow, snapshot: AliveSnapshot | null, choices: ChoiceCache): DeliverableResult {

  const probe = snapshot
    ? rowAliveProbe(timer.deliver_socket, timer.deliver_pane, snapshot)
    : rowLiveProbe(timer.deliver_socket, timer.deliver_pane);
  const live = probe.live;

  if (live === null) return { ok: false };
  if (!live) {

    if (isLeadActorId(timer.deliver_actor)) {
      holdTimer(timer, HELD_REASON_LEAD_PANE_DEAD);
    } else {

      if (wasHeldForPaneReissue(timer.held_reason)) {
        holdTimer(timer, HELD_REASON_PANE_REISSUED_THEN_DEAD);
      } else {
        cancelTimer(timer.id);
      }
    }
    return { ok: false };
  }

  if (paneReissued(timer.deliver_pane_pid, probe)) {
    holdTimer(
      timer,
      isLeadActorId(timer.deliver_actor)
        ? HELD_REASON_PANE_REISSUED_LEAD
        : HELD_REASON_PANE_REISSUED_WORKER,
    );
    return { ok: false };
  }

  if (awaitingChoice(timer.deliver_pane, choices) === true) {

    noteModalHold(timer, snapshot);
    return { ok: false };
  }

  if (inputBoxHoldsWake(timer.deliver_pane, choices)) {
    noteUnsubmittedInputHold(timer, snapshot);
    return { ok: false };
  }

  // The three checks above are facts about whether delivery is POSSIBLE (a dead pane, a reissued
  // pane, unsubmitted text sitting where the paste would land). This one is a fact about whether
  // delivery is WELCOME, which only makes sense to ask once delivery is otherwise clear to proceed -
  // so it sits after them. No notice-claim of its own: the human being held for is the human at the
  // keyboard, and the statusline is what tells them (see the two dead-ends on notice-claim latching
  // and on splitting a hold reason in two).
  if (isLeadActorId(timer.deliver_actor) && conversationHoldsWake(timer)) {
    holdTimer(timer, HELD_REASON_CONVERSATION);
    return { ok: false };
  }

  const pid =
    timer.deliver_pane_pid === "" || probe.pid === null
      ? "no-fact"
      : probe.pid === timer.deliver_pane_pid
        ? "ok"
        : "reissued";

  const dialogVerdict = awaitingChoice(timer.deliver_pane, choices);
  const dialog = dialogVerdict === true ? "yes" : dialogVerdict === false ? "no" : "unknown";

  const boxState = cacheEntry(timer.deliver_pane, choices).box;

  const box = boxState === undefined ? "unknown" : boxState === null ? "absent" : boxState.state;
  return {
    ok: true,
    typedSeen: `live=yes pid=${pid} dialog=${dialog} box=${box}`,

    firstHeldAt: timer.held_at != null ? timer.first_held_at : null,
  };
}

async function fireDelay(
  timer: TimerRow,
  snapshot: AliveSnapshot | null,
  choices: ChoiceCache,
): Promise<void> {

  const disposition = noticeDisposition(timer);
  if (disposition === "aged") {
    try {
      ageOutNotice.immediate(timer);
    } catch {

    }
    return;
  }
  if (disposition === "orphaned") {
    bestEffortRun(
      "UPDATE timers SET cancelled_at = datetime('now') WHERE id = ? AND created_at IS ?",
      timer.id,
      timer.created_at,
    );
    return;
  }
  const decision = deliverable(timer, snapshot, choices);
  if (!decision.ok) return;
  let claimed: boolean;
  if (timer.repeat_every_ms != null) {
    const seconds = Math.max(1, Math.round(timer.repeat_every_ms / 1000));

    claimed =
      stmt(
        `UPDATE timers SET due_at = datetime('now', printf('+%d seconds', ?)),
           fired_at = datetime('now'), fire_count = fire_count + 1,
           typed_at = NULL, confirmed_at = NULL, held_at = NULL, held_reason = NULL, typed_busy = NULL,
           typed_seen = NULL, first_held_at = NULL
         WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ? AND cancelled_at IS NULL`,
      ).run(seconds, timer.id, timer.due_at, timer.body, timer.repeat_every_ms).changes === 1;
  } else {
    claimed = claimOneShot(timer);
  }
  if (claimed) await deliver(timer, "", choices, decision.typedSeen, decision.firstHeldAt);
}

function claimOneShot(timer: TimerRow): boolean {
  return (
    stmt(
      `UPDATE timers SET fired_at = datetime('now'), fire_count = fire_count + 1
       WHERE id = ? AND due_at IS ? AND body IS ? AND repeat_every_ms IS ?
         AND fired_at IS NULL AND cancelled_at IS NULL`,
    ).run(timer.id, timer.due_at, timer.body, timer.repeat_every_ms).changes === 1
  );
}

const GONE: WatchedState = { idle: true, gone: true, since: null };

const UNKNOWN: WatchedState = { idle: false, gone: false, since: null };

function watchedStates(timer: TimerRow, snapshot: AliveSnapshot): WatchedState[] {
  const ids = JSON.parse(timer.watch) as number[];
  return ids.map((id) => {
    const agent = stmt(
      `SELECT *, created_at < datetime('now', ?) AS settled FROM agents WHERE id = ?`,
    ).get(SETTLE_WINDOW, id) as
      | {
          status: string;
          tmux_target: string;
          tmux_socket: string;
          agent_state: string;
          state_changed_at: string | null;
          resumed_at: string;
          settled: number;
        }
      | undefined;
    if (!agent || agent.status !== "running") return GONE;
    const alive = rowAlive(agent.tmux_socket, agent.tmux_target, snapshot);

    if (alive === null) return UNKNOWN;
    if (!alive) {

      if (!agent.settled) return UNKNOWN;
      return GONE;
    }

    return {
      idle: !awaitingFirstPrompt(agent) && agent.agent_state === "idle",
      gone: false,
      since: agent.state_changed_at,
    };
  });
}

async function maybeFireIdle(
  timer: TimerRow,
  snapshot: AliveSnapshot | null,
  now: string,
  choices: ChoiceCache,
): Promise<void> {
  const timedOut = timer.max_wait_at != null && timer.max_wait_at <= now;

  if (isStandingWatch(timer)) {
    noteStandingTransitions(timer, snapshot);

    noteStalledCrew(timer, snapshot, choices);

    if (snapshot !== null && !timedOut) noteBlockedWatched(timer, snapshot, choices);
    if (timedOut) {
      const decision = deliverable(timer, snapshot, choices);
      if (decision.ok && claimOneShot(timer)) {
        await deliver(timer, STANDING_EXPIRED_NOTE, choices, decision.typedSeen, decision.firstHeldAt);
      }
    }
    return;
  }
  let ready = false;
  if (timedOut) {
    ready = true;
  } else {

    if (snapshot === null) return;
    const states = watchedStates(timer, snapshot);

    ready =
      timer.kind === "idle_any"
        ? states.some((s) => s.gone || (s.idle && s.since != null && s.since >= timer.created_at))
        : states.length > 0 && states.every((s) => s.idle);

    if (!ready) noteBlockedWatched(timer, snapshot, choices);
  }
  if (ready) {
    const decision = deliverable(timer, snapshot, choices);
    if (decision.ok && claimOneShot(timer)) {
      await deliver(timer, timedOut ? "max wait reached" : "", choices, decision.typedSeen, decision.firstHeldAt);
    }
  }
}

const TAIL_AGENTS = 3;

function stateNowClause(agent: {
  agent_state: string;
  state_changed_at: string | null;
  status: string;
  actor_id: string;
  command: string;
  kind: string;
}): string {
  if (!reportsAgentStateLog(agent)) return agent.agent_state;

  let latchAge = "";
  try {
    if (agent.status === "running") {
      if (agent.state_changed_at) {
        const seconds = ageSecondsSince(agent.state_changed_at);

        latchAge = Number.isFinite(seconds) ? ` for ${humanizeAge(seconds)}` : " (latch age: unavailable)";
      } else {
        latchAge = " (latch age: no record)";
      }
    }
  } catch {
    latchAge = " (latch age: unavailable)";
  }

  let lastEvent = "";
  try {
    lastEvent = `, last log event: ${describeLastLogEvent(lastLogEvent(agent.actor_id))}`;
  } catch {

  }
  return `${agent.agent_state}${latchAge}${lastEvent}`;
}

function watchedTail(timer: TimerRow): string {
  try {
    const ids = JSON.parse(timer.watch) as number[];
    if (ids.length === 0) return "";
    const shown: string[] = [];
    for (const id of ids.slice(0, TAIL_AGENTS)) {
      const agent = stmt(
        "SELECT name, tmux_target, tmux_socket, agent_state, state_changed_at, status, actor_id, command, kind FROM agents WHERE id = ?",
      ).get(id) as
        | {
            name: string;
            tmux_target: string;
            tmux_socket: string;
            agent_state: string;
            state_changed_at: string | null;
            status: string;
            actor_id: string;
            command: string;
            kind: string;
          }
        | undefined;
      if (!agent) continue;

      if (agent.status !== "running") {
        shown.push(`${agent.name} (hive state now: ${stateNowClause(agent)}): closed, so there is no terminal left to read.`);
        continue;
      }

      if (foreignSocket(agent.tmux_socket)) {
        shown.push(
          `${agent.name} (hive state now: ${stateNowClause(agent)}): its terminal lives on a different tmux ` +
            "socket than this process, so it cannot honestly be read from here.",
        );
        continue;
      }
      let tail = "";
      try {

        tail = maskChoiceMarker(sanitizeTail(capturePane(agent.tmux_target, tailCaptureLines())));
      } catch {

      }
      const stateNow = stateNowClause(agent);
      shown.push(
        tail
          ? `${agent.name} (hive state now: ${stateNow}), last lines of its terminal:\n${tail}`
          : `${agent.name} (hive state now: ${stateNow}): its terminal could not be read.`,
      );
    }
    if (shown.length === 0) return "";
    const lines = ["--- what hive sees on the watched agents as this wake is delivered ---", ...shown];
    if (ids.length > TAIL_AGENTS) {
      lines.push(`(${ids.length - TAIL_AGENTS} more watched agent(s) not shown)`);
    }
    lines.push(
      "hive fires this on each worker's own hook state. If a terminal above shows work still running, that worker is not finished: read agent_output before acting on it.",
    );

    return `\n\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

function firstEpisodeFiledAt(noticeId: number): string | null {
  return (
    stmt("SELECT MIN(notified_at) AS t FROM wake_idle_notices WHERE notice_timer_id = ?").get(noticeId) as {
      t: string | null;
    }
  ).t;
}

// One bound, used twice, and it is the conversation hold's own TTL because that hold is what produces
// these delays: below it a notice cannot have gone stale, so the note is silent; and a content refresh
// less than that after the hold began is not a fact a reader can act on separately, so the two clauses
// collapse to one. At a one-second hold the pair printed the same timestamp and the same age twice.
function noticeStalenessNote(timer: TimerRow): string {
  if (timer.parent_timer_id === null) return "";
  try {
    const heldSince = firstEpisodeFiledAt(timer.id) ?? timer.created_at;
    const heldSeconds = ageSecondsSince(heldSince);
    if (heldSeconds < CONVERSATION_HOLD_TTL_SECONDS) return "";
    const contentSeconds = ageSecondsSince(timer.created_at);
    if (heldSeconds - contentSeconds < CONVERSATION_HOLD_TTL_SECONDS) {
      return `\nHeld ${humanizeAge(heldSeconds)}: this reflects what hive knew at ${heldSince} UTC.`;
    }
    return (
      `\nHeld since ${heldSince} UTC (${humanizeAge(heldSeconds)} ago). Its content reflects what ` +
      `hive knew as of ${timer.created_at} UTC, ${humanizeAge(contentSeconds)} before this ` +
      "reached you."
    );
  } catch {
    return "";
  }
}

// A lead-bound notice types short; wake_get(noticeId) then returns the FULL body this function never
// touches. Reconstructed from the notice row's own wake_idle_notices claim rows (agent_id, condition,
// episode) rather than parsed back out of stored text. Returns null for anything that is not a
// standing-watch finish notice (a self-addressed wake, a block notice, the expiry notice) - deliver()
// falls back to the full body for those, unchanged.
export function shortRenderForLeadDelivery(timer: TimerRow): string | null {
  const rows = stmt(
    `SELECT agent_id, condition, episode FROM wake_idle_notices
      WHERE notice_timer_id = ? AND condition IN ('${CONDITION_IDLE}', '${CONDITION_GONE}')
      ORDER BY notified_at, agent_id, episode`,
  ).all(timer.id) as { agent_id: number; condition: string; episode: string }[];
  if (rows.length === 0) return null;
  const candidates: StandingCandidate[] = [];
  for (const r of rows) {
    const row = crewRowForRender(r.agent_id, r.episode);
    if (row !== null) candidates.push({ condition: r.condition, row });
  }
  if (candidates.length === 0) return null;
  return standingNoticeBodyShort(timer, candidates, timer.id);
}

async function deliver(
  timer: TimerRow,
  note: string,
  choices: ChoiceCache,
  typedSeen: string,

  firstHeldAt: string | null,
): Promise<void> {
  const tail = watchedTail(timer);
  const prefix = `[hive wake #${timer.id}${note ? `, ${note}` : ""}] `;
  const body = (isLeadActorId(timer.deliver_actor) ? shortRenderForLeadDelivery(timer) : null) ?? timer.body;

  let typedBusy: number | null;
  try {
    const lastEvent = lastLogEvent(timer.deliver_actor);
    typedBusy = lastEvent == null ? null : lastEvent.state === "working" || lastEvent.state === "waiting" ? 1 : 0;
  } catch {
    typedBusy = null;
  }

  const recordTyped = () =>
    bestEffortRun(
      `UPDATE timers SET typed_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), typed_busy = ?,
         typed_seen = ?, first_held_at = ?, held_at = NULL, held_reason = NULL, confirmed_at = NULL
       WHERE id = ?`,
      typedBusy,
      typedSeen,
      firstHeldAt,
      timer.id,
    );

  const box = cacheEntry(timer.deliver_pane, choices).box;
  const strandedTextWouldHold = box !== undefined && box !== null && box.state !== "unknown";
  try {
    await sendText(
      timer.deliver_pane,
      prefix + body + noticeStalenessNote(timer) + tail,
      true,
      strandedTextWouldHold ? recordTyped : undefined,
    );
  } finally {

    forgetPaneAnswers(timer.deliver_pane, choices);
  }

  if (!strandedTextWouldHold) recordTyped();
}
