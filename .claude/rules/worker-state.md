---
paths:
  - "src/hook.ts"
  - "src/backgroundTasks.ts"
  - "src/hooks.ts"
  - "src/scheduler.ts"
  - "src/tools/wakes.ts"
  - "src/firstPrompt.ts"
  - "src/dashboard.ts"
  - "src/processes.ts"
---

# Worker state, and why it has an append-only log

`agent_state_log` is append-only and the hook writes one row per invocation. Nothing updates a row and nothing deletes one except retention. Three things about it are load-bearing:

- **The `event` column.** Both #24 lanes reasoned from "an idle was written" to "`stateFor("stop")` wrote it" without checking, and the truth was that the notify branch wrote it. One column answers that at a glance.
- **The payload is stored raw and unredacted.** A projection can only preserve fields someone already knew mattered.
- **The log write sits AFTER the state write, in its own try/catch, never sharing a transaction.** The state write is what wakes and `agent_status` depend on, so a log that cannot be written must cost the diagnosis, never the behaviour.

Assert over the SEQUENCE in this table, never over a sample of `agent_state`, or the test has the blind spot the table exists to remove.

## Enumerate every path that can write the value, before picking one

Any time you have "the system recorded X", the first question is which writer wrote it, not why the writer you have in mind would have.

## Rules left behind by six incidents where worker state read wrong

A `working` older than the lane's rhythm is suspicious; `working` is not self-evidently healthy.

- A latch may decide whether to LOOK, never what is true. Deciding to STAY QUIET is the safe direction of the same rule.
- If you ever add a second reason to suppress a finish, every finish-suppressing rule has to be checked against every rule that reads "already reported" off the same column.
- An exclusion is only as durable as the column it reads, so when you add one, ask who else writes that column and what their failure paths put back.
- If `agents.resumed_at` SUPPRESSES, the `idle` gate covers you; if it REPORTS, ask whether the row has a state channel at all before you say anything about it.

**The reader set is `src/firstPrompt.ts`'s own importers, found with `grep -rln 'firstPrompt.js' src/`, and no prose list here is authoritative.** Count call sites, not files - one file can hold more than one.

## A debounce is not an inference

A dwell that waits for a state to stop changing and reports what it observed asserts nothing, is self-verifying, and can only make a wake late rather than early. If you write one, say in the code which kind it is, because the next reader cannot tell from the shape.

## The latch owns ONE background-task type; the notice names the rest

A Stop payload's `background_tasks` carries `subagent`, `shell` and `monitor`, and only `subagent`
withholds a worker's idle (`BACKGROUND_TASK_DISPOSITION`, `src/backgroundTasks.ts`). Do not widen
that set: a shell or a monitor need never terminate, so a latch that waited for one would leave a
worker that backgrounds anything reading `working` forever, and the standing watch that exists to
return control would never fire. That is silent in the worse direction, and `agent_state` is the one
column six surfaces read.

The standing notice names every live task instead, whatever its type, INCLUDING one hive has never
seen. Only the latch's set is closed, and it is pinned as an exact table by a test so a fourth type
cannot be added without deciding which side it falls on. Sixth incident and the observed data:
`.claude/skills/hive-internals/references/worker-state.md`.

## A notice that ages out says so

`NOTICE_MAX_AGE` cancels a standing-watch notice held past an hour rather than typing stale news.
The episode claim in `wake_idle_notices` stays claimed, so that finish can never be reported again -
which means the cancel must file its own short replacement naming who was dropped, and does
(`ageOutNotice`). Do not make the age-out silent again, do not release the episode claim so the
notice re-queues (it loops and ages out again), and keep the replacement parentless, which is what
exempts it from the same bound.

## Never set a /goal on a worker

A goal fires the Stop hook after every turn while immediately starting another, so hive records idle for a worker that never stopped.

## Wake-up bodies are delivered verbatim into a terminal

Whatever you pass as a wake body is typed into the target pane exactly as written, and it becomes a fresh user turn only if that pane happens to be idle. So write it as plain English that stands on its own: the ids it refers to, the context needed to act, and the next action.

**The one exception is generated, and it is not yours to write:** a standing watch's own FINISH NOTICE, bound for a LEAD, is typed as CREW STATE instead of its stored body (`deliver()` -> `shortRenderForLeadDelivery`) - one line per WORKER, deduplicated, however many turns that worker finished while the notice was held, each described in the state hive reads as it delivers. It is not an episode log and must not become one: `wake_idle_notices` stays per-episode, because that is what stops a finish being re-reported, and only the render collapses. That text has no author - the scheduler builds it from store rows - so nothing an author passes is ever shortened, and the full body stays on the row for `wake_get` to return. Your body still reaches a WORKER verbatim, and reaches a lead verbatim for every other kind of wake.

**A second generated trailer rides on every PARENTED notice, not only a standing watch's, and it has a threshold.** `noticeStalenessNote` gates on `parent_timer_id !== null` alone, so since todo 322 parent-linked the modal-hold, unsubmitted-input, and one-shot-block notices too, it rides on those on a late delivery exactly as it always did on a standing watch's finish notice. It says how long the notice was held, and it prints only past the conversation hold's own TTL, collapsing to ONE clause unless the content was refreshed that long after the hold began. Do not make it unconditional again: on a one-second hold it was 138 characters onto a 72-character notice, stating the same timestamp and the same age twice. Do not fix its length by truncating it either - a genuinely long hold needs it in full.

**A THIRD generated lead-bound notice exists, and it is the janitor's, not a wake's.** When the
sweep closes a running `kind='command'` row whose pane is gone, it files one notice naming that
process and the command that restarts it (`reportDeadProcess`, `src/scheduler.ts`). It is the same
"never mint a notice hive could not deliver" guard as the other two: no live lead pane, no notice.
It is PARENTLESS for the same reason `ageOutNotice`'s replacement is - nothing should be able to age
out a report of something that already happened - and it carries no staleness trailer for the same
reason. **What makes it mean "died on its own" is a STOPPING MARKER, not an ordering**: a deliberate
stop writes a short-lived `stopping:<agent id>` kv row before it touches the pane (`stopProcess`,
`src/processes.ts`), and the sweep skips a swept command row whose marker is still live. An ordering
was tried first and could not carry it - a stop interrupted between the two writes is a swept row
like any other, and reporting it as a crash was the smaller half of that bug.

**This rule is about WAKE BODIES and nothing else.** `agent_send`'s `text` is a separate channel with its own, differently-shaped shortening for lead-bound messages; do not read either rule as governing the other (`.claude/rules/tmux-and-panes.md`).

**`[hive:%` and `[hive wake #` are excluded from `conversationHoldsWake`.** Sender tags now mark every `agent_send` text delivery, and the extracted prompt is checked at offset 0, so worker messages do not count as human conversation. Wake bodies keep their separate `[hive wake #` marker.

**A delivery into a BUSY pane may not be confirmed, so `unconfirmed` does not mean undelivered.** Do not read that as a failure and do not build anything that waits for a late confirmation. Mechanism and its measurements: `.claude/skills/hive-internals/references/tmux-and-panes.md`.

## A standing watch reports its owner's crew only, and a lead-bound wake can hold for an active conversation

`OWNED_BY_WATCH` excludes a grandchild an owner never dispatched itself, except on the blocked/stalled path, which stays unfiltered on purpose. A lead-bound wake held for a live human conversation (`HELD_REASON_CONVERSATION`) measures its own ceiling against `due_at`, never `first_held_at` - the latter is cleared by an ordinary `hive lead` reattach and would silently launder the ceiling. Rationale, the measured TTLs, and the reattach bug: `.claude/skills/hive-internals/references/worker-state.md`.

See `.claude/skills/hive-internals` for the six incidents and the measurements behind these.
