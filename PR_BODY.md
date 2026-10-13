## Summary

- Hold a due wake for a Claude lead while its fresh pane has no input box, for up to 60 seconds.
- Skip delivery for that tick when a Claude lead's input-box capture fails during the same 60-second window. After it expires, treat the failed capture as an absent box and preserve delivery.
- Keep Codex leads on the current delivery path, and do not replay unconfirmed PTY wakes.

The nullable `agents.pane_started_at` column is set in the same UPDATE that records a new pane. A `/clear` or pane adopt does not renew that timestamp.

## Tests

- Test 4a was RED on the unmodified build at the then-current `test/wake-fresh-lead-input-box.test.mjs:72:12`, where the missing boot hold left `held_at` null.
- After review, the no-SessionStart case was RED on the current branch at the then-current `test/wake-fresh-lead-input-box.test.mjs:109:12`, where the pane-creation event was ignored.
- `node --test test/wake-fresh-lead-input-box.test.mjs`: 5 passed, including capture failure inside and outside the boot window.
- Scheduler and wake-delivery scoped tests: 75 passed.
- Lead layout and restart tests: 42 passed.
- `node --test test/migrations-append-only.test.mjs test/migrations-forward.test.mjs`: 13 passed.
- `node --test test/docs.test.mjs`: 40 passed.
- The full-suite count and worktree log path are recorded on todo 1879.
