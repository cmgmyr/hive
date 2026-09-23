# AGENTS.md

## What this is

hive is an MCP server plus CLI that gives multiple Claude Code sessions one shared, project-scoped state store: pads, todos with blockers, kv, leases, tmux-backed worker agents, and scheduled wake-ups. Every session runs its own server instance over stdio; all instances share one WAL-mode SQLite database (default `~/.hive/hive.db`). There is no daemon. The CLI makes one npm registry request only for an explicit `hive --version --check`, `hive upgrade`, or an interactive doctor refresh, and `HIVE_NO_UPDATE_CHECK=1` disables it. The MCP server, hooks, and scheduler never make that request.

## Commands

```bash
npm run build     # compile to dist/ (required before anything runs)
npm run watch     # compile on change
hive setup        # re-pin the hive command to the interpreter that built dist/
hive upgrade      # update a global install; checkouts print a recipe unless --run
hive doctor       # environment check + stale-state sweep
```

`npm test` runs the suite (`test/*.test.mjs`, node:test) against the built `dist/`, so build first. It runs through `scripts/run-tests.mjs`, which adds four things to a bare `node --test`:

- For the full suite, it hoists the longest file (wake-hold-notify.test.mjs, measured) to the front by spelling only that one path absolute, since node sorts its file list by path string before scheduling and an absolute spelling always sorts before a relative one - worth ~15.7% wall clock, because that file is otherwise queued behind others under 16-way concurrency (the hoist is `LONGEST_FILE_HOIST` in `scripts/run-tests.mjs` and is pinned by `test/run-tests-file-order.test.mjs`).
- Any run except a single named `.test.mjs` file first waits on a repo-wide lock file, so two lanes can never run the full suite (or a whole-directory/multi-file target) at once (`scripts/suite-lock.mjs`, `HIVE_TEST_NO_LOCK=1` skips it).
- After every file has exited, it asks each tmux socket the run created whether a server is still on it, and fails the run on a survivor (`test/CLAUDE.md` has the mechanics).
- A full run that holds the suite lock also reaps the wedged login shells it created: orphaned `ppid==1` shells are bracketed by PID set before the run and only bracket-new ones are signalled, each re-verified as still an orphan shell at the moment of the signal (`scripts/wedged-shells.mjs`; `HIVE_TEST_NO_REAP=1` opts out; a run without the lock never reaps). Reported as a count line, never a failure.

Tests spawn real MCP server and CLI processes against scratch directories; `test/CLAUDE.md` has the rules that keep them off the live store and off the developer's tmux server. CI runs the same on macOS (`.github/workflows/ci.yml`). For ad-hoc poking, pipe JSON-RPC lines to `node dist/index.js` the same way; MCP handles piped requests concurrently, so drive dependent calls sequentially.

## Architecture

Curated, not exhaustive: the modules that shape decisions, not every file under `src/`. An absence here is not a gap to file; see `src/*.ts` for the full set.

| Path | Role |
|---|---|
| `src/index.ts` | MCP server entry: registers tools, starts the scheduler |
| `src/cli.ts` | `hive` CLI: lead, attach, start, status, setup, upgrade, doctor |
| `src/db.ts` | SQLite open + append-only `MIGRATIONS` array |
| `src/abi.ts` | Loads the native addon before the store opens; names an interpreter mismatch |
| `src/dispatcher.ts` | Writes and reads the pinned `hive` shim; PATH resolution |
| `src/mcpConfig.ts` | Reads Claude Code's MCP registrations (`~/.claude.json`, `.mcp.json`) and Codex's (`config.toml`) |
| `src/context.ts` | Actor identity and project scope resolution |
| `src/tools/*.ts` | MCP tools by group: meta, pads, todos, kv, leases, agents, wakes |
| `src/scheduler.ts` | Wake-up firer + janitor; runs unref'd inside every instance |
| `src/tmux.ts` | tmux wrapper; the PTY is the agent message bus |
| `src/hook.ts`, `src/hooks.ts` | Claude Code hooks reporting exact worker state |
| `src/projectYml.ts` | `hive.yml` parsing, validation, and trust hashing |
| `src/backup.ts` | VACUUM INTO snapshots, retention, restore |

Key mechanics: workers are CLI agents in tmux panes, driven by typing into their terminals and reading the rendered screen back. Wake-ups deliver the same way, and worker state comes from Claude Code hooks writing to the database. All three have sharp edges, prohibited in `.claude/rules/tmux-and-panes.md` and `.claude/rules/worker-state.md` and explained in the `hive-internals` skill.

For how these modules and mechanics connect at runtime, not just what each one is for, see [docs/architecture.md](docs/architecture.md): process topology, spawn sequence, wake lifecycle, worker state, and the rest, each diagram cited to the code it describes.

## Invariants

These hold everywhere and shape decisions before you have opened a file.

- **Strict project scoping.** State resolves from the working directory; git worktrees and subdirectories resolve to the primary checkout's project. Never fall back to an unrelated project. Cross-project access happens only when the user explicitly asks; `HIVE_PROJECT_LOCK=1` disables it entirely and every spawned worker gets it.
- **A worker's files and its store are separate questions, and the store wins.** Files come from `cwd`; the store comes from the worker's own `agents` row. So a lead can run a worker inside another project's checkout while still recording the work in its own. `agent_spawn` refuses that crossing unless you pass `project_id` deliberately, and when you do cross, write a todo into the other project so it knows. Mechanics, and the accepted residuals: `.claude/rules/project-scoping.md` and its `hive-internals` reference.
- **Concurrency is guarded, not assumed.** Pad writes take `expected_revision`; leases and kv TTLs expire on their own; wake-up claims are atomic conditional updates so concurrent scheduler instances never double-fire; a project's shared tmux window is claimed inside `withWindowClaim`, the store's own write lock borrowed to exclude concurrent window creation, not only concurrent database writes.
- **The scheduler must never throw and must stay `unref()`'d**, or orphaned server processes linger after their session closes.
- **Untrusted `hive.yml` commands never run.** Trust is recorded per config hash; any change to a command re-requires interactive approval. `dir` cannot escape the project root and `profile` cannot escape the profile directories. The gate covers what hive *executes*.
- **The shipped tree carries nothing from the maintainer's own setup.** Three tiers: the hive CODEBASE is the product, and reads correctly on any device for any person; the hive LOCAL PROJECT is this checkout's private state (`.agents/sessions`, `settings.local`, `hive.yml`); the hive LOCAL ASSETS are `~/.hive/profiles` and `~/.agents`. Nothing from the second or third tier appears in the first. So no personal names, home paths, session ids or other projects in tracked files or fixtures; no orchestration-profile vocabulary (pad names, review pipelines, board sections) stated as if hive shipped it; no citation into an untracked corpus, since the reason has to be readable without it; and no skill hive does not ship treated as authority. A maintainer-local scan, untracked on purpose, walks every tracked file for these classes before anything is published; the invariant is the rule, the scan is one reader of it.
- **`hive.yml` `vars` reach system prompts with no gate, deliberately.** They land in the lead's posture and every worker's brief, so a repo controls text with system-prompt authority. That was gated for one release and the gate was removed as friction not worth it for a single-user tool. It holds only because Claude Code's own workspace trust governs the wider channel. If hive ever ships to people who clone each other's repos, reinstate it rather than re-deriving the argument: `git log -- src/trust.ts`. Until then, read a cloned `hive.yml` the way you would read that repo's `CLAUDE.md`.
What stays above is what has no single file to fire on, stated as the prohibition rather than the explanation. Six things that used to sit here in full now live in the pairs below, listed in their Covers column: append-only migrations, slim receipts, verbatim wake bodies, `execFileSync` argument arrays, the iTerm minimal-PATH note, and the cross-project spawn mechanics.

## The deeper invariants live next to the code they constrain

Each rule below is injected automatically when you open a file it covers, so you do not carry it the rest of the time. **Read one deliberately when you are planning work in its area**, because a rule fires on file access and planning happens before that.

**That injection is Claude Code's, and no other harness has it. If you are not Claude Code, the table below is your only route to these rules: before editing any file, find its row and read that rule yourself.** Nothing will hand it to you and nothing will warn you that it did not - a codex worker reads this file directly as `AGENTS.md` and then stops unless it goes looking. The rules are ordinary markdown at the paths named below; read them the way you would read any other file.

**`hive-internals` is not in the same position: codex can invoke it directly.** Codex natively scans `.agents/skills` (repo, up to root) and `~/.agents/skills`, and invokes a skill by a `$name` mention or an implicit match on its description, so a codex worker reaches `hive-internals` with `$hive-internals`, the same as it would from Claude Code - no manual file reads required. What codex genuinely lacks is a harness's own plugin-delivered skills, which are not files on disk for it to scan, the rules path-injection described above, and a sub-agent tool, so a multi-agent skill runs as one inline pass rather than a fan-out. The rule files still hold only the PROHIBITIONS since todo 437, so invoke `hive-internals` for the reference behind one instead of stopping at the table: that is exactly when you need it, because the reference is what tells you whether your case is the exception the prohibition already covers.

**Each of the seven `.claude/rules/` files is half of a pair, and the Covers column describes the pair.** `test/CLAUDE.md`, the eighth row, is split the same way as of todo 440: its reference lives at `.claude/skills/hive-internals/references/test-CLAUDE.md`. The rule file holds the PROHIBITIONS only. The evidence behind each one - the incident, the measurement, the mechanism - is in the `hive-internals` skill, one reference per rule, and it loads only when something invokes the skill. That split is todo 437: the rules were 34,188 words firing eagerly on file access, so opening `src/scheduler.ts` for a wake-ordering bug pulled 20,236 words of tmux lore. **Invoke `hive-internals` before changing anything the rules govern.** A prohibition tells you not to; the reference tells you why, and you need the why to know whether your case is the exception.

| Rule | Fires on | Covers |
|---|---|---|
| `.claude/rules/tmux-and-panes.md` | `src/tmux.ts`, `src/spawn.ts`, `src/scheduler.ts`, `src/tools/agents.ts`, `src/cli.ts`, `src/leadMessage.ts`, `src/harnesses.ts`, `src/processes.ts` | why a private tmux server plus the default store is refused, and why AUTO-ATTACH refuses on the private socket ALONE (a second, differently-shaped guard, not the same one); session-name namespacing; the paths that type into a pane and why one is deliberately unguarded; `execFileSync` argument arrays; the iTerm minimal-PATH note; why `cmdLead`'s adopt decision, not just delivery, has to compare pane pids; why a row's `tmux_target` is always a PANE id whatever the placement, and what stopped being inert when that became true; why a timed-out tmux call is `null` and never `false`, where the 10s bound came from, and what doctor reports about the servers a timeout leaves behind; why exactly one channel into a pane is shortened, where its 300-character threshold and 140-character head come from, and why the lookup names three distinct misses; why free text is a bracketed paste at every length and never `send-keys -l`, what the 1022-byte write is, and why a pane in COPY MODE is refused by one typing site and held by the other |
| `.claude/rules/store-and-datadir.md` | `src/dataDir.ts`, `src/db.ts`, `src/backup.ts`, `src/teardown.ts`, `src/result.ts`, `src/scheduler.ts`, `src/config.ts` | why the data dir is read at call time; the guards that make test isolation structural, and the one channel none of them could ever close (auto-attach, closed on a socket predicate instead); what a live restore does to open connections and the guard that now detects it, with its known residuals; append-only migrations |
| `.claude/rules/worker-state.md` | `src/hook.ts`, `src/backgroundTasks.ts`, `src/hooks.ts`, `src/scheduler.ts`, `src/tools/wakes.ts`, `src/firstPrompt.ts`, `src/dashboard.ts`, `src/processes.ts` | why `agent_state_log` is append-only and how to assert over it; six ways worker state has been wrong, and how each was closed; why a spawned worker's first idle is not a finish and why the resume fix could not simply be reused; the one fact six surfaces read and why it is one column; never set a /goal on a worker; wake bodies are delivered verbatim, and the four generated exceptions that are not - a lead-bound finish notice typed as crew state, the staleness trailer, which has a threshold, and the janitor's dead-process notice, which means "died on its own" only because a deliberate stop leaves a marker; and the changed-build notice sent only by a lead's own server to that lead |
| `.claude/rules/native-addon.md` | `src/abi.ts`, `src/abiProbe.ts`, `src/sessionProbe.ts`, `src/db.ts`, `src/dispatcher.ts`, `package.json` | why a passing `require()` proves nothing; why hive pins its interpreter; the SessionStart hook as the one entry point the pin does not cover, and how doctor probes it per project |
| `.claude/rules/tool-contract.md` | `src/tools/*.ts`, `src/cli.ts`, `src/help.ts`, `src/context.ts`, `src/strictInput.ts` | the verified lifecycle matrix and its accepted gaps; the naming convention for a new tool's verb; the CLI/MCP split and why it is mechanical, not stylistic; write tools return slim receipts; every tool refuses an unknown argument key, and what that costs; a tool declaring outputSchema must always return a JSON object |
| `.claude/rules/project-scoping.md` | `src/context.ts`, `src/spawn.ts`, `src/tools/agents.ts`, `src/leadMessage.ts` | why a worker's files and its store are separate questions and the store wins; why `agent_spawn`'s cross-project refusal cannot be a prompt; the accepted residuals |
| `.claude/rules/profile-files.md` | `src/profiles.ts` | why the filename guard is the load-bearing part of widening resolution to any `.md`, proven RED first; why rendering stays at read time; why `worker.md` stays excluded from doctor's unset-var scan; why an extra with no shipped upstream correctly reports no drift |
| `test/CLAUDE.md` | anything under `test/` | the "Write tests that can fail" checklist and its seven false-green shapes, kept eager; the 227-leaked-servers incident and the four socket states a verified tmux kill depends on, the fd-exhaustion measurement, and the `scripts/run-tests.mjs` leak-manifest mechanics, moved to the reference |

Every one of them is enforced by code and pinned by a test, except `tool-contract.md`, which is a naming convention and a matrix rather than a guard: its `hive-internals` reference opens with what that does and does not pin. Do not remove a guard because its reasoning is not in this file.

## Where a thing you have learned goes

**Code comments here are capped by an enforced ceiling, not held near zero.** `test/comment-ratio.test.mjs` pins that ceiling at 5% PER GROUP - `src/`, `test/`, `scripts/`, the shell scripts, `claude-plugin/`, `.github/workflows/` - never pooled, because one pooled ratio lets `test/`'s code lines fund comments that all land in `src/`; every group stays under it today. All 33,620 that were here were stripped, verbatim, into a holding area: 16,030 from `src/` (todo 436), then 16,803 from `test/` and `scripts/` plus 787 from the shell scripts and `claude-plugin/` (todo 438). The prose was accurate and it was never the problem; its volume and its eager loading were. The attic itself was deleted on 2026-09-14 (todo 439) with 0 of its 220 files ever promoted, which was the measurement it existed to take; the text is in git history before that commit.

A test is code and the rule applies to it: the test's NAME is where you say what it pins, not a paragraph above it (`test/CLAUDE.md`).

So when you need to know why something is the way it is, **invoke `hive-internals` first, then `git log -S`** before re-deriving a tmux, SQLite, Claude Code or scheduler fact. Having had to look something up is the signal that it earned a permanent home, so promote it into a reference rather than leaving it in history.

A standing judgment call already made, and still true, belongs in [docs/patterns.md](docs/patterns.md) before it gets re-derived from scratch: trades this project makes on purpose, approaches already refused, what counts as evidence here, how a guard is expected to be shaped. It stands apart from a rule (`.claude/rules/*.md` guards one mechanism): it is the tracked, standalone distillation of that reasoning.

A `file:line` citation anywhere in `docs/*.md` is checked against the symbol its prose names it for, not just against the file existing (`test/docs.test.mjs`, describe block "docs cite real code, not just real files"). Measured, not assumed: shifting every cited line by one is caught on 40 of 49 citations (82%, and the suite fails outright if that ever drops under 75%) - most single-line drift and a majority of range drift, not every edit above a citation.

When you learn something new, route it by who needs it and when. A long code comment is the last resort, because it is the only destination every future reader pays for on every file open:

| what it is | where it goes |
|---|---|
| a prohibition spanning files, that nobody would think to ask about | `.claude/rules/` |
| the evidence, mechanism or measurement behind one | `.claude/skills/hive-internals/references/` |
| a standing lesson about how work runs here | wherever this project keeps standing lessons |
| why one lane decided something | a todo comment |
| what changed and why, this change only | the commit message - git stores it losslessly, so do not also write it into the file |
| a gotcha the next person editing that exact line needs | a code comment, one or two lines |
