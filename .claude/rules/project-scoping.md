---
paths:
  - "src/context.ts"
  - "src/spawn.ts"
  - "src/tools/agents.ts"
  - "src/leadMessage.ts"
---

# Project scoping, and why a worker's files and its store are separate questions

## Accepted residuals

All three are real and deliberately unfixed. Do not rediscover any of them as a defect.

- **The refusal only fires when B is ALREADY REGISTERED**.
- **Nothing stops a running worker from `cd`-ing into another repo through Bash.**
- **`agent_message_get` reads message EXISTENCE across projects, with no project filter** (`classifyMiss`, `src/leadMessage.ts`). It is what lets a lookup tell a scoping refusal from an expiry instead of answering "not found" to both. No content crosses: the branch returns a refusal naming neither the text nor the owning project.
- **A foreign worktree nested inside a registered project crosses silently.** The fix, if the trigger below ever fires, is to surface the crossing rather than to change what it resolves to.

What would change the answer: the first worktree of something other than hive.

**A caller that needs the FILES question must not reach for containment resolution, and there is now a function for it.** Use `linkedWorktreePrimaryRoot` (`src/context.ts`) instead, which asks git directly and has no containment in it.

`HIVE_PROJECT_LOCK=1` disables cross-project access entirely, and every spawned worker gets it.

See `.claude/skills/hive-internals` for the mechanics, examples, and measurements behind these.
