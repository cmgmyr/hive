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

`npm test` runs the suite (`test/*.test.mjs`, node:test) against the built `dist/`, so build first. Tests spawn real MCP server and CLI processes against scratch directories; `test/CLAUDE.md` has the rules that keep them off the live store and off the developer's tmux server. CI runs the same on macOS (`.github/workflows/ci.yml`). For ad-hoc poking, pipe JSON-RPC lines to `node dist/index.js` the same way; MCP handles piped requests concurrently, so drive dependent calls sequentially.

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
| `src/backup.ts` | VACUUM INTO snapshots, retention, restore |

Key mechanics: workers are CLI agents in tmux panes/windows; `agent_send` types into their terminals and `agent_output` reads the rendered screen. Wake-ups deliver by typing their body into the target pane as a fresh user turn. Worker state (working/idle/waiting) comes from Claude Code hooks writing directly to the database, keyed by `HIVE_AGENT_ID`.

## Invariants

These hold everywhere and shape decisions before you have opened a file.

- **Strict project scoping.** State resolves from the working directory; git worktrees and subdirectories resolve to the primary checkout's project. Never fall back to an unrelated project. Cross-project access happens only when the user explicitly asks; `HIVE_PROJECT_LOCK=1` disables it entirely and every spawned worker gets it.
- **Migrations are append-only.** Never edit an existing entry in `MIGRATIONS`; add a new one.
- **Write tools return slim receipts.** Keep responses minimal; token cost is a design input. A slim receipt cannot confirm what it does not echo, so read a field back when it matters.
- **Concurrency is guarded, not assumed.** Pad writes take `expected_revision`; leases and kv TTLs expire on their own; wake-up claims are atomic conditional updates so concurrent scheduler instances never double-fire.
- **The scheduler must never throw and must stay `unref()`'d**, or orphaned server processes linger after their session closes.
- **Wake-up bodies are delivered verbatim** into a terminal as a user turn. Keep them plain English and self-contained (ids, context, next action).
- **All process execution goes through `execFileSync` with argument arrays** (`tmux()` in `src/tmux.ts`). Never build a shell command string from data.
- **Untrusted `hive.yml` commands never run.** Trust is recorded per config hash; any change to a command re-requires interactive approval. `dir` cannot escape the project root and `profile` cannot escape the profile directories. The gate covers what hive *executes*.
- **`hive.yml` `vars` reach system prompts with no gate, deliberately.** They land in the lead's posture and every worker's brief, so a repo controls text with system-prompt authority. That was gated for one release and the gate was removed as friction not worth it for a single-user tool. It holds only because Claude Code's own workspace trust governs the wider channel. If hive ever ships to people who clone each other's repos, reinstate it rather than re-deriving the argument: `git log -- src/trust.ts`. Until then, read a cloned `hive.yml` the way you would read that repo's `CLAUDE.md`.
- iTerm profile commands (used by auto-attach) run with no shell and a minimal PATH: embed absolute binary paths in AppleScript strings.

## The deeper invariants live next to the code they constrain

Each rule below is injected automatically when you open a file it covers, so you do not carry it the rest of the time. **Read one deliberately when you are planning work in its area**, because a rule fires on file access and planning happens before that.

| Rule | Fires on | Covers |
|---|---|---|
| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts` | why a private tmux server plus the default store is refused; session-name namespacing; the four paths that type into a pane and why one is deliberately unguarded |
| `.claude/rules/store-and-datadir.md` | `src/dataDir.ts`, `src/db.ts`, `src/backup.ts` | why the data dir is read at call time; the two guards that make test isolation structural; what a live restore does to open connections |
| `.claude/rules/worker-state.md` | `src/hook.ts`, `src/hooks.ts`, `src/scheduler.ts`, `src/tools/wakes.ts` | why `agent_state_log` is append-only and how to assert over it; the three open ways worker state is wrong; never set a /goal on a worker |
| `.claude/rules/native-addon.md` | `src/abi.ts`, `src/db.ts`, `src/dispatcher.ts`, `package.json` | why a passing `require()` proves nothing; why hive pins its interpreter |
| `test/CLAUDE.md` | anything under `test/` | suite isolation, and the false-green shapes that have shipped here |

Every one of them is enforced by code and pinned by a test. Do not remove a guard because its reasoning is not in this file.

Incident history and standing lessons that outlive a lane are in the project's `lessons` pad (`hive pad lessons`), not here.
