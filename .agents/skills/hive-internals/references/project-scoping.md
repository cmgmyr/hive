`CLAUDE.md` carries the prohibition (state resolves from the working directory, never fall back to an unrelated project, cross-project access only when the user asks). This file carries the mechanics, because they are only actionable once you are editing one of the files above.

## Where a worker's files are, whose store records its work, and where its pane appears are three different questions

Keeping them separable is deliberate, not an oversight to tidy up.

The files come from `cwd`. The store comes from the worker's own `agents` row, read back by `agentProjectPin` in `src/context.ts`, **and the row beats `cwd` on purpose.** The pane, for a split-placed worker, comes from a third lookup: `parent_actor_id` on that same row, resolved to the spawning lead's own pane and its window (`splitTargetWindow`, `src/spawn.ts`; `.claude/rules/tmux-and-panes.md`).

So a lead in project A can send a worker into project B's checkout and keep orchestrating it from A. That is the point rather than a side effect: B's lead may not be running, and the lead that dispatched the work is the one that has to review it. The pane follows the same logic one layer further: that worker's row records project B, but its pane lands in project A's window, next to the lead that spawned it, because "the worker's project's window" is the exact popping-out behaviour this design exists to stop, which is why hive's tmux topology is windows inside one session rather than a session per project. A worker's project id is never where you'd look to predict which window its pane is in.

## The crossing is refused, and it has to be a refusal rather than a prompt

`agent_spawn` refuses that crossing unless you pass `project_id` for the cwd's project deliberately (`src/tools/agents.ts`). That refusal is where "ask before any work starts" lives.

It cannot be a prompt: an MCP server has no channel to a human. It surfaces in the lead's session, which is where one is sitting.

## When you do cross, write a todo into the other project

`todo_create(project_id: <B>)`, which a lead can do because leads are never locked. Nothing else tells B that anything touched its repo. If B's lead is running you now have two leads on one checkout with nothing between them, and the todo is the only thing that makes that discoverable.

## Accepted residuals

All three are real and deliberately unfixed. Do not rediscover any of them as a defect.

- **The refusal only fires when B is ALREADY REGISTERED**, since `findProjectForDir` never registers a project it has not seen.
- **Nothing stops a running worker from `cd`-ing into another repo through Bash.** That happens outside hive entirely, and it is the same class as the `agent_send` `keys` residual in `.claude/rules/tmux-and-panes.md`: a path deliberately left unguarded because guarding it would cost more than it buys.
- **A foreign worktree nested inside a registered project crosses silently.** Containment (`src/context.ts`'s `gitPrimaryRoot` logic) picks a project for a nested worktree of an unrelated repo and writes to that store without saying so - unlike the deliberate cross-project path above, which refuses and makes the caller pass `project_id`. Accepted because containment is the only principled tie-breaker available across trees and it has never fired here: every worktree in use is of hive itself, where `gitPrimaryRoot` resolves to an ancestor and the answer is the same either way. The fix, if the trigger below ever fires, is to surface the crossing rather than to change what it resolves to.

What would change the answer: the first worktree of something other than hive.

**A caller that needs the FILES question must not reach for containment resolution, and there is now a function for it.** The residual above is about which STORE a nested foreign worktree resolves to, and it stays accepted. But `findProjectForDir` is containment-aware by design, so a caller asking "which repository do this directory's files actually belong to" gets the containing project rather than the answer it wanted - true in exactly the case it needed to catch. Measured: `agent_spawn`'s worktree-install notice, keyed on `findProjectForDir(cwd)?.id === project.id`, would have printed hive's own install command for a linked worktree of an unrelated repo nested inside this checkout. Use `linkedWorktreePrimaryRoot` (`src/context.ts`) instead, which asks git directly and has no containment in it. This is the split CLAUDE.md states as an invariant - files come from `cwd`, the store comes from the project row - arriving as two different functions rather than one.

`HIVE_PROJECT_LOCK=1` disables cross-project access entirely, and every spawned worker gets it.

## A codex worker's MCP server gets none of its pane's environment (todo 1404)

Claude Code starts a worker's MCP server with the pane's environment. Codex does not: its stdio launcher hands the server a fixed default set (HOME, PATH, LOGNAME, SHELL, TMPDIR, TZ, LC_ALL and the like) plus whatever `env` and `env_vars` name in config.toml, and its MCP docs (the `env` and `env_vars` keys) describe no other route. Until todo 1404 the generated config carried `HIVE_AGENT_ID` only, so `HIVE_PROJECT_LOCK`, `HIVE_PROJECT_PATH`, `HIVE_DATA_DIR` and `HIVE_AGENT_NAME` reached the pane and never the server.

Measured live (codex 0.157.1, scratch store, `HOME` pointed at a scratch directory so a leak could not reach `~/.hive`): a worker spawned into a git repo outside any project answered `whoami` with a project auto-created from its cwd, and that project was in `<HOME>/.hive/hive.db`, not in the store `agent_spawn` had used. So the defect had two faces: scope fell back to cwd, and a non-default store was silently swapped for the default one. `actor_name` was the bare actor id for the same reason.

The fix writes the pane's identity env into the server table (`mcpEnvTable`, `src/codexHome.ts`), and `agent_resume` rewrites it in the existing home (`refreshCodexMcpEnv`) because a home written at spawn can predate a rename or the fix itself. `env_vars` was considered and not used: it forwards from codex's own environment, which is the pane, so it would work, but a pre-fix home needs a rewrite on resume either way. A drop of `HIVE_AGENT_NAME` alone is invisible to `whoami` when the server shares the spawn's store (the actors row supplies the name), which is why `test/codex-park-resume.test.mjs` compares the config table to the resumed pane's own values instead.
