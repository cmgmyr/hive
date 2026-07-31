---
paths:
  - "src/hook.ts"
  - "src/hooks.ts"
  - "src/scheduler.ts"
  - "src/tools/wakes.ts"
---

# Worker state, and why it has an append-only log

Worker state (working/idle/waiting) comes from Claude Code hooks writing directly to the database, keyed by `HIVE_AGENT_ID`. hive depends here on a payload contract it does not own, cannot see change, and pins no version of.

## A state that corrects itself still has to be readable afterwards

`agents.agent_state` is one row overwritten in place, so a wrong value replaced a second later leaves nothing behind. Issue #24 was closed on that basis and reopened the same day: a false `idle` was written at 13:27:39 and overwritten with `working` at 13:27:41, the lead sampled at 13:28, saw `working`, and recorded a PASS on a lane that had already failed. No polling frequency anyone would really run catches two seconds.

So `agent_state_log` is append-only and the hook writes one row per invocation. Nothing updates a row and nothing deletes one except retention. Three things about it are load-bearing:

- **The `event` column.** Both #24 lanes reasoned from "an idle was written" to "`stateFor("stop")` wrote it" without checking, and the truth was that the notify branch wrote it. One column answers that at a glance.
- **The payload is stored raw and unredacted.** The bug turned on `notification_type`, a field nothing in hive read. A projection can only preserve fields someone already knew mattered, which is the same incomplete-corpus failure wearing a disguise.
- **The log write sits AFTER the state write, in its own try/catch, never sharing a transaction.** The state write is what wakes and `agent_status` depend on, so a log that cannot be written must cost the diagnosis, never the behaviour.

Assert over the SEQUENCE in this table, never over a sample of `agent_state`, or the test has the blind spot the table exists to remove. A sample is not evidence about a state machine; an event record is.

Retention is `pruneStateLog()` in `tick()` rather than in the janitor, because the janitor returns early when the tmux probe fails and a machine can sit that way for days.

## Enumerate every path that can write the value, before picking one

Two full lanes of #24 reasoned from an observed value to a presumed writer and neither checked. Three lines of `stateFor` return `idle` and only one was ever under investigation. The first fix was correct and fixed a door the bug was not coming through; it shipped with 50 green tests and the bug reproduced the same morning.

Any time you have "the system recorded X", the first question is which writer wrote it, not why the writer you have in mind would have.

## Three known ways worker state is wrong today

All open, all the same class, and hive reports something it cannot observe:

- **#28**: a state that CANNOT be written. A worker blocked on a permission prompt cannot be reported, because "waiting" is latched and nothing clears it.
- **#38**: a state NEVER updated. A turn that dies mid-response leaves the worker on `working` forever and `wake_when_idle` never fires. Observed for 36 minutes after an API 529, caught only because a lead was polling.
- **#46**: no canary over the payload contract, so a field changing shape would not be noticed at all.

Spotting #38 is cheap: a worker whose last `agent_state_log` row is a `prompt|working` with no `stop` after it, whose pane shows an error and an empty input box, and whose branch has not moved. A `working` older than the lane's rhythm is suspicious; `working` is not self-evidently healthy. Recovery is to send it a message, and to tell it what state you found, because after an API error it does not reliably remember what it was doing.

## A debounce is not an inference

Both appeared in one lane and only one was legitimate. The notify branch asserted a fact it could not see: the input box has been quiet for sixty seconds, therefore the worker is finished. It was deleted for that. A dwell that waits for a state to stop changing and reports what it observed asserts nothing, is self-verifying, and can only make a wake late rather than early. If you write one, say in the code which kind it is, because the next reader cannot tell from the shape.

## Never set a /goal on a worker

A goal fires the Stop hook after every turn while immediately starting another, so hive records idle for a worker that never stopped. Nine consecutive false idles were measured on agent:53 in 50 seconds with no `prompt|working` between them. `agent_state_log` does not save you here: the rows are not corrupt, they are each briefly true and instantly stale. The lead is safe only because it writes no hook rows at all.
