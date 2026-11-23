# Synthetic usage limit fixtures

Every file in this directory is synthetic. The strings and field names are
composed from `findings-limit-fork-spike` revision 2, never captured from a
live Claude Code or Codex limit. The Codex snapshot combination remains an
inference at a real limit.

- `claude-stop-failure.json` uses spike A2's `rate_limit` StopFailure fields
  and the A1 session-limit reset text.
- `claude-quota-rejected.jsonl` uses spike A2's assistant `rate_limit`,
  `apiError`, `quotaLimits.status`, and `quotaLimits.resetsAt` field names.
- `claude-auto-wait.txt`, `claude-reset-forms.json`, and
  `claude-weekly-menu.txt` use spike A1/A3's quoted auto-wait, reset, and
  weekly-menu text.
- `codex-token-count-limited.jsonl` and `codex-token-count-warning.jsonl`
  use spike A2's `event_msg` / `token_count` / `rate_limits` envelope. The
  exhausted case is not evidence that Codex emits those values at a real
  limit.
- `codex-limit-curly.txt`, `codex-limit-ascii.txt`, and `codex-no-reset.txt`
  use spike A1's Codex error variants.
- `malformed-tail.jsonl` adds a deliberately incomplete final line around
  the spike A2 record shape.
