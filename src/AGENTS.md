# src/AGENTS.md

This file exists for agents that read `AGENTS.md` and have no path-scoped rule mechanism. Codex is the one that matters here, because it is a counselors review seat.

Claude Code gets these automatically: `.claude/rules/*.md` declare `paths:` globs and are injected when a matching file is opened. Nothing equivalent exists for codex, so the invariants that constrain this directory would otherwise be invisible to it.

**Read the rule that matches the file you are changing before you review or edit it.**

| Rule | Covers |
|---|---|
| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts`: why a private tmux server plus the default store is refused, session-name namespacing, the four paths that type into a pane and why one is deliberately unguarded |
| `.claude/rules/store-and-datadir.md` | `src/dataDir.ts`, `src/db.ts`, `src/backup.ts`, `src/result.ts`, `src/scheduler.ts`, `src/config.ts`: why the data dir is read at call time, the two guards that make test isolation structural, what a live restore does to open connections |
| `.claude/rules/worker-state.md` | `src/hook.ts`, `src/hooks.ts`, `src/scheduler.ts`, `src/tools/wakes.ts`: why `agent_state_log` is append-only and how to assert over it, the three open ways worker state is wrong |
| `.claude/rules/native-addon.md` | `src/abi.ts`, `src/db.ts`, `src/dispatcher.ts`, `package.json`: why a passing `require()` proves nothing, why hive pins its interpreter |
| `.claude/rules/tool-contract.md` | `src/tools/*.ts`, `src/cli.ts`, `src/help.ts`, `src/context.ts`: the verified lifecycle matrix and its accepted gaps, the naming convention for a new tool's verb, the CLI/MCP split and why it is mechanical, not stylistic |
| `.claude/rules/project-scoping.md` | `src/context.ts`, `src/spawn.ts`, `src/tools/agents.ts`: why a worker's files and its store are separate questions and the store wins, why `agent_spawn`'s cross-project refusal cannot be a prompt, the two accepted residuals |

Every rule but `tool-contract.md` is enforced by code and pinned by a test. `tool-contract.md` is a naming convention and a matrix, not a guard; `docs.test.mjs` pins only that it exists, its globs still match, and it stays indexed, not that its content agrees with the code. A suggestion that contradicts one is not a finding unless it engages with the recorded reasoning and shows a concrete failure it misses. The project's own rule: do not remove a guard because its reasoning is not in the file you happen to be reading.

The always-true invariants, the architecture map, and the commands are in the repo root `AGENTS.md`.
