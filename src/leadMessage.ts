import { db } from "./db.js";
import { cutToUnitBudget, flatten } from "./slug.js";

// 300 sits in the empty band between the two measured populations (todo 475): the largest lead-bound
// message anyone has argued must arrive whole is 143 bytes, and the smallest real worker report is 440.
export const LEAD_MESSAGE_THRESHOLD = 300;

// Budgeted against that same 143, so a message of the class that must arrive whole survives as the head
// essentially intact. A threshold alone only half-delivers the urgent case: a 450-character message whose
// first line is "BLOCKED" is exactly what must not become a tool call. Do not trim this to save space.
const HEAD_BUDGET = 140;

const ELLIPSIS = "…";

export const MESSAGE_RETENTION = "-7 days";

// Bounds the ID RANGE, not the row count, copying LOG_MAX_ROWS's shipped shape: after a time prune leaves
// a sparse id space it can fire with fewer rows than the name implies, which for a backstop is the safe
// direction. Far above any observed rate, and lower than agent_state_log's 20,000 because a row here
// holds unbounded message text rather than a hook payload.
export const MESSAGE_MAX_ROWS = 5_000;

export interface StoredLeadMessage {
  id: number;
  from_actor: string;
  from_name: string;
  to_agent_id: number;
  text: string;
  created_at: string;
}

function senderName(projectId: number, actorId: string): string {
  const row = db
    .prepare(
      `SELECT name FROM agents WHERE project_id = ? AND actor_id = ?
        ORDER BY (status = 'running') DESC, id DESC LIMIT 1`,
    )
    .get(projectId, actorId) as { name: string } | undefined;
  if (row !== undefined) return row.name;
  const actor = db.prepare("SELECT name FROM actors WHERE id = ?").get(actorId) as
    | { name: string }
    | undefined;
  return actor?.name?.trim() || actorId;
}

export function senderTag(projectId: number, actorId: string): string {
  const row = db
    .prepare(
      `SELECT name, kind FROM agents WHERE project_id = ? AND actor_id = ?
        ORDER BY (status = 'running') DESC, id DESC LIMIT 1`,
    )
    .get(projectId, actorId) as { name: string; kind: string } | undefined;
  if (row?.kind === "lead") return "[hive:lead] ";
  const name = row?.name ?? senderName(projectId, actorId);
  return `[hive:${row ? "worker" : "agent"} ${flatten(name)}] `;
}

export function storeLeadMessage(
  projectId: number,
  fromActor: string,
  toAgentId: number,
  text: string,
): { id: number; fromName: string } {
  const fromName = senderName(projectId, fromActor);
  const { id } = db
    .prepare(
      `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(projectId, fromActor, fromName, toAgentId, text) as { id: number };
  return { id, fromName };
}

export function readLeadMessage(projectId: number, messageId: number): StoredLeadMessage | undefined {
  return db
    .prepare(
      `SELECT id, from_actor, from_name, to_agent_id, text, created_at
         FROM agent_messages WHERE id = ? AND project_id = ?`,
    )
    .get(messageId, projectId) as StoredLeadMessage | undefined;
}

// A pointer sits in the lead's scrollback forever; the row it names is deleted at MESSAGE_RETENTION. So
// a lookup that misses must say WHICH miss it is - answering "not found" for an expired id reads as a
// bug, a mistyped id or a scoping refusal, and sends the next reader after all three.
export type MissKind = "pruned" | "never-issued" | "other-project";

export function classifyMiss(messageId: number): MissKind {
  const issued = (
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'agent_messages'").get() as
      | { seq: number }
      | undefined
  )?.seq;
  if (issued === undefined || messageId > issued) return "never-issued";
  const elsewhere = db.prepare("SELECT 1 AS hit FROM agent_messages WHERE id = ?").get(messageId);
  return elsewhere === undefined ? "pruned" : "other-project";
}

export function missMessage(messageId: number, kind: MissKind): string {
  if (kind === "never-issued") {
    return (
      `[agent_message_get:never-issued] No message ${messageId} has ever been issued in this store. ` +
      "Nothing was pruned and nothing is being withheld: this id has not been handed out yet, so check " +
      "the id in the pointer line you are reading it from."
    );
  }
  if (kind === "other-project") {
    return (
      `[agent_message_get:other-project] Message ${messageId} exists but belongs to a different project, ` +
      "and hive refuses cross-project reads. Read it from a session scoped to that project."
    );
  }
  return (
    `[agent_message_get:pruned] Message ${messageId} EXISTED and has since been pruned - this is expiry, ` +
    `not a wrong id and not a scoping refusal. hive keeps agent messages for ${MESSAGE_RETENTION.replace("-", "")} ` +
    `(and at most ${MESSAGE_MAX_ROWS} rows), and the janitor has deleted this one. The pointer line in your ` +
    "scrollback outlives the row it names, by design: the text is gone from the store, so look for what the " +
    "sender wrote to its todo or pad instead, which is the durable copy."
  );
}

// flatten, not slug.ts's stripControlChars: that one is [\x00-\x1F\x7F] and this is \p{Cc}\p{Cf}, which
// also covers format characters. The head comes from outside, and a raw control byte in it reaches tmux
// as a keystroke rather than as text, submitting this pointer early and splitting it. The sender's name
// is flattened by senderTag when it builds the tag ahead of this marker - the tag is who, this is what.
export function leadPointerMarker(id: number, text: string): string {
  return `[message #${id}, ${text.length} chars]`;
}

export function renderLeadPointer(id: number, text: string, tag: string): string {
  const flat = flatten(text);
  const head = flat.length > HEAD_BUDGET ? cutToUnitBudget(flat, HEAD_BUDGET) + ELLIPSIS : flat;
  return `${tag}${leadPointerMarker(id, text)} ${head} agent_message_get(${id}) for the full text.`;
}

export function shortenedSendNote(id: number, deliveredChars: number): string {
  return (
    `Over ${LEAD_MESSAGE_THRESHOLD} characters to a LEAD, so that pane got a ${deliveredChars}-character ` +
    `pointer instead of this text: a lead's pane is a human's own window and hive keeps it quiet. Nothing ` +
    `was lost - the full text is stored as message ${id} and the pointer names agent_message_get(${id}) - ` +
    `but the lead reads the rest only if it chooses to. Put whatever must be ACTED on in the first ` +
    `${HEAD_BUDGET} characters, or on the todo, where it is durable. Worker-bound sends are never shortened.`
  );
}

export function shortenedSendFailureClause(marker: string, id: number): string {
  return (
    ` WHAT IS ON THAT SCREEN IS NOT YOUR TEXT. This send was over ${LEAD_MESSAGE_THRESHOLD} characters to a ` +
    `LEAD, so what was pasted is hive's one-line pointer, opening \`${marker}\` - look for THAT line, not for ` +
    `your own words, or you will conclude nothing arrived and resend. Your full text is already stored as ` +
    `message ${id} whatever happens next: agent_message_get(${id}) returns it, so none of it is at risk here.`
  );
}
