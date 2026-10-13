## Summary

- Hold a due wake for a Claude lead while its fresh startup session has no input box, for up to 60 seconds.
- Skip delivery for that tick if the Claude lead's input-box capture fails.
- Keep Codex leads on the current delivery path, and do not replay unconfirmed PTY wakes.

The boot window comes from the latest `session_start` event whose source is `startup`. A `/clear` event does not renew it.

## Tests

- Test 4a was RED on the unmodified build at the then-current `test/wake-fresh-lead-input-box.test.mjs:72:12`, where the missing boot hold left `held_at` null.
- `node --test test/wake-fresh-lead-input-box.test.mjs`: 4 passed.
- Scheduler and wake-delivery scoped tests: 75 passed.
- `node --test test/docs.test.mjs`: 40 passed.
- The full-suite count and worktree log path are recorded on todo 1879.
