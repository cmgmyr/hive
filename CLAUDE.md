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

Curated, not exhaustive: the modules that shape decisions, not every file under `src/`. An absence here is not a gap to file; see `src/*.ts` for the full set.

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

Key mechanics: workers are CLI agents in tmux panes, driven by typing into their terminals and reading the rendered screen back. Wake-ups deliver the same way, and worker state comes from Claude Code hooks writing to the database. All three have sharp edges that are documented where they bite: `.claude/rules/tmux-and-panes.md` and `.claude/rules/worker-state.md`.

## Invariants

These hold everywhere and shape decisions before you have opened a file.

- **Strict project scoping.** State resolves from the working directory; git worktrees and subdirectories resolve to the primary checkout's project. Never fall back to an unrelated project. Cross-project access happens only when the user explicitly asks; `HIVE_PROJECT_LOCK=1` disables it entirely and every spawned worker gets it.
- **A worker's files and its store are separate questions, and the store wins.** Files come from `cwd`; the store comes from the worker's own `agents` row. So a lead can run a worker inside another project's checkout while still recording the work in its own. `agent_spawn` refuses that crossing unless you pass `project_id` deliberately, and when you do cross, write a todo into the other project so it knows. Mechanics, and the accepted residuals: `.claude/rules/project-scoping.md`.
- **Concurrency is guarded, not assumed.** Pad writes take `expected_revision`; leases and kv TTLs expire on their own; wake-up claims are atomic conditional updates so concurrent scheduler instances never double-fire; a project's shared tmux window is claimed inside `withWindowClaim`, the store's own write lock borrowed to exclude concurrent window creation, not only concurrent database writes.
- **The scheduler must never throw and must stay `unref()`'d**, or orphaned server processes linger after their session closes.
- **Untrusted `hive.yml` commands never run.** Trust is recorded per config hash; any change to a command re-requires interactive approval. `dir` cannot escape the project root and `profile` cannot escape the profile directories. The gate covers what hive *executes*.
- **`hive.yml` `vars` reach system prompts with no gate, deliberately.** They land in the lead's posture and every worker's brief, so a repo controls text with system-prompt authority. That was gated for one release and the gate was removed as friction not worth it for a single-user tool. It holds only because Claude Code's own workspace trust governs the wider channel. If hive ever ships to people who clone each other's repos, reinstate it rather than re-deriving the argument: `git log -- src/trust.ts`. Until then, read a cloned `hive.yml` the way you would read that repo's `CLAUDE.md`.
What stays above is what has no single file to fire on, stated as the prohibition rather than the explanation. Six things that used to sit here in full now live in the rules below, listed in their Covers column: append-only migrations, slim receipts, verbatim wake bodies, `execFileSync` argument arrays, the iTerm minimal-PATH note, and the cross-project spawn mechanics.

## The deeper invariants live next to the code they constrain

Each rule below is injected automatically when you open a file it covers, so you do not carry it the rest of the time. **Read one deliberately when you are planning work in its area**, because a rule fires on file access and planning happens before that.

| Rule | Fires on | Covers |
|---|---|---|
| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts`, `src/cli.ts`, `docs/*.md` | why a private tmux server plus the default store is refused, and why AUTO-ATTACH refuses on the private socket ALONE (a second, differently-shaped guard, not the same one); session-name namespacing; the paths that type into a pane and why one is deliberately unguarded; `execFileSync` argument arrays; the iTerm minimal-PATH note; why `cmdLead`'s adopt decision, not just delivery, has to compare pane pids |
| `.claude/rules/store-and-datadir.md` | `src/dataDir.ts`, `src/db.ts`, `src/backup.ts`, `src/result.ts`, `src/scheduler.ts`, `src/config.ts` | why the data dir is read at call time; the guards that make test isolation structural, and the one channel none of them could ever close (auto-attach, closed on a socket predicate instead); what a live restore does to open connections and the guard that now detects it, with its known residuals; append-only migrations |
| `.claude/rules/worker-state.md` | `src/hook.ts`, `src/hooks.ts`, `src/scheduler.ts`, `src/tools/wakes.ts` | why `agent_state_log` is append-only and how to assert over it; four ways worker state has been wrong, and how each was closed; never set a /goal on a worker; wake bodies are delivered verbatim |
| `.claude/rules/native-addon.md` | `src/abi.ts`, `src/abiProbe.ts`, `src/sessionProbe.ts`, `src/db.ts`, `src/dispatcher.ts`, `package.json` | why a passing `require()` proves nothing; why hive pins its interpreter; the SessionStart hook as the one entry point the pin does not cover, and how doctor probes it per project |
| `.claude/rules/tool-contract.md` | `src/tools/*.ts`, `src/cli.ts`, `src/help.ts`, `src/context.ts`, `src/strictInput.ts` | the verified lifecycle matrix and its accepted gaps; the naming convention for a new tool's verb; the CLI/MCP split and why it is mechanical, not stylistic; write tools return slim receipts; every tool refuses an unknown argument key, and what that costs |
| `.claude/rules/project-scoping.md` | `src/context.ts`, `src/spawn.ts`, `src/tools/agents.ts` | why a worker's files and its store are separate questions and the store wins; why `agent_spawn`'s cross-project refusal cannot be a prompt; the accepted residuals |
| `test/CLAUDE.md` | anything under `test/` | suite isolation, and the false-green shapes that have shipped here |

Every one of them is enforced by code and pinned by a test, except `tool-contract.md`, which is a convention: see its own header. Do not remove a guard because its reasoning is not in this file.

Incident history and standing lessons that outlive a lane are in the project's `lessons` pad (`hive pad lessons`), not here.
