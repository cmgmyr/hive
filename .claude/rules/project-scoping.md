---
paths:
  - "src/context.ts"
  - "src/spawn.ts"
  - "src/tools/agents.ts"
---

# Project scoping, and why a worker's files and its store are separate questions

`CLAUDE.md` carries the prohibition (state resolves from the working directory, never fall back to an unrelated project, cross-project access only when the user asks). This file carries the mechanics, because they are only actionable once you are editing one of the files above.

## Where a worker's files are and whose store records its work are two different questions

Keeping them separable is deliberate, not an oversight to tidy up.

The files come from `cwd`. The store comes from the worker's own `agents` row, read back by `agentProjectPin` in `src/context.ts`, **and the row beats `cwd` on purpose.**

So a lead in project A can send a worker into project B's checkout and keep orchestrating it from A. That is the point rather than a side effect: B's lead may not be running, and the lead that dispatched the work is the one that has to review it.

## The crossing is refused, and it has to be a refusal rather than a prompt

`agent_spawn` refuses that crossing unless you pass `project_id` for the cwd's project deliberately (`src/tools/agents.ts`). That refusal is where "ask before any work starts" lives.

It cannot be a prompt: an MCP server has no channel to a human. It surfaces in the lead's session, which is where one is sitting.

## When you do cross, write a todo into the other project

`todo_create(project_id: <B>)`, which a lead can do because leads are never locked. Nothing else tells B that anything touched its repo. If B's lead is running you now have two leads on one checkout with nothing between them, and the todo is the only thing that makes that discoverable.

## Two accepted residuals

Both are real and deliberately unfixed. Do not rediscover either as a defect.

- **The refusal only fires when B is ALREADY REGISTERED**, since `findProjectForDir` never registers a project it has not seen.
- **Nothing stops a running worker from `cd`-ing into another repo through Bash.** That happens outside hive entirely, and it is the same class as the `agent_send` `keys` residual in `.claude/rules/tmux-and-panes.md`: a path deliberately left unguarded because guarding it would cost more than it buys.

`HIVE_PROJECT_LOCK=1` disables cross-project access entirely, and every spawned worker gets it.
