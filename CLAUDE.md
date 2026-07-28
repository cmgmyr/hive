# CLAUDE.md

## What this is

hive is an MCP server plus CLI that gives multiple Claude Code sessions one shared, project-scoped state store: pads, todos with blockers, kv, leases, tmux-backed worker agents, and scheduled wake-ups. Every session runs its own server instance over stdio; all instances share one WAL-mode SQLite database (default `~/.hive/hive.db`). There is no daemon and nothing leaves the machine.

## Commands

```bash
npm run build     # compile to dist/ (required before anything runs)
npm run watch     # compile on change
hive doctor      # environment check + stale-state sweep
```

`npm test` runs the suite (`test/*.test.mjs`, node:test) against the built `dist/`, so build first. Tests spawn real MCP server and CLI processes with `HIVE_DATA_DIR` pointed at scratch directories; real data stays untouched. CI runs the same on macOS (`.github/workflows/ci.yml`). For ad-hoc poking, pipe JSON-RPC lines to `node dist/index.js` the same way; MCP handles piped requests concurrently, so drive dependent calls sequentially (wait for each response before sending the next).

## Architecture

| Path | Role |
|---|---|
| `src/index.ts` | MCP server entry: registers tools, starts the scheduler |
| `src/cli.ts` | `hive` CLI: lead, attach, start, status, doctor |
| `src/db.ts` | SQLite open + append-only `MIGRATIONS` array |
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
- **Untrusted `hive.yml` content never runs and never reaches a system prompt.** Trust is recorded per config hash; any change re-requires interactive approval. `dir` cannot escape the project root, `profile` cannot escape the profile directories, and `vars` are held back from posture and worker briefs until approved (`src/trust.ts`). The rule is the delivery, not the key: anything repo-controlled that steers a shell or a model gets the same gate.
- **Write tools return slim receipts.** Keep responses minimal; token cost is a design input.
- **Concurrency is guarded, not assumed.** Pad writes take `expected_revision`; leases and kv TTLs expire on their own; wake-up claims are atomic conditional updates so concurrent scheduler instances never double-fire.
- **The scheduler must never throw and must stay `unref()`'d**, or orphaned server processes linger after their session closes.
- **tmux aliveness checks use `list-panes`.** `display-message -t` silently falls back to a default target when the given one is dead.
- **tmux session names are namespaced by data store.** Project ids are SQLite row ids, unique only within one store, but tmux session names share one machine-wide namespace. So `sessionName()` tags the name when `HIVE_DATA_DIR` is not the default (`src/dataDir.ts`), and the default store keeps the documented `hive-<project_id>`. Never derive a session name from a project id alone: a scratch store numbers its first project 1 too, and would resolve to the live session of whatever real project is id 1.
- **Wake-up bodies are delivered verbatim** into a terminal as a user turn. Keep them plain English and self-contained (ids, context, next action).

## Gotchas

- `better-sqlite3` needs its native build approved once: `npm approve-scripts better-sqlite3`.
- iTerm profile commands (used by auto-attach) run with no shell and a minimal PATH: embed absolute binary paths in AppleScript strings.
- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings.
- All process execution goes through `execFileSync` with argument arrays (see `tmux()` in `src/tmux.ts`); never build shell command strings from data.
- **Never run `tmux kill-server` from tests or scripts.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>` instead. Code under test resolves its server from the env, so a test cannot pin one with `-L`; isolate with `TMUX_TMPDIR` and clear `TMUX`/`TMUX_PANE` (see `test/layout.test.mjs`).
