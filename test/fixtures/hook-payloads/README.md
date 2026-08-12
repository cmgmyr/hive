# Hook payload fixtures

Issue #32, half E. Real Claude Code hook payloads, read out of
`agent_state_log` on the live store (`~/.hive/hive.db`, read-only, never
written to or pointed at by a test) and copied byte-for-byte into these files.
None of these were typed or composed by hand; hand-writing a fixture from
documentation is exactly what issue #32 warns produces an untrustworthy
corpus. Captured from Claude Code 2.1.220 on 2026-07-29 and 2026-07-30. Source
rows: `agent_state_log` ids 1, 2, 3, 4, 9, 33. One later capture, from Claude
Code 2.1.228 on 2026-08-12: `prompt-spawn-announcement.json`, source row id
4105, the announcement `agent_spawn` typed into todo 373's own worker.

If a payload needs to change (a local path, a session id), it must be
RE-CAPTURED from a live run, never hand-edited. See the same rule in
`test/fixtures/panes/README.md`; a captured fixture is trustworthy only
because nothing about it was typed by hand, and editing bytes after capture
throws that away.

- `prompt-user.json` — `UserPromptSubmit` for an ordinary user message.
- `prompt-spawn-announcement.json` — `UserPromptSubmit` for the `[hive]` line
  `agent_spawn` types into a brand-new worker's pane and submits. Same event
  name and same decision (`working`) as the plain prompt, and the reason it is
  its own fixture is what hive does NOT do with it: this is the one prompt that
  must not clear a worker's "started, and not yet given anything" latch
  (`src/firstPrompt.ts`, todo 373). Captured because a hand-written copy of
  hive's own line would pin the format against itself rather than against a
  real spawn.
- `prompt-task-notification.json` — `UserPromptSubmit` for a task-notification
  a finished background subagent injects into its parent. Same event name and
  same decision (`working`) as the plain prompt; kept as a separate fixture
  because it is the shape that actually drives the self-healing property
  `src/hook.ts` documents for `waitingOnSubagents`, not because the assertion
  differs.
- `stop-subagents-running.json` — `Stop` with four live `background_tasks`
  entries, all `type: "subagent"`, `status: "running"`. Decides `working`.
- `stop-idle.json` — `Stop` with `background_tasks: []`. Decides `idle`.
- `notify-idle-prompt.json` — `Notification`, `notification_type:
  "idle_prompt"`. Decides nothing (`stateFor` returns `null`); the row it
  produces is logged as `unchanged`.
- `notify-permission-prompt.json` — `Notification`, `notification_type:
  "permission_prompt"`. Decides `waiting`.

## What this corpus does not cover, on purpose

Every captured `Stop` payload carries `session_crons`, and every observed
value is `[]`; nothing scheduled a cron on 2026-07-29 or 2026-07-30. Issue #32
notes that `waitingOnSubagents` does not look at that field at all, so a
`Stop` with an empty `background_tasks` and a pending cron would still decide
`idle`, which is the #24 shape again. That case has never been observed, so
it is not a fixture here. An invented payload asserting invented behaviour
would be worse than no fixture: it would assert what someone guessed
`stateFor` should do, not what it was proven to do against a real payload.

`notification_type` has only ever been observed as `idle_prompt` and
`permission_prompt`. `elicitation_complete`, named in issue #32 as a concern,
has never been observed either and is not a fixture for the same reason.

No `background_tasks` entry has ever been observed with `type: "shell"` or
with a terminal `status` (`completed`, `failed`, etc.); entries seem to be
removed from the array rather than marked terminal. Not fixtured, same reason.

This corpus is a net under the canary (issue #32's half D, carried forward as
issue #46), never a substitute for it: it proves `stateFor` handles the
payloads listed above and says nothing about any payload Claude Code has not
yet been observed sending. See the header comment in
`test/hook-replay.test.mjs`.

## What answers the three questions above

`scripts/payload-shape.mjs` (issue #46) derives KNOWN and REQUIRED field
paths, plus enum values, from this corpus at runtime, and
`scripts/payload-canary.mjs` diffs a real, live run's hook payloads against
that derivation. Both are shape-only: neither asserts what `stateFor` decides,
only whether Claude Code is still sending what this corpus recorded.

`notification_type`, `background_tasks[].type` and `background_tasks[].status`
are the canary's discriminator paths. The moment a real `Notification` payload
carries `notification_type: "elicitation_complete"`, or a real `Stop` payload
carries a `background_tasks` entry with `type: "shell"` or a terminal
`status`, the canary FAILS loudly with the exact value observed, and that
finding is a fixture waiting to be captured. Neither question is answered yet;
both now have a live tripwire instead of a doc comment.

`session_crons` sits outside the discriminator list, so a populated cron does
not FAIL the canary. Its first non-empty entry will still surface as an INFO
finding (a field never seen inside `session_crons` before), which is how this
corpus is meant to grow: capture that run's payload as a new fixture, and the
`waitingOnSubagents` question issue #32 raised for it becomes something
`test/hook-replay.test.mjs` can assert on directly, with a real payload behind
it instead of an invented one.
