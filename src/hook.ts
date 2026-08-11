#!/usr/bin/env node
// Claude Code hook entry point. Writes exact agent state into the hive DB.
// Wired by ~/.hive/hooks.json, which agent_spawn passes via --settings.
// Usage: node hook.js <stop|prompt|notify>; the hook payload arrives on stdin.
import { readFileSync } from "node:fs";
import { db } from "./db.js";

interface HookPayload {
  message?: unknown;
  notification_type?: unknown;
  background_tasks?: unknown;
  session_id?: unknown;
}

// stdin is a one-shot read, so every consumer below shares this one read.
// Memoised rather than read per caller: the transition log stores the raw bytes
// for every event, including the ones whose state decision never parses them,
// and a second read of fd 0 returns nothing.
// undefined means "not read yet"; null means "read and there was nothing". The
// type already had a slot for unset, so a second boolean tracking the same fact
// was one more thing that had to agree.
let raw: string | null | undefined;
function readRaw(): string | null {
  if (raw === undefined) {
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = null;
    }
  }
  return raw;
}

// Memoized the same way readRaw() is, and for the identical reason: stateFor
// and reconcileSessionId (issue #154) both call this for the same event, and
// with no cache each call re-parses the same bytes.
let payload: HookPayload | undefined;
function readPayload(): HookPayload {
  if (payload === undefined) {
    try {
      payload = JSON.parse(readRaw() ?? "") as HookPayload;
    } catch {
      // stdin unavailable or not JSON.
      payload = {};
    }
  }
  return payload;
}

// How much of a payload is kept. Stop and Notification payloads are one or two
// kilobytes; UserPromptSubmit carries the whole prompt, which has no bound at
// all, and a pasted file must not put a megabyte in a row that exists to be
// read. Truncation is marked so a reader is never left wondering whether a
// field is missing from the payload or from the row.
//
// This multiplies with LOG_MAX_ROWS in src/scheduler.ts to give the table's
// worst-case size; moving either one moves a figure the other's comment quotes.
const PAYLOAD_LIMIT = 10_000;

// What the log stores for an event that deliberately left agent_state alone.
// Not a state, and not one agent_state can hold, so a reader is never left
// wondering whether hive wrote this or found it.
const UNCHANGED = "unchanged";

// Issue #24. The state above is one row overwritten in place; this is the
// record that it happened. Raw and unredacted, deliberately: today's bug turned
// on notification_type, a field nothing in hive read and no redaction rule
// would have thought to keep, and a projection can only preserve fields someone
// already knew mattered. The store is local-only and already holds the same
// prompt text in pads, todo bodies and Claude Code's own transcripts, so this
// adds no class of data the machine did not already have.
//
// Deliberately AFTER the state write and in its own try/catch. The state write
// is what wakes, agent_status and hive status depend on; the log is how you
// find out afterwards why one of them was wrong. A log that cannot be written
// must cost the diagnosis, never the behaviour, and sharing a transaction would
// let a full disk here strand a worker as permanently non-idle.
function record(actorId: string, event: string, state: string): void {
  try {
    // Coalesced once: an unreadable payload and an empty one are stored the
    // same way, so there is no reason to carry the null past this line.
    const payload = readRaw() ?? "";
    const stored =
      payload.length > PAYLOAD_LIMIT
        ? payload.slice(0, PAYLOAD_LIMIT) + `\n[hive: truncated at ${PAYLOAD_LIMIT} bytes]`
        : payload;
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, payload) VALUES (?, ?, ?, ?)",
    ).run(actorId, event, state, stored);
  } catch {
    // Never at the session's expense.
  }
}

// Issue #24. The Stop hook fires when the worker's TURN ends, and that is not
// the same event as its work ending. A worker that launched background
// subagents and is waiting on them has ended its turn, so hive recorded idle,
// and a lead's wake_when_idle fired on a lane that was not finished.
//
// The payload can tell the two apart. Stop carries background_tasks: [] when
// nothing is in flight and one entry per live background task when something
// is. Captured against Claude Code 2.1.220, headless and in a real tmux pane;
// the payloads are on todo 57.
//
// Only subagents count, deliberately. A backgrounded Bash tool call rides in
// the same array tagged type "shell", and counting those would leave a worker
// running `npm run watch` permanently non-idle, so every wake set on it would
// ride to max_wait instead of firing. The asymmetry is structural rather than
// stylistic: a subagent always terminates, and when it does Claude Code injects
// a task-notification into its parent as a fresh user turn, which fires
// UserPromptSubmit ("working") and then a Stop carrying an empty array
// ("idle"). So "working" always resolves on its own. A background shell makes
// no such promise; `sleep infinity` never ends and never re-prompts anything.
// The type filter is a WHITELIST and the status filter is a DENYLIST, and they
// point opposite ways on purpose. The safe direction is different for each,
// because the two mistakes cost different things.
//
// An unrecognised TYPE must not count. Over-counting types strands a worker as
// permanently non-idle and every wake set on it rides to max_wait, which is
// worse than the bug being fixed.
//
// An unrecognised STATUS must count. This shipped as `status === "running"`,
// which treats every other value as not-in-flight, so a payload of
// [{type:"subagent", status:"queued"}] for a subagent that is launched but not
// yet started writes "idle", the lead's wake fires, and the lane is reviewed
// with zero subagent output. That is issue #24 verbatim, re-opened by the fix
// for it. Statuses grow vocabulary far more readily than types do.
//
// The asymmetry that makes the denylist safe is the same one the type filter
// rests on: once type says subagent, the task is guaranteed to terminate and
// to re-prompt its parent with a task-notification when it does, which fires
// UserPromptSubmit and then a Stop carrying an empty array. So an unrecognised
// status read as running is self-correcting within one subagent's lifetime.
// Read as idle it is not self-correcting at all; it is the false wake.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "killed", "error"]);

function waitingOnSubagents(payload: HookPayload): boolean {
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((entry) => {
    const task = entry as { type?: unknown; status?: unknown } | null;
    if (task?.type !== "subagent") return false;
    return !TERMINAL_STATUSES.has(String(task?.status ?? ""));
  });
}

// Issue #24, the second door, and the one the fix for it missed entirely.
//
// Claude Code emits a Notification 60 seconds after a Stop with no user input:
//
//   {"hook_event_name":"Notification",
//    "message":"Claude is waiting for your input",
//    "notification_type":"idle_prompt"}
//
// hive read that message and wrote "idle". So a worker blocked on four live
// subagents was recorded idle 60 seconds after its turn ended, every time, and
// the lead's wake fired on a lane with subagents still running. The full
// capture is on todo 61. The stop branch above was correct throughout; it was
// never the branch that wrote the idle.
//
// THE FIX IS TO DELETE AN INFERENCE, NOT TO PROP IT UP. That notification says
// the input box has been quiet for sixty seconds. That is equally true of a
// worker that has finished, a worker blocked on a permission dialog, and a
// worker waiting on subagents, so it carries no information about which one you
// have. The other two shapes considered were to stop it downgrading a "working"
// set by a Stop, and to look the last Stop's decision up in agent_state_log.
// Both keep a branch that decides worker liveness while structurally unable to
// see it, and both need a source of truth outside the payload to do it. There
// is nothing to decide here: Stop already made this call with the evidence in
// hand, so the answer is to leave that decision standing.
//
// Which makes the rule one sentence. A NOTIFICATION MAY ONLY EVER MOVE A WORKER
// TO "waiting". It can never write idle, so it can never fire a wake, and the
// idle prompt writes nothing at all.
//
// Nothing gets stuck as a result. Stop fires at the end of every turn and
// UserPromptSubmit at the start of the next, so the state is rewritten within
// one turn either way; a subagent finishing re-prompts its parent, which is the
// same self-healing property the stop branch rests on.
//
// notification_type is the discriminator, not the prose. The regex predates the
// field and reads English out of a message string; a wording change would flip
// hive back to the bug. The regex STAYS as a fallback, for exactly one case: a
// payload with no notification_type at all, which is what an older Claude Code
// would send. hive pins no version (2.1.220 today) so that case is real. Its
// answer is inverted along with everything else, from "idle" to "leave it
// alone", so the fallback path cannot re-open this either.
//
// A notification hive does not recognise still writes "waiting", which is what
// it has always done. "waiting" is not idle, so an unrecognised notification can
// never fire a wake; the cost of getting it wrong is a wake that rides to
// max_wait, and this branch has just spent a day proving which of those two
// costs is the one to avoid.
//
// THAT SAFETY ARGUMENT DEPENDS ON "waiting" NEVER FIRING A WAKE. Read this
// before you make it a firing state, because a version of this branch did and
// it had to be removed.
//
// "waiting" is LATCHED. Nothing clears it. It is written by a Notification, and
// the END of the condition it describes emits nothing at all: hive wires Stop,
// UserPromptSubmit and Notification (src/hooks.ts), and answering a permission
// prompt is none of those. The worker resumes mid-turn and the row still says
// "waiting" until its turn ends, which is however long the approved tool runs.
//
// Two consequences, and they point in opposite directions, which is what makes
// this worth a paragraph rather than a line. A stale "waiting" cannot be told
// from a live one, so a wake on it reports a worker that needs a human when the
// human answered ten minutes ago. And a worker that was ALREADY waiting when a
// wake was set never transitions again, so the freshness test that idle_any
// rests on (state_changed_at >= timer.created_at) is false forever, and the wake
// never fires for exactly the worker it was set for.
//
// A dwell does not rescue it. "stuck for fifteen seconds" and "unblocked three
// seconds in and busy since" are byte-identical in the store. Waiting longer to
// look at a value nothing refreshes is not observing, it is inferring from an
// absence of evidence, which is issue #24's own shape.
//
// Making "waiting" trustworthy means something has to write it back, which means
// a hook hive does not currently wire. That is a lane with its own capture step,
// not a condition to add to a scheduler comparison.
function stateForNotification(payload: HookPayload): string | null {
  const type = payload.notification_type;
  // Which notification this is, then one mapping. Written as one return
  // deliberately: the rule above is that a notification may only ever move a
  // worker to "waiting", and a second discriminator must not be able to arrive
  // with a second answer.
  const idlePrompt =
    typeof type === "string"
      ? type === "idle_prompt"
      : /waiting for your input/i.test(String(payload.message ?? ""));
  return idlePrompt ? null : "waiting";
}

// Issue #154, D1 (todo 353's plan pad). agent_spawn writes a UUID onto the
// row at spawn time via claude's own --session-id, so this is a RECONCILE,
// not the primary write: the hook is the authority, and this is what makes
// the CLI flag non-load-bearing rather than redundant. If --session-id is
// ever ignored, renamed or dropped by a future claude, the row just carries
// '' until the worker's first hook event, and this function corrects it the
// same way it corrects a `--fork-session` resume (which mints a NEW id) -
// the row simply follows whatever the hook reports.
//
// Scoped to kind = 'agent', matching the state write's own allowlist below
// rather than a bare actor_id match: a lead's actor_id is deliberately
// REUSED across a restart (ensureLeadRow, src/cli.ts), so an unqualified
// match could hit a stale closed row sharing the same actor_id instead of
// the current running one. Workers never share an actor_id (each spawn
// mints a fresh one), so this scoping costs nothing there and removes the
// ambiguity for the lead case.
//
// The WHERE clause's own session_id check is a no-op guard, not a
// correctness requirement: it just skips writing when the row already
// agrees, so an already-correct row costs no write on every one of a
// worker's hook events.
function reconcileSessionId(actorId: string, payload: HookPayload): void {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) return;
  db.prepare(
    "UPDATE agents SET session_id = ? WHERE actor_id = ? AND kind = 'agent' AND session_id IS NOT ?",
  ).run(sessionId, actorId, sessionId);
}

// One dispatch, so each event's whole answer is in one place. The previous
// shape picked a default in a ternary chain and then overrode it in an if/else
// nine lines below, which meant "notify defaults to waiting" and "notify
// becomes idle when Claude is asking" were written far apart and a fourth
// event would have to be added to both.
//
// null means hive learned nothing about this worker's state and leaves the row
// alone. It is a third answer, distinct from every value agent_state can hold,
// and having it is what lets the notify branch stop guessing rather than guess
// more carefully.
function stateFor(event: string): string | null {
  switch (event) {
    case "prompt":
      return "working";
    case "stop":
      // A payload hive cannot read leaves the old answer in place: an absent
      // or unparseable background_tasks means "nothing says work is in
      // flight", which is what a turn ending has always meant here.
      return waitingOnSubagents(readPayload()) ? "working" : "idle";
    case "notify":
      return stateForNotification(readPayload());
    default:
      return "waiting";
  }
}

// Issue #27. A lead now has an agents row (kind='lead'), so an unqualified
// UPDATE by actor_id would MATCH it and write real agent_state - the
// discriminator has to run before the write, not be inferred from "the row
// doesn't exist anyway". Folded into the UPDATE's own WHERE (kind = 'agent')
// rather than a separate SELECT first: one query instead of two on every
// hook invocation, for every actor, not just the lead's.
//
// Written as an ALLOWLIST (only kind='agent' gets state), not a denylist
// (everything except kind='lead'): agents.kind also holds 'command' for
// hive.yml background processes, and .claude/rules/worker-state.md's rule is
// specifically about a worker's /goal, not about "everyone but the lead". A
// denylist would default a future third kind into getting state written; an
// allowlist defaults it to the same silence a lead now deliberately gets.
//
// A lead's hook writes the log row and nothing else, deliberately, not as a
// half-measure: .claude/rules/worker-state.md's "never set a /goal on a
// worker" names why. A /goal fires Stop after every turn while immediately
// starting another, so hive would record idle for an actor that never
// stopped - nine consecutive false idles were measured on agent:53 in 50
// seconds with no prompt|working between them. A /goal is the lead's normal
// unattended operating mode, and the lead has no supervisor polling it the
// way a lead polls a worker, so a false idle here has nothing above it to
// catch the mistake. The log row still gets state computed by stateFor below;
// what stays unwritten is agents.agent_state, the value anything else in hive
// would act on.

try {
  const actorId = process.env.HIVE_AGENT_ID;
  if (actorId) {
    const event = process.argv[2] ?? "";
    const state = stateFor(event);
    if (state !== null) {
      db.prepare(
        "UPDATE agents SET agent_state = ?, state_changed_at = datetime('now') WHERE actor_id = ? AND kind = 'agent'",
      ).run(state, actorId);
    }
    // Every event carries session_id, not only the ones stateFor reads a
    // payload for, so this runs unconditionally rather than folded into the
    // branch above.
    reconcileSessionId(actorId, readPayload());
    // Outside the branch above: the event proves the session is alive whether or
    // not it said anything about what the session is doing.
    db.prepare("UPDATE actors SET last_seen_at = datetime('now') WHERE id = ?").run(actorId);
    // Logged either way, and a deliberate no-op is the row a future lane most
    // needs to see. UNCHANGED is not a value agent_state can hold, so the log
    // never reads as if hive had written one.
    record(actorId, event, state ?? UNCHANGED);
  }
} catch {
  // A hook must never break the agent session.
}
process.exit(0);
