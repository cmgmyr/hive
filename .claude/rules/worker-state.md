---
paths:
  - "src/hook.ts"
  - "src/hooks.ts"
  - "src/scheduler.ts"
  - "src/tools/wakes.ts"
  - "src/firstPrompt.ts"
  - "src/dashboard.ts"
---

# Worker state, and why it has an append-only log

`agent_state_log` is append-only and the hook writes one row per invocation. Nothing updates a row and nothing deletes one except retention. Three things about it are load-bearing:

- **The `event` column.** Both #24 lanes reasoned from "an idle was written" to "`stateFor("stop")` wrote it" without checking, and the truth was that the notify branch wrote it. One column answers that at a glance.
- **The payload is stored raw and unredacted.** A projection can only preserve fields someone already knew mattered.
- **The log write sits AFTER the state write, in its own try/catch, never sharing a transaction.** The state write is what wakes and `agent_status` depend on, so a log that cannot be written must cost the diagnosis, never the behaviour.

Assert over the SEQUENCE in this table, never over a sample of `agent_state`, or the test has the blind spot the table exists to remove.

## Enumerate every path that can write the value, before picking one

Any time you have "the system recorded X", the first question is which writer wrote it, not why the writer you have in mind would have.

## Rules left behind by five incidents where worker state read wrong

A `working` older than the lane's rhythm is suspicious; `working` is not self-evidently healthy.

- A latch may decide whether to LOOK, never what is true. Deciding to STAY QUIET is the safe direction of the same rule.
- If you ever add a second reason to suppress a finish, every finish-suppressing rule has to be checked against every rule that reads "already reported" off the same column.
- An exclusion is only as durable as the column it reads, so when you add one, ask who else writes that column and what their failure paths put back.
- If `agents.resumed_at` SUPPRESSES, the `idle` gate covers you; if it REPORTS, ask whether the row has a state channel at all before you say anything about it.

**The reader list lives in `src/firstPrompt.ts` and is authoritative there, not here.** Count the badge sites, not the files.

## A debounce is not an inference

A dwell that waits for a state to stop changing and reports what it observed asserts nothing, is self-verifying, and can only make a wake late rather than early. If you write one, say in the code which kind it is, because the next reader cannot tell from the shape.

## Never set a /goal on a worker

A goal fires the Stop hook after every turn while immediately starting another, so hive records idle for a worker that never stopped.

## Wake-up bodies are delivered verbatim into a terminal

Whatever you pass as a wake body is typed into the target pane exactly as written, and it becomes a fresh user turn only if that pane happens to be idle. So write it as plain English that stands on its own: the ids it refers to, the context needed to act, and the next action.

**A delivery into a BUSY pane can never be confirmed, so `unconfirmed` does not mean undelivered.** Do not read that as a failure and do not build anything that waits for a late confirmation.

See `.claude/skills/hive-internals` for the five incidents and the measurements behind these.
