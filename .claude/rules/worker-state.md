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

## Three ways worker state has been wrong, and how each was closed

Same class each time: hive reported something it could not observe, or had the fact and did not say it plainly.

- **#28** (closed 2026-08-08): a state that could not be written. A worker blocked on a permission prompt could not be reported, because `waiting` was latched with nothing to clear it. `noteBlockedWatched` (`src/scheduler.ts`) closed it: when a watched agent's state is `waiting` it reads that agent's pane directly and tells the wake's owner if a dialog is up, instead of waiting on a state hive cannot observe. Mechanism and edge cases in `.claude/rules/tmux-and-panes.md`.
- **#38** (closed 2026-08-02): filed as "a turn that dies mid-response leaves the worker on `working` forever and `wake_when_idle` never fires." That framing did not survive contact with the code: `max_wait_seconds` (900s default) already timed the wake out before this issue was filed, so it was never true that the wake waits forever. The real gap was narrower - `watchedTail` already embedded the agent's state and its pane tail in the wake body, but not the interpretation, so a lead reading "state now: working" next to a dead pane had to already know to distrust it. The fix folds that interpretation into the wake body directly. The paragraph below is that diagnostic; it stays true and worth knowing even with the fix shipped, since recognizing the shape on sight is still the fast path.
- **#46** (closed 2026-07-31): no canary over the payload contract, so a field changing shape would not have been noticed at all. `test/payload-canary.test.mjs`, plus its committed corpus, is that canary now.

Spotting the pattern is still cheap: a worker whose last `agent_state_log` row is a `prompt|working` with no `stop` after it, whose pane shows an error and an empty input box, and whose branch has not moved. A `working` older than the lane's rhythm is suspicious; `working` is not self-evidently healthy. Recovery is to send it a message, and to tell it what state you found, because after an API error it does not reliably remember what it was doing.

## A debounce is not an inference

Both appeared in one lane and only one was legitimate. The notify branch asserted a fact it could not see: the input box has been quiet for sixty seconds, therefore the worker is finished. It was deleted for that. A dwell that waits for a state to stop changing and reports what it observed asserts nothing, is self-verifying, and can only make a wake late rather than early. If you write one, say in the code which kind it is, because the next reader cannot tell from the shape.

## Never set a /goal on a worker

A goal fires the Stop hook after every turn while immediately starting another, so hive records idle for a worker that never stopped. Nine consecutive false idles were measured on agent:53 in 50 seconds with no `prompt|working` between them. `agent_state_log` does not save you here: the rows are not corrupt, they are each briefly true and instantly stale. The lead has an agents row now (issue #27) and writes hook rows like any other actor, but stays safe because its hook writes no STATE row: `src/hook.ts`'s `agents.agent_state` UPDATE is scoped to `WHERE ... AND kind = 'agent'`, an allowlist rather than a lead-specific skip (so a future third kind defaults to the same silence, not to getting state written by accident), so this exact churn lands in `agent_state_log` only, where it is harmless and best-effort forensics rather than a false idle something else acts on.

## Wake-up bodies are delivered verbatim into a terminal

Whatever you pass as a wake body is typed into the target pane exactly as written, and it becomes a fresh user turn only if that pane happens to be idle. So write it as plain English that stands on its own: the ids it refers to, the context needed to act, and the next action.

The failure this prevents is a body that only parses as a reply. "Yes, go ahead with option 2" is unreadable when it lands mid-turn hours later next to work that has moved on, and there is no thread for the reader to scroll back to. Assume the reader has none of the conversation that produced the wake, because usually it does not.

**A delivery into a BUSY pane can never be confirmed, so `unconfirmed` does not mean undelivered.** The text is absorbed into the turn already running, no `UserPromptSubmit` fires, and `confirmed_at` can never be set for it. Do not read that as a failure and do not build anything that waits for a late confirmation. The mechanism, and the two paths where a wake genuinely never fires, are in `.claude/rules/tmux-and-panes.md`: a pane sitting on a dialog, and a pane holding unsubmitted human text. Both hold past `max_wait_at`, and the second was added deliberately - delivery pastes and presses Enter, so a box with text already in it would submit the wake merged with whatever the human was typing.
