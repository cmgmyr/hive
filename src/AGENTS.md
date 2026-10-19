# src/AGENTS.md

This file exists for agents that read `AGENTS.md` and have no path-scoped rule mechanism. Codex is the one that matters here, because it reviews and edits this directory like any other harness.

Claude Code gets these automatically: `.claude/rules/*.md` declare `paths:` globs and are injected when a matching file is opened, and the `hive-internals` skill loads the evidence behind each rule on invoke. Neither mechanism exists for codex, so open both files by hand.

**Read the rule that matches the file you are changing before you review or edit it, and open its reference for the why.**

| Rule | Fires on | Reference |
|---|---|---|
| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts`, `src/agentRecords.ts`, `src/wakeTarget.ts`, `src/cli.ts`, `src/crew.ts`, `src/leadMessage.ts`, `src/leadMessageDelivery.ts`, `src/leaseStore.ts`, `src/harnesses.ts`, `src/processes.ts`, `src/leadHandoffCli.ts`, `src/leadHandoff.ts`, `src/portfolio.ts`, `src/projectRemove.ts`, `scripts/restart-lead.sh` | `.claude/skills/hive-internals/references/tmux-and-panes.md` |
| `.claude/rules/store-and-datadir.md` | `src/dataDir.ts`, `src/db.ts`, `src/leaseStore.ts`, `src/backup.ts`, `src/teardown.ts`, `src/result.ts`, `src/scheduler.ts`, `src/config.ts`, `src/globalConfig.ts`, `src/leadHandoffState.ts` | `.claude/skills/hive-internals/references/store-and-datadir.md` |
| `.claude/rules/worker-state.md` | `src/hook.ts`, `src/backgroundTasks.ts`, `src/claudeWake.ts`, `src/hooks.ts`, `src/scheduler.ts`, `src/tools/wakes.ts`, `src/wakeTarget.ts`, `src/wakeSql.ts`, `src/firstPrompt.ts`, `src/dashboard.ts`, `src/crew.ts`, `src/processes.ts`, `src/leadState.ts`, `src/leadWatch.ts`, `src/leadMessageDelivery.ts`, `src/leadMessage.ts`, `src/leadHandoffState.ts`, `src/leadHandoff.ts`, `src/stateProvenance.ts`, `src/portfolio.ts` | `.claude/skills/hive-internals/references/worker-state.md` |
| `.claude/rules/native-addon.md` | `src/abi.ts`, `src/abiProbe.ts`, `src/sessionProbe.ts`, `src/db.ts`, `src/dispatcher.ts`, `package.json` | `.claude/skills/hive-internals/references/native-addon.md` |
| `.claude/rules/tool-contract.md` | `src/tools/*.ts`, `src/cli.ts`, `src/help.ts`, `src/context.ts`, `src/strictInput.ts` | `.claude/skills/hive-internals/references/tool-contract.md` |
| `.claude/rules/project-scoping.md` | `src/context.ts`, `src/queenAuditStore.ts`, `src/spawn.ts`, `src/tools/agents.ts`, `src/agentRecords.ts`, `src/wakeTarget.ts`, `src/leadMessage.ts` | `.claude/skills/hive-internals/references/project-scoping.md` |
| `.claude/rules/profile-files.md` | `src/profiles.ts` | `.claude/skills/hive-internals/references/profile-files.md` |

Every rule but `tool-contract.md` is enforced by code and pinned by a test. `tool-contract.md` is a naming convention and a matrix, not a guard; `docs.test.mjs` pins only that it exists, its globs still match, and it stays indexed, not that its content agrees with the code. Its unknown-key section is the one exception: `test/wire-surface.test.mjs` asserts `additionalProperties: false` over the generated surface, so that section documents a guard. A suggestion that contradicts one is not a finding unless it engages with the recorded reasoning and shows a concrete failure it misses. The project's own rule: do not remove a guard because its reasoning is not in the file you happen to be reading.

The always-true invariants, the architecture map, and the commands are in the repo root `AGENTS.md`.
