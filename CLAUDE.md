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

Key mechanics: workers are CLI agents in tmux panes/windows; `agent_send` types into their terminals and `agent_output` reads the rendered screen. Wake-ups deliver by typing their body into the target pane, which becomes a fresh user turn only when that pane is idle: a busy pane absorbs the text into the turn already running, and no hook fires for it (`.claude/rules/tmux-and-panes.md`). Worker state (working/idle/waiting) comes from Claude Code hooks writing directly to the database, keyed by `HIVE_AGENT_ID`.

## Invariants

These hold everywhere and shape decisions before you have opened a file.

- **Strict project scoping.** State resolves from the working directory; git worktrees and subdirectories resolve to the primary checkout's project. Never fall back to an unrelated project. Cross-project access happens only when the user explicitly asks; `HIVE_PROJECT_LOCK=1` disables it entirely and every spawned worker gets it.
- **Where a worker's files are and whose store records its work are two different questions**, and keeping them separable is deliberate. The files come from `cwd`; the store comes from the worker's own `agents` row, read back by `agentProjectPin` in `src/context.ts`, and the row beats `cwd` on purpose. So a lead in project A can send a worker into project B's checkout and keep orchestrating it from A, which is the point: B's lead may not be running, and the lead that dispatched the work is the one that has to review it. `agent_spawn` refuses that crossing unless you pass `project_id` for the cwd's project deliberately (`src/tools/agents.ts`). That refusal is where "ask before any work starts" lives, and it has to be a refusal rather than a prompt, since an MCP server has no channel to a human. It surfaces in the lead's session, where one is sitting.
  When you do cross, write a todo into the other project (`todo_create(project_id: <B>)`, which a lead can do because leads are never locked). Nothing else tells B that anything touched its repo, and if B's lead is running you now have two leads on one checkout with nothing between them. Two residuals are accepted rather than fixed: the refusal only fires when B is ALREADY REGISTERED, since `findProjectForDir` never registers, and nothing stops a running worker from `cd`-ing into another repo through Bash, which happens outside hive entirely and is the same class as the `agent_send` `keys` residual.
- **Migrations are append-only.** Never edit an existing entry in `MIGRATIONS`; add a new one.
- **Write tools return slim receipts.** Keep responses minimal; token cost is a design input. A slim receipt cannot confirm what it does not echo, so read a field back when it matters.
- **Concurrency is guarded, not assumed.** Pad writes take `expected_revision`; leases and kv TTLs expire on their own; wake-up claims are atomic conditional updates so concurrent scheduler instances never double-fire.
- **The scheduler must never throw and must stay `unref()`'d**, or orphaned server processes linger after their session closes.
- **Wake-up bodies are delivered verbatim** into a terminal. Keep them plain English and self-contained (ids, context, next action), because a body that only makes sense as a reply is unreadable when it lands mid-turn. A delivery into a busy pane can never be confirmed, so `unconfirmed` does not mean undelivered: see `.claude/rules/tmux-and-panes.md`.
- **All process execution goes through `execFileSync` with argument arrays** (`tmux()` in `src/tmux.ts`). Never build a shell command string from data.
- **Untrusted `hive.yml` commands never run.** Trust is recorded per config hash; any change to a command re-requires interactive approval. `dir` cannot escape the project root and `profile` cannot escape the profile directories. The gate covers what hive *executes*.
- **`hive.yml` `vars` reach system prompts with no gate, deliberately.** They land in the lead's posture and every worker's brief, so a repo controls text with system-prompt authority. That was gated for one release and the gate was removed as friction not worth it for a single-user tool. It holds only because Claude Code's own workspace trust governs the wider channel. If hive ever ships to people who clone each other's repos, reinstate it rather than re-deriving the argument: `git log -- src/trust.ts`. Until then, read a cloned `hive.yml` the way you would read that repo's `CLAUDE.md`.
- iTerm profile commands (used by auto-attach) run with no shell and a minimal PATH: embed absolute binary paths in AppleScript strings.

## The deeper invariants live next to the code they constrain

Each rule below is injected automatically when you open a file it covers, so you do not carry it the rest of the time. **Read one deliberately when you are planning work in its area**, because a rule fires on file access and planning happens before that.

| Rule | Fires on | Covers |
|---|---|---|
| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts` | why a private tmux server plus the default store is refused; session-name namespacing; the four paths that type into a pane and why one is deliberately unguarded |
| `.claude/rules/store-and-datadir.md` | `src/dataDir.ts`, `src/db.ts`, `src/backup.ts`, `src/result.ts`, `src/scheduler.ts`, `src/config.ts` | why the data dir is read at call time; the two guards that make test isolation structural; what a live restore does to open connections and the guard that now detects it, with its known residuals |
| `.claude/rules/worker-state.md` | `src/hook.ts`, `src/hooks.ts`, `src/scheduler.ts`, `src/tools/wakes.ts` | why `agent_state_log` is append-only and how to assert over it; the three open ways worker state is wrong; never set a /goal on a worker |
| `.claude/rules/native-addon.md` | `src/abi.ts`, `src/db.ts`, `src/dispatcher.ts`, `package.json` | why a passing `require()` proves nothing; why hive pins its interpreter |
| `.claude/rules/tool-contract.md` | `src/tools/*.ts`, `src/cli.ts`, `src/help.ts`, `src/context.ts` | the verified lifecycle matrix and its accepted gaps; the naming convention for a new tool's verb; the CLI/MCP split and why it is mechanical, not stylistic |
| `test/CLAUDE.md` | anything under `test/` | suite isolation, and the false-green shapes that have shipped here |

Every one of them is enforced by code and pinned by a test, except `tool-contract.md`, which is a convention: see its own header. Do not remove a guard because its reasoning is not in this file.

Incident history and standing lessons that outlive a lane are in the project's `lessons` pad (`hive pad lessons`), not here.
