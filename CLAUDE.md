# CLAUDE.md

## What this is

hive is an MCP server plus CLI that gives multiple Claude Code sessions one shared, project-scoped state store: pads, todos with blockers, kv, leases, tmux-backed worker agents, and scheduled wake-ups. Every session runs its own server instance over stdio; all instances share one WAL-mode SQLite database (default `~/.hive/hive.db`). There is no daemon and nothing leaves the machine.

## Commands

```bash
npm run build     # compile to dist/ (required before anything runs)
npm run watch     # compile on change
hive setup        # re-pin the hive command to the interpreter that built dist/
hive doctor       # environment check + stale-state sweep
```

`npm test` runs the suite (`test/*.test.mjs`, node:test) against the built `dist/`, so build first. Tests spawn real MCP server and CLI processes with `HIVE_DATA_DIR` and `TMUX_TMPDIR` pointed at scratch directories. Two guards enforce that rather than asking you to remember it, and the invariant below says what they are and what they do not cover. CI runs the same on macOS (`.github/workflows/ci.yml`). For ad-hoc poking, pipe JSON-RPC lines to `node dist/index.js` the same way; MCP handles piped requests concurrently, so drive dependent calls sequentially (wait for each response before sending the next).

## Architecture

| Path | Role |
|---|---|
| `src/index.ts` | MCP server entry: registers tools, starts the scheduler |
| `src/cli.ts` | `hive` CLI: lead, attach, start, status, setup, doctor |
| `src/db.ts` | SQLite open + append-only `MIGRATIONS` array |
| `src/abi.ts` | Loads the native addon before the store opens; names an interpreter mismatch |
| `src/dispatcher.ts` | Writes and reads the pinned `hive` shim; PATH resolution |
| `src/mcpConfig.ts` | Reads Claude Code's MCP registrations (`~/.claude.json`, `.mcp.json`) |
| `src/context.ts` | Actor identity and project scope resolution |
| `src/tools/*.ts` | MCP tools by group: meta, pads, todos, kv, leases, agents, wakes |
| `src/scheduler.ts` | Wake-up firer + janitor; runs unref'd inside every instance |
| `src/tmux.ts` | tmux wrapper; the PTY is the agent message bus |
| `src/hook.ts`, `src/hooks.ts` | Claude Code hooks reporting exact worker state |
| `src/projectYml.ts` | `hive.yml` parsing, validation, and trust hashing |

Key mechanics: workers are CLI agents in tmux panes/windows; `agent_send` types into their terminals and `agent_output` reads the rendered screen. Wake-ups deliver by typing their body into the target pane as a fresh user turn. Worker state (working/idle/waiting) comes from Claude Code hooks writing directly to the database, keyed by `HIVE_AGENT_ID`.

## Invariants

- **Strict project scoping.** State resolves from the working directory; git worktrees and subdirectories resolve to the primary checkout's project. Never fall back to an unrelated project. Cross-project access happens only when the user explicitly asks; `HIVE_PROJECT_LOCK=1` disables it entirely and every spawned worker gets it.
- **Migrations are append-only.** Never edit an existing entry in `MIGRATIONS`; add a new one.
- **Untrusted `hive.yml` commands never run.** Trust is recorded per config hash; any change to a command re-requires interactive approval. `dir` cannot escape the project root and `profile` cannot escape the profile directories. The gate covers what hive *executes*.
- **`hive.yml` `vars` are rendered into system prompts without a gate, deliberately.** They reach the lead's posture and every worker's brief. That is repo-controlled text promoted to system-prompt authority, which is a real escalation over `CLAUDE.md` (a user message), and it was gated for one release before being removed as friction that outweighed its value for a single-user tool. Two things make that defensible and both must stay true: Claude Code's own workspace trust already governs the wider channel, and hive is not a defense against opening a hostile checkout. If hive ever ships to people who clone each other's repos, reinstate the gate rather than rediscovering the reasoning: see `git log -- src/trust.ts`. Until then, read a cloned `hive.yml` the way you would read that repo's `CLAUDE.md`.
- **Write tools return slim receipts.** Keep responses minimal; token cost is a design input.
- **Concurrency is guarded, not assumed.** Pad writes take `expected_revision`; leases and kv TTLs expire on their own; wake-up claims are atomic conditional updates so concurrent scheduler instances never double-fire.
- **The scheduler must never throw and must stay `unref()`'d**, or orphaned server processes linger after their session closes.
- **tmux aliveness checks use `list-panes`.** `display-message -t` silently falls back to a default target when the given one is dead.
- **tmux session names are namespaced by data store.** Project ids are SQLite row ids, unique only within one store, but tmux session names share one machine-wide namespace. So `sessionName()` tags the name when `HIVE_DATA_DIR` is not the default (`src/dataDir.ts`), and the default store keeps the documented `hive-<project_id>`. Never derive a session name from a project id alone: a scratch store numbers its first project 1 too, and would resolve to the live session of whatever real project is id 1.
- **The data dir is read at call time and cached in exactly one place.** `src/dataDir.ts` used to hold it in a module-level `const`, which resolved it once at that module's first load. On 2026-07-28 a static `import` of a `dist/` module at the top of `test/helpers.mjs` was hoisted above the line setting `HIVE_DATA_DIR`, so the const had already taken `~/.hive`, `dist/db.js` agreed with it, and the suite's `DELETE FROM timers; DELETE FROM agents;` destroyed every one of those rows in the developer's live store. `src/dataDir.ts` now reads the env when asked and caches nothing, so importing a module no longer decides the store for a process that has not opened one. Be precise about what that does not fix: `src/db.ts` still opens the database in its module body, so importing `db.js` is still itself the act of choosing a store. That is the remaining debt, and the guard below is what covers it. `db.ts` keeping a `const` is fine because it only writes down a commitment the module already made; the unguarded resolver in `dataDir.ts` is deliberately not exported, since it is `storeDir()` with the refusal removed.
- **Test isolation is enforced, not conventional.** This file used to assert "real data stays untouched", which was a convention held up by every author remembering a rule, and it was false on the day it mattered. Two guards hold it up now and both must stay. `storeDir()` refuses `~/.hive` outright when a test runner is the entry point, keyed on `NODE_TEST_CONTEXT`, which is an env var and so crosses into every process the suite spawns; a file that never sets `HIVE_DATA_DIR` fails loudly instead of writing to a live store. It throws for mid-command callers, and `db.ts` uses `guardStoreDir()` instead, which prints and exits for the same reason `guardAbi()` does: a throw out of an ESM module body arrives as a stack trace with hive's sentence buried in it. `test/suite-isolation.test.mjs` reads the suite's own source and fails when a file that can reach tmux does not call `isolateTmux()` at module top level. What neither covers: they cannot tell one scratch directory from another, so `assertScratchStore()` still earns its place in a destructive file. Naming goes through the same guard: `dataDirTag()` is `tagFor(storeDir())`. It was exempt for one commit on the grounds that building a string touches no disk, which answered the wrong question, since a session name is the target argument for `kill-session` and `respawn-pane`. `sessionName(1)` under a test runner with no `HIVE_DATA_DIR` returned `hive-1`, the live session of whatever real project is id 1, and `agent_close` would have killed it with its workers inside. `tagFor(dir)` is the pure half, for a caller that genuinely means a named directory rather than this process's store. `test/store-isolation.test.mjs` reproduces the original mistake and pins all of it.
- **Wake-up bodies are delivered verbatim** into a terminal as a user turn. Keep them plain English and self-contained (ids, context, next action).

## Gotchas

- `better-sqlite3` needs its native build approved once: `npm approve-scripts better-sqlite3`.
- **The `better-sqlite3` addon is ABI-locked to the interpreter that built it**, and `require("better-sqlite3")` does NOT load it: the binding loads lazily inside `new Database()`. A passing require proves nothing about whether hive can run, which is how an interpreter that could not open the store once got recommended as a fix. To test an interpreter, open a database or call `checkAbi()` in `src/abi.ts`, which loads the addon itself. `db.ts` calls `guardAbi()` on the line above `new Database`, so a mismatch is a sentence naming both `NODE_MODULE_VERSION`s instead of an `ERR_DLOPEN_FAILED` stack trace thrown out of an import, where nothing downstream can catch it. Keep that call there.
- **hive pins its interpreter on purpose.** `hive setup` writes a dispatcher that execs the CLI under `process.execPath` as it stood at setup time, which is the Node that built the addon, so the pin and the ABI cannot disagree. Never write a literal path. Anything that rebuilds must re-pin: `npm install && npm run build && hive setup`.
- iTerm profile commands (used by auto-attach) run with no shell and a minimal PATH: embed absolute binary paths in AppleScript strings.
- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings.
- All process execution goes through `execFileSync` with argument arrays (see `tmux()` in `src/tmux.ts`); never build shell command strings from data.
- **Never run `tmux kill-server` from tests or scripts.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>` instead. Code under test resolves its server from the env, so a test cannot pin one with `-L`; isolate with `isolateTmux()` from `test/helpers.mjs`, which sets `TMUX_TMPDIR` and clears `TMUX`/`TMUX_PANE`. Call it at module top level: every hive command can reach the server (`hive status` and `hive doctor` both run the janitor, which probes it), so any file that spawns hive needs it, and `test/suite-isolation.test.mjs` fails the ones that skip it.
