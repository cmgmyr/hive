import { join } from "node:path";
import { dataDir, db } from "./db.js";
import { CROSS_SESSION_CLOSE, postClaudeWake, senderAddress } from "./claudeWake.js";
import { harnessFor, paneClassifierFor } from "./harnesses.js";
import {
  LEAD_MESSAGE_THRESHOLD,
  renderLeadMessage,
  senderTag,
  shortenedSendNote,
  storeLeadMessage,
  type StoredLeadMessage,
} from "./leadMessage.js";
import { readLeadTurnState } from "./leadState.js";
import { loadProjectYml } from "./projectYml.js";
import { currentOwnership, PaneOwnershipLost, paneIdentity, requireStillOwned } from "./spawn.js";
import {
  holdsHumanInput,
  paneInCopyMode,
  sendText,
  sleep,
  TmuxTimeoutError,
  type AliveSnapshot,
  type RowPaneIdentity,
} from "./tmux.js";
import type { AgentRow } from "./tools/agents.js";

export const SOCKET_MESSAGE_FOOTER = "Automated hive worker message. Do not reply to this socket sender.";

export const MESSAGE_STATUS = {
  socketPending: "socket-pending",
  fallbackPending: "fallback-pending",
  fallbackClaimed: "fallback-claimed",
  complete: "complete",
  failed: "failed",
} as const;

export const MESSAGE_METHOD = {
  socket: "socket",
  pty: "pty",
  ptyAfterSocketTimeout: "pty-after-socket-timeout",
} as const;

type Method = (typeof MESSAGE_METHOD)[keyof typeof MESSAGE_METHOD];

export interface QuietMessageReceipt {
  agent_id: number;
  name: string;
  sent: boolean;
  pending: boolean;
  message_id?: number;
  delivery_method?: Method;
  confirmed?: boolean;
  shortened?: boolean;
  note?: string;
}

type DeliveryRow = StoredLeadMessage & { project_id: number };

const PANE_LEASE_TTL_SECONDS = 6;
const PANE_LEASE_SETTLE_MS = 500;
const CONFIRM_GRACE_SECONDS = 60;

const ENVELOPE_OPEN = '<cross-session-message from="';
const ENVELOPE_SENDER_CLOSE = '" from-name="hive">';
const EV_PROMPT =
  "(CASE WHEN json_valid(ev.payload) THEN COALESCE(json_extract(ev.payload, '$.prompt'), '') ELSE ev.payload END)";
const EV_MARKER = "(agent_messages.sender_tag || '[message #' || agent_messages.id || ',')";
const EV_HEADER_END = `instr(${EV_PROMPT}, char(10))`;

// The exact "[hive:worker NAME] [message #N," at prompt offset 0 (typed) or opening hive's own envelope body (socket).
const messageEvidenceSql = (select: string): string => `
  SELECT ${select} FROM agent_state_log ev
   WHERE ev.actor_id = (SELECT a.actor_id FROM agents a WHERE a.id = agent_messages.to_agent_id)
     AND ev.event = 'prompt'
     AND ev.created_at >= COALESCE(agent_messages.socket_attempt_at, agent_messages.created_at)
     AND (COALESCE(agent_messages.target_session_id, '') = ''
          OR (json_valid(ev.payload) AND json_extract(ev.payload, '$.session_id') IS agent_messages.target_session_id))
     AND (substr(${EV_PROMPT}, 1, length(${EV_MARKER})) = ${EV_MARKER}
          OR (${EV_HEADER_END} > ${ENVELOPE_OPEN.length + ENVELOPE_SENDER_CLOSE.length}
              AND substr(${EV_PROMPT}, 1, ${ENVELOPE_OPEN.length}) = '${ENVELOPE_OPEN}'
              AND substr(${EV_PROMPT}, ${EV_HEADER_END} - ${ENVELOPE_SENDER_CLOSE.length}, ${ENVELOPE_SENDER_CLOSE.length}) = '${ENVELOPE_SENDER_CLOSE}'
              AND instr(substr(${EV_PROMPT}, ${ENVELOPE_OPEN.length + 1}, ${EV_HEADER_END} - ${ENVELOPE_OPEN.length + ENVELOPE_SENDER_CLOSE.length + 1}), '"') = 0
              AND substr(${EV_PROMPT}, ${EV_HEADER_END} + 1, length(${EV_MARKER})) = ${EV_MARKER}
              AND instr(${EV_PROMPT}, char(10) || '${CROSS_SESSION_CLOSE}') > ${EV_HEADER_END}))`;

const RETAINED = "agent_messages.created_at >= datetime('now', '-7 days')";

function quietMessagingOn(projectId: number): boolean {
  const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
  return project !== undefined && loadProjectYml(project.path).config?.quiet_messaging === true;
}

function eligible(options: { projectId: number; fromActor: string; target: AgentRow; submit: boolean }): boolean {
  const { projectId, fromActor, target, submit } = options;
  if (!submit || target.kind !== "lead" || target.status !== "running" || target.actor_id === fromActor) return false;
  if (harnessFor(target.command).name !== "claude") return false;
  const sender = db
    .prepare("SELECT 1 AS hit FROM agents WHERE project_id = ? AND actor_id = ? AND status = 'running' AND kind = 'agent'")
    .get(projectId, fromActor);
  return sender !== undefined && quietMessagingOn(projectId);
}

function registeredSocket(target: AgentRow): boolean {
  return (
    target.claude_messaging_socket !== "" &&
    target.claude_messaging_pane_pid !== "" &&
    target.claude_messaging_pane_pid === target.pane_pid
  );
}

function leadSession(agentId: number, panePid: string): string {
  const turn = readLeadTurnState(agentId);
  return turn !== null && turn.pane_pid === panePid ? turn.session_id : "";
}

function readRow(id: number): DeliveryRow | undefined {
  return db.prepare("SELECT * FROM agent_messages WHERE id = ?").get(id) as DeliveryRow | undefined;
}

function setStatus(id: number, from: string, to: string, fields: Record<string, string | null> = {}): boolean {
  const names = Object.keys(fields);
  const sets = ["delivery_status = ?", ...names.map((n) => `${n} = ?`)].join(", ");
  try {
    return (
      db
        .prepare(`UPDATE agent_messages SET ${sets} WHERE id = ? AND delivery_status = ?`)
        .run(to, ...names.map((n) => fields[n]), id, from).changes === 1
    );
  } catch {
    return false;
  }
}

const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

function stamp(id: number, column: "typed_at" | "fallback_claimed_at"): void {
  try {
    db.prepare(`UPDATE agent_messages SET ${column} = ${NOW} WHERE id = ?`).run(id);
  } catch {

  }
}

function socketText(id: number, text: string, tag: string): string {
  return `${renderLeadMessage(id, text, tag)}\n\n${SOCKET_MESSAGE_FOOTER}`;
}

function acquirePaneLease(row: DeliveryRow, key: string): string | null {
  try {
    db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(row.from_actor, row.from_name);
    db.prepare("DELETE FROM leases WHERE project_id = ? AND lock_key = ? AND expires_at < datetime('now')").run(row.project_id, key);
    const held = db
      .prepare(
        `INSERT INTO leases (project_id, lock_key, owner, expires_at)
         VALUES (?, ?, ?, datetime('now', printf('+%d seconds', ?)))
         ON CONFLICT(project_id, lock_key) DO NOTHING
         RETURNING expires_at`,
      )
      .get(row.project_id, key, row.from_actor, PANE_LEASE_TTL_SECONDS) as { expires_at: string } | undefined;
    return held?.expires_at ?? null;
  } catch {
    return null;
  }
}

function releasePaneLease(row: DeliveryRow, key: string, expiresAt: string): void {
  try {
    db.prepare("DELETE FROM leases WHERE project_id = ? AND lock_key = ? AND expires_at = ?").run(row.project_id, key, expiresAt);
  } catch {

  }
}

type FallbackOutcome =
  | { kind: "typed" }
  | { kind: "held"; reason: string }
  | { kind: "settled" }
  | { kind: "failed"; reason: string };

function hold(row: DeliveryRow, reason: string): FallbackOutcome {
  try {
    db.prepare("UPDATE agent_messages SET delivery_note = ? WHERE id = ? AND delivery_status = ?").run(
      reason,
      row.id,
      MESSAGE_STATUS.fallbackPending,
    );
  } catch {

  }
  return { kind: "held", reason };
}

function failPending(row: DeliveryRow, reason: string): FallbackOutcome {
  setStatus(row.id, MESSAGE_STATUS.fallbackPending, MESSAGE_STATUS.failed, { delivery_note: reason });
  return { kind: "failed", reason };
}

function pasteFailure(err: unknown, pasted: boolean, buffered: boolean): string {
  const why = err instanceof Error ? err.message : String(err);
  if (pasted) {
    return err instanceof PaneOwnershipLost
      ? `pasted, then the Enter was withheld because pane ownership was lost: ${why} The text may be on screen unsubmitted.`
      : `pasted, then the Enter failed: ${why} The text is on screen unsubmitted.`;
  }
  if (buffered && err instanceof TmuxTimeoutError) return `the paste timed out, so the text MAY be on screen unsubmitted: ${why}`;
  return `nothing was pasted: ${why}`;
}

// One guarded pane attempt. The claim is the CAS that makes it at most one per message.
async function paneFallback(row: DeliveryRow, snapshot?: AliveSnapshot | null): Promise<FallbackOutcome> {
  let identity: RowPaneIdentity;
  try {
    identity = paneIdentity(JSON.parse(row.target_identity ?? "") as RowPaneIdentity);
  } catch {
    return failPending(row, "the accepted target identity is unreadable, so no pane can be certified as the lead's");
  }
  const target = db.prepare("SELECT kind, command FROM agents WHERE id = ?").get(row.to_agent_id) as
    | { kind: string; command: string }
    | undefined;
  const ownership = currentOwnership(row.to_agent_id, identity, snapshot);
  if (ownership === "unknown") return hold(row, "the lead's pane ownership reads unknown");
  if (ownership !== "live" || target === undefined) {
    return failPending(row, `the lead pane this message was accepted for is ${ownership}; nothing is typed into a replacement`);
  }
  const key = `wake-pane:${identity.tmux_socket}:${identity.tmux_target}`;
  const expiresAt = acquirePaneLease(row, key);
  if (expiresAt === null) return hold(row, "another delivery holds the lead's pane");
  let wrote = false;
  try {
    const pane = identity.tmux_target;
    if (paneInCopyMode(pane) === true) return hold(row, "the lead's pane is in copy mode");
    const classifier = paneClassifierFor(target.command);
    if (!classifier) return hold(row, "hive cannot classify the lead's screen");
    const choice = classifier.choiceCheck(pane).awaitingChoice;
    if (choice !== false) return hold(row, choice ? "the lead's pane is waiting on a choice" : "the lead's pane could not be read");
    if (holdsHumanInput(classifier.inputBoxState(pane))) return hold(row, "the lead's input box holds unsubmitted text");

    const claimed = (() => {
      try {
        return (
          db
            .prepare(
              `UPDATE agent_messages SET delivery_status = ?, fallback_claimed_at = ${NOW}
                WHERE id = ? AND delivery_status = ? AND NOT EXISTS (${messageEvidenceSql("1")})`,
            )
            .run(MESSAGE_STATUS.fallbackClaimed, row.id, MESSAGE_STATUS.fallbackPending).changes === 1
        );
      } catch {
        return false;
      }
    })();
    if (!claimed) return { kind: "settled" };

    let pasted = false;
    let buffered = false;
    wrote = true;
    try {
      await sendText(
        pane,
        renderLeadMessage(row.id, row.text, row.sender_tag ?? "", row.socket_attempt_at !== null),
        true,
        () => {
          pasted = true;
          stamp(row.id, "typed_at");
        },
        () => {
          buffered = true;
        },
        () => requireStillOwned(row.to_agent_id, identity, `message #${row.id} fallback`),
      );
    } catch (err) {
      const reason = pasteFailure(err, pasted, buffered);
      setStatus(row.id, MESSAGE_STATUS.fallbackClaimed, MESSAGE_STATUS.failed, { delivery_note: reason });
      return { kind: "failed", reason };
    }
    setStatus(row.id, MESSAGE_STATUS.fallbackClaimed, MESSAGE_STATUS.complete);
    return { kind: "typed" };
  } finally {
    if (wrote) await sleep(PANE_LEASE_SETTLE_MS);
    releasePaneLease(row, key, expiresAt);
  }
}

function earlierFallbackPending(row: DeliveryRow): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS hit FROM agent_messages
          WHERE from_actor = ? AND to_agent_id = ? AND id < ? AND delivery_status = ? AND ${RETAINED}`,
      )
      .get(row.from_actor, row.to_agent_id, row.id, MESSAGE_STATUS.fallbackPending) !== undefined
  );
}

const DO_NOT_RESEND = "do not resend";

// null means this send is not eligible, and agent_send's ordinary pane path runs unchanged.
export async function sendQuietLeadMessage(options: {
  projectId: number;
  fromActor: string;
  target: AgentRow;
  text: string;
  submit: boolean;
}): Promise<QuietMessageReceipt | null> {
  if (!eligible(options)) return null;
  const { projectId, fromActor, target, text } = options;
  const identity = paneIdentity(target);
  const tag = senderTag(projectId, fromActor);
  const session = leadSession(target.id, target.pane_pid);
  const { id } = storeLeadMessage(projectId, fromActor, target.id, text);
  const long = text.length > LEAD_MESSAGE_THRESHOLD;
  const base = { agent_id: target.id, name: target.name, message_id: id, ...(long ? { shortened: true } : {}) };
  const shortNote = (channel: "pane" | "socket", redelivered = false) =>
    long ? ` ${shortenedSendNote(id, renderLeadMessage(id, text, tag, redelivered).length, channel)}` : "";

  const body = socketText(id, text, tag);
  const skip = !registeredSocket(target)
    ? "no messaging socket registered for this lead pane"
    : body.includes(CROSS_SESSION_CLOSE)
      ? "the text contains the envelope's closing tag"
      : null;
  // One statement makes the row visible to the scheduler, already in its route's status.
  db.prepare(
    `UPDATE agent_messages SET delivery_status = ?, delivery_method = ?, socket_attempt_at = ${skip === null ? NOW : "NULL"},
       delivery_note = ?, target_identity = ?, target_session_id = ?, sender_tag = ? WHERE id = ?`,
  ).run(
    skip === null ? MESSAGE_STATUS.socketPending : MESSAGE_STATUS.fallbackPending,
    skip === null ? MESSAGE_METHOD.socket : MESSAGE_METHOD.pty,
    skip,
    JSON.stringify(identity),
    session,
    tag,
    id,
  );
  if (skip === null) {
    const posted = await postClaudeWake({
      socketPath: target.claude_messaging_socket,
      senderAddress: senderAddress(join(dataDir, "wake-sender.sock")),
      text: body,
      beforeWrite: () => {
        requireStillOwned(target.id, identity, `message #${id} socket delivery`);
        const now = db
          .prepare(
            `SELECT a.status, a.kind, a.pane_pid, a.claude_messaging_socket AS socket, a.claude_messaging_pane_pid AS pid,
                    m.delivery_status
               FROM agents a, agent_messages m WHERE a.id = ? AND m.id = ?`,
          )
          .get(target.id, id) as
          | { status: string; kind: string; pane_pid: string; socket: string; pid: string; delivery_status: string }
          | undefined;
        return (
          now !== undefined &&
          now.status === "running" &&
          now.kind === "lead" &&
          now.socket === target.claude_messaging_socket &&
          now.pid === identity.pane_pid &&
          now.pane_pid === identity.pane_pid &&
          now.delivery_status === MESSAGE_STATUS.socketPending &&
          leadSession(target.id, identity.pane_pid) === session
        );
      },
    });
    if (posted) {
      return {
        ...base,
        sent: true,
        pending: true,
        delivery_method: MESSAGE_METHOD.socket,
        confirmed: false,
        note:
          `Posted locally to the lead's messaging socket as message #${id}, awaiting prompt confirmation; ${DO_NOT_RESEND}. ` +
          "sent means handed to the transport, not read: if no prompt confirms it, hive types it into the lead's pane once." +
          shortNote("socket"),
      };
    }
    setStatus(id, MESSAGE_STATUS.socketPending, MESSAGE_STATUS.fallbackPending, {
      delivery_method: MESSAGE_METHOD.ptyAfterSocketTimeout,
      delivery_note: "the socket post failed or timed out",
    });
  }

  const row = readRow(id)!;
  const method = (row.delivery_method ?? MESSAGE_METHOD.pty) as Method;
  const outcome: FallbackOutcome = earlierFallbackPending(row)
    ? hold(row, "an earlier message from this sender to this lead is still awaiting its pane fallback, and this one follows it")
    : await paneFallback(row);
  if (outcome.kind === "typed") {
    const note = shortNote("pane", row.socket_attempt_at !== null).trim();
    return { ...base, sent: true, pending: false, delivery_method: method, ...(note ? { note } : {}) };
  }
  if (outcome.kind === "held") {
    return {
      ...base,
      sent: false,
      pending: true,
      delivery_method: method,
      note:
        `Not typed yet: ${outcome.reason}. Message #${id} is accepted and stored, and hive retries it from the ` +
        `scheduler; do NOT resubmit it. agent_message_get(${id}) shows its delivery state.` +
        shortNote("socket"),
    };
  }
  if (outcome.kind === "settled") {
    const now = readRow(id);
    return {
      ...base,
      sent: true,
      pending: now?.delivery_status !== MESSAGE_STATUS.complete,
      delivery_method: method,
      confirmed: now?.confirmed_at != null,
      note: `Message #${id} was settled by another delivery path; ${DO_NOT_RESEND}. agent_message_get(${id}) shows its state.`,
    };
  }
  throw new Error(
    `[agent_send:quiet-fallback-failed] message #${id} to ${target.name}: ${outcome.reason} hive will not type it again. ` +
      `Do NOT resend blindly: read the lead's pane first, and agent_message_get(${id}) shows the recorded state.`,
  );
}

function graceExpired(row: DeliveryRow, actorId: string, panePid: string): boolean {
  const firstStop = (
    db
      .prepare("SELECT MIN(created_at) AS t FROM agent_state_log WHERE actor_id = ? AND event = 'stop' AND created_at >= ?")
      .get(actorId, row.socket_attempt_at) as { t: string | null }
  ).t;
  let from = firstStop;
  if (from === null) {
    const turn = readLeadTurnState(row.to_agent_id);
    if (turn !== null && turn.state === "working" && turn.pane_pid === panePid) return false;
    from = row.socket_attempt_at;
  }
  return (
    db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 >= ? AS due").get(from, CONFIRM_GRACE_SECONDS) as { due: number }
  ).due === 1;
}

function confirmFromPrompts(): void {
  db.prepare(
    `UPDATE agent_messages SET confirmed_at = (${messageEvidenceSql("MIN(ev.created_at)")}), delivery_status = ?
      WHERE delivery_status IS NOT NULL AND delivery_status != ? AND confirmed_at IS NULL AND ${RETAINED}
        AND EXISTS (${messageEvidenceSql("1")})`,
  ).run(MESSAGE_STATUS.complete, MESSAGE_STATUS.complete);
}

function expireGrace(): void {
  const pending = db
    .prepare(`SELECT agent_messages.* FROM agent_messages WHERE delivery_status = ? AND ${RETAINED} ORDER BY id`)
    .all(MESSAGE_STATUS.socketPending) as DeliveryRow[];
  for (const row of pending) {
    try {
      const target = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(row.to_agent_id) as { actor_id: string } | undefined;
      const panePid = (JSON.parse(row.target_identity ?? "{}") as Partial<RowPaneIdentity>).pane_pid ?? "";
      if (target === undefined || !graceExpired(row, target.actor_id, panePid)) continue;
      db.prepare(
        `UPDATE agent_messages SET delivery_status = ?, delivery_method = ?, delivery_note = ?
          WHERE id = ? AND delivery_status = ? AND NOT EXISTS (${messageEvidenceSql("1")})`,
      ).run(
        MESSAGE_STATUS.fallbackPending,
        MESSAGE_METHOD.ptyAfterSocketTimeout,
        "no prompt confirmed the socket post within its grace",
        row.id,
        MESSAGE_STATUS.socketPending,
      );
    } catch {

    }
  }
}

// Runs inside tick's try; each row's failure is contained so one bad delivery cannot strand the rest.
export async function retryQuietLeadMessages(snapshot: AliveSnapshot | null): Promise<void> {
  try {
    confirmFromPrompts();
  } catch {

  }
  expireGrace();
  let due: DeliveryRow[];
  try {
    due = db
      .prepare(`SELECT agent_messages.* FROM agent_messages WHERE delivery_status = ? AND ${RETAINED} ORDER BY id`)
      .all(MESSAGE_STATUS.fallbackPending) as DeliveryRow[];
  } catch {
    return;
  }
  const blocked = new Set<string>();
  for (const row of due) {
    const pair = `${row.from_actor}\u0000${row.to_agent_id}`;
    if (blocked.has(pair)) continue;
    try {
      const outcome = await paneFallback(row, snapshot);
      if (outcome.kind === "held") blocked.add(pair);
    } catch {
      blocked.add(pair);
    }
  }
}
