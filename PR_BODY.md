## Summary

- Hold a due wake for a Claude lead while its fresh startup session has no input box, for up to 60 seconds.
- Skip delivery for that tick if the Claude lead's input-box capture fails.
- Keep Codex leads on the current delivery path, and do not replay unconfirmed PTY wakes.

`cmdLead` records a `lead_pane_start` event when it records a new pane, before the SessionStart hook can run. A `/clear` event does not renew that timestamp.

## Tests

- Test 4a was RED on the unmodified build at the then-current `test/wake-fresh-lead-input-box.test.mjs:72:12`, where the missing boot hold left `held_at` null.
- After review, the no-SessionStart case was RED on the current branch at the then-current `test/wake-fresh-lead-input-box.test.mjs:109:12`, where the pane-creation event was ignored.
- `node --test test/wake-fresh-lead-input-box.test.mjs`: 4 passed.
- Scheduler and wake-delivery scoped tests: 75 passed.
- Lead layout and restart tests: 42 passed.
- `node --test test/docs.test.mjs`: 40 passed.
- The full-suite count and worktree log path are recorded on todo 1879.
