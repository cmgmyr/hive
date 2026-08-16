# Attic: scripts/isolated-hive.mjs

Comments removed from `scripts/isolated-hive.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Issue #31 part B: a second HIVE, not a second SESSION.
//
// A plain `claude` session started for testing shares its dist/, its
// HIVE_DATA_DIR and its tmux server with everything else on the machine, so
// it is a second sampler on the same instance, not an isolated one. This
// script builds the three axes that make it genuinely separate: a scratch
// HIVE_DATA_DIR, a private TMUX_TMPDIR, and a dist/ resolved from wherever
// this script itself lives, which is this branch's worktree, never the
// pinned `hive` shim or whatever PATH happens to resolve.
//
// A FOURTH THING THE INSTANCE HAS TO NEUTRALISE, alongside those three axes,
// found by running the gate and having it pop open blank terminal windows on
// the developer's own screen: `ensureAttached()` in src/tmux.ts auto-attaches
// a native terminal to a project's tmux session whenever nobody is watching
// it, so it can put windows on the human's screen for a gate that is meant to
// run unattended. Disabled the same way the test suite already disables it
// (test/helpers.mjs's baseEnv): HIVE_AUTO_ATTACH=0, set alongside
// HIVE_DATA_DIR and TMUX_TMPDIR below, because it belongs to the same idea --
// an isolated instance must not reach out and touch the developer's desktop.
//
// Lives in scripts/, not test/: `npm test` must not run it, and it is meant
// to be run by hand -- see the plan pad and .claude/rules/tmux-and-panes.md /
// store-and-datadir.md for the failure modes this guards against.
//
// PART C'S FOURTH AXIS: a spawned worker's own hive MCP server, and the
// folder-trust dialog on its project root. agent_spawn launches a plain
// `claude`, which by default picks up whatever hive registration Claude Code
// has configured -- ordinarily the user-scoped one pointing at the INSTALLED
// build, not this branch's dist -- even though spawn.ts passes
// HIVE_DATA_DIR explicitly, so that server would open the correct SCRATCH
// STORE with the WRONG CODE. If the branch under test adds a MIGRATIONS
// entry, the lead applies it and an older worker build skips it silently, so
// a part-C run would exercise the previous release against the new schema
// and read that as a pass. Two mechanisms were tried and rejected before the
// one below, each verified by running it, not by reading the docs:
//   - A project-scoped .mcp.json, auto-discovered from the worker's cwd,
//     raises a real, blocking "New MCP server found in this project" dialog
//     the first time Claude Code sees it. An unattended gate cannot answer
//     that, and every worker gets a fresh scratch cwd, so it is never
//     pre-approved. `--mcp-config <file> --strict-mcp-config` is the
//     alternative: an explicit CLI argument instead of project-file
//     auto-discovery, and it raises no dialog at all (confirmed via `/mcp`:
//     the server connects, with the correct tool count, and none of the
//     machine's other hive registrations present -- --strict-mcp-config's
//     own job, since without it the worker would load the installed build
//     alongside this one). This is what workerMcpConfigPath() below feeds.
//   - The worker's cwd triggers a SECOND, independent dialog: any
//     never-before-seen directory raises Claude Code's folder-trust prompt,
//     regardless of the MCP mechanism above. CLAUDE_CONFIG_DIR looked like
//     the clean fix, relocating trust the same way the other axes relocate
//     state, and it does kill the dialog with zero writes to the real
//     ~/.claude.json. But it relocates auth along with trust: a scratch
//     CLAUDE_CONFIG_DIR is a fresh, credential-less install (confirmed by
//     running it -- the worker came back "Not logged in", and a totally
//     empty scratch config dir raises the full first-run onboarding wizard
//     instead, which rules out one bad JSON file as the cause and confirms
//     this is inherent to the mechanism). Copying live OAuth credential
//     material into a scratch directory to work around that was refused ON
//     PURPOSE, not merely left undone: it is a decision about handling real
//     credential material this script does not get to make on its own, and
//     it is not worth the residual risk for a gate that has a free
//     alternative anyway.
// The free alternative, also verified by running it: trust INHERITS into a
// brand-new subdirectory of an already-trusted root, with no dialog at all.
// This worktree is already trusted by the time this script runs (nothing
// else here would be possible otherwise), so workerProjectRoot() below
// creates the worker's project root under THIS repo checkout (`.claude/`,
// already gitignored) instead of under the OS tmpdir like the other scratch
// paths. It is still fresh per run and still torn down by `down`, and it
// costs nothing: no credential handling, no write to the real
// ~/.claude.json, no keystroke. HIVE_DATA_DIR and TMUX_TMPDIR stay under the
// OS tmpdir exactly as before -- TMUX_TMPDIR in particular cannot move under
// this repo's (long) worktree path without risking the 104-byte unix socket
// cap this file already guards elsewhere (see SOCKET_PATH_LIMIT below).
//
// WHAT THAT TRADES AWAY: the reason siting workerRoot inside the checkout
// removes the dialog is the same reason it changes the worker's blast
// radius. Under part B's OS-tmpdir root, the worker had no trusted path back
// to the checkout at all. Now its cwd sits inside it, so `..` is the working
// tree this very branch lives in, and the gate spawns a REAL claude with
// real tools and tells it to act. The isolation axes above keep the STORE
// and the TMUX SERVER scratch; they do nothing to keep the FILESYSTEM
// scratch, because the worker's project root is deliberately not scratch
// with respect to the repo anymore. Part C's own assertions (see the gate
// script and its git-status check) exist to catch this if it ever happens,
// not to prevent it -- there is no isolation fix here that does not undo the
// trust inheritance this section just spent five paragraphs earning.
```

## line 112

```
// macOS's sockaddr_un.sun_path is 104 bytes including the trailing NUL, so a
// path at or beyond that cannot be used as a socket path at all. Refuse a
// few bytes below the hard cap rather than exactly at it.
```

## line 117

```
// One pointer per repo checkout, not one global pointer: two worktrees each
// isolating their own instance must not refuse each other. Hashing the
// resolved repo path is the same move dataDirTag() makes for tmux session
// names, reused here for the same reason -- a name derived from something
// that can collide is worse than one that cannot.
//
// Cached: REPO_DIR cannot change mid-process, and every command reads or
// writes state at least once.
```

## line 142

```
// "wx": create-exclusive, so two concurrent `up` calls that both pass the
// initial readState() check (neither has written yet) cannot both win. Only
// one writeFileSync succeeds; the other throws EEXIST, which cmdUp turns
// into a refusal instead of silently overwriting the winner's pointer and
// leaking the loser's scratch root. Counselors review on PR #48, codex
// finding 6.
```

## line 156

```
// dist/ is resolved from THIS script's own location, not imported at module
// top level: a top-level import would run even when a caller only wants the
// pure guard functions below, and would throw before an unbuilt dist/ could
// be reported as a normal, actionable refusal. checkDistBuilt/checkDistFresh
// run once here rather than separately at each call site, so every command
// pays for one existsSync/statSync pass over these files, not two.
```

## line 187

```
// The instance is meant to run the code under review, not last week's build
// (see the plan pad: an isolated instance running a stale dist is a more
// convincing wrong answer than no isolation at all). tsc has no incremental
// cache configured here, so a full `npm run build` rewrites every dist/*.js
// mtime on every run regardless of which sources changed -- confirmed by
// running it twice with no edits between -- which makes "oldest dist file
// hive actually loads vs newest .ts anywhere in src/" a reliable staleness
// signal rather than a per-file guess.
```

## line 214

```
// down never gates on build freshness, unlike loadHiveDist above: editing a
// .ts without rebuilding is the ordinary state while iterating (see
// checkDistFresh's own comment on why freshness matters for up/env), and
// teardown is exactly the operation you need most while that is true.
// Staleness is a statement about the code under test; it has no bearing on
// this process's ability to compute a socket path and stop a server. This
// still needs dist/tmux.js to exist at all -- not dataDir.js, and no
// freshness check -- to compute that socket the same way hive itself would.
// If even existence fails, the caller must refuse rather than silently
// proceeding: a leaked scratch directory is recoverable, a leaked server
// with live workers in it is not.
```

## line 232

```
// The kill DECISION, separated from the kill ACTION so it is testable
// without ever starting or stopping a real tmux server (counselors review
// on PR #48, codex finding 9 / opus's coverage note: the single most
// dangerous line in this file had zero coverage, because no test started a
// server in the scratch dir, so execFileSync always threw "no server
// running" into a catch and the actual kill path never ran). Returns the
// exact socket path to hand `tmux -S ... kill-server`, or null when there is
// nothing safe -- or nothing at all -- to kill: the tmux dir does not exist,
// or the computed socket resolves to the shared default.
```

## line 251

```
// Written by up, checked by down before it deletes or kills anything: proof
// this root is something up actually created, not just a path that happens
// to exist or that a state file happens to name.
```

## line 256

```
// /simplify: root and workerRoot are each created-with-a-marker, validated,
// and torn down, and before these three helpers existed each of those three
// steps was written out by hand at every call site that needed it -- twice
// for creation, twice for validation, four times for teardown, once this
// file grew a second scratch root to manage. root and workerRoot stay two
// separate, differently-validated fields on state (root's own dataDir/
// tmuxTmpDir shape check below has no workerRoot equivalent, so they were
// never good candidates for a single generic "list of tracked roots"), but
// the mechanics below are the same regardless of which root they're applied
// to, so they are written once.
```

## line 274

```
// The proof required before ANY removal of workerRoot, on EVERY path that
// reaches one -- including cmdUp's stale-pointer self-heal and cmdDown's
// "root already gone" shortcut, which both used to call rmRoots([workerRoot])
// directly, before checkOwnsInstance (which validates the very same marker)
// ever ran. Those two shortcuts exist precisely because state.root is
// unusable, so they cannot lean on checkOwnsInstance's `root` half; this is
// the workerRoot half of that same proof, usable standalone.
// Counselors review on PR #60: a state file this script did not write --
// {"root": "/tmp/gone", "workerRoot": "/Users/dev/Code"} -- reached rmSync
// on an arbitrary directory through these two shortcuts with no marker check
// at all. Returns null (safe to proceed) when there is nothing there to prove
// ownership over: rmSync on a missing path is already a no-op, so refusing
// would only block the self-heal these paths exist to perform.
```

## line 298

```
// Filters out anything that isn't a path rather than requiring every caller
// to guard it: workerRoot didn't exist in state files written before todo
// 129, so a stale one loaded from disk may have no workerRoot at all, and a
// still-`let`-undeclared local at an early failure point in cmdUp is exactly
// the same shape.
```

## line 309

```
// The worker-facing project root: unlike `root` (dataDir/tmuxTmpDir, under
// the OS tmpdir), this is a fresh mkdtemp under THIS repo checkout's
// `.claude/` -- already gitignored, and already trusted by Claude Code
// because this script cannot be running otherwise -- so a worker spawned
// with this as its cwd inherits that trust and never sees the folder-trust
// dialog. See the header for why it lives apart from `root` rather than
// nested inside it: nesting under `.claude/` would put it under this repo's
// (long) worktree path, and dataDir/tmuxTmpDir must stay short and
// tmpdir-rooted for the socket-length guard below to keep meaning anything.
```

## line 322

```
// Named once so cmdUp (which writes it) and a part-C gate script (which
// reads it to build a worker's `command`) never duplicate the filename.
```

## line 326

```
// The file `--mcp-config <path> --strict-mcp-config` reads: this branch's
// dist, nothing else. No env block -- the worker's pane already carries the
// right HIVE_DATA_DIR and HIVE_AGENT_ID (spawn.ts sets both), and this
// config's child process inherits them same as any other env var, so
// hardcoding them here would be a second, driftable copy of what spawn.ts
// already guarantees.
```

## line 339

```
// down's own guard, distinct from the isolation axes above: a state file is
// not proof by itself of what it names. Counselors review on PR #48 (codex
// finding 5, opus finding 5, found independently by both seats): down used
// to treat readState()'s content as authority for a recursive rm -rf and a
// kill-server with no validation at all. A state file surviving after its
// tree was cleaned up externally and then recreated for something unrelated
// at the same path, or simply hand-edited, would get torn down -- and
// "privateTmuxSocket says not-default" only ever proved not-default, never
// ownership, so a state file naming a DIFFERENT real instance's tmuxTmpDir
// would have had that instance's server killed too.
//
// Structural agreement with scratchPaths PLUS a marker file only up writes is
// what "up created this" means here.
```

## line 369

```
// Same proof, second root: workerRoot lives inside this repo checkout, not
// under the OS tmpdir, so a stale or hand-edited pointer here is exactly
// the case that would otherwise turn `down` into `rm -rf` on some other
// directory this script never created.
```

## line 382

```
// Trap 1, half of it. A private TMUX_TMPDIR paired with the DEFAULT store is
// worse than no isolation: a janitor on the private server asks the shared
// store's rows about panes that live elsewhere, gets a correct "no such
// pane", and sweeps live agents. up's own flow can never produce the pair
// (dataDir always comes from a fresh mkdtemp), but env reads a state file it
// did not just create, and nothing stops that file's paths from being
// replaced with a symlink to ~/.hive since -- which is why cmdEnv runs this
// guard too, not just cmdUp (counselors review on PR #48, codex finding 3 /
// opus finding 4).
```

## line 401

```
// Trap 1, the other half. Isolation is both axes together or neither; one
// alone is the dangerous pair from checkNotDefaultStore, seen from the other
// side.
```

## line 412

```
// Trap 3. tmux does not create TMUX_TMPDIR; a value naming a missing
// directory silently resolves to the SHARED socket instead of erroring. This
// re-checks existence at USE time (env/down), not just at the moment `up`
// created it, because the ordinary end state of an isolated instance is its
// scratch dir having been cleaned up from under it.
```

## line 427

```
// Trap 2. The socket path tmux would actually use, computed the same way
// hive itself computes it (dist/tmux.js's tmuxSocketPath), measured in
// bytes, named in the refusal so the failure is diagnosable instead of a bare
// "tmux failed".
```

## line 443

```
// Runs every guard in order and stops at the first failure, since a later
// guard's precondition (e.g. the tmux dir existing) can depend on an earlier
// one holding.
```

## line 455

```
// quote is dist/tmux.js's own shellQuote, passed in rather than reimplemented
// here: this is the same human-readable-command-line quoting hive already
// uses elsewhere, and a caller with no dist loaded (e.g. this function's own
// unit test) supplies whichever quoting it means to assert on.
```

## line 461

```
// TMUX_PANE, not just TMUX: a session started from a shared pane keeps
// its %N identity even with TMUX unset, and hive records that pane as
// this session's delivery target, then probes/delivers it on the
// PRIVATE server -- either finding nothing (wake cancelled) or an
// unrelated private pane (wake delivered to the wrong place). The
// suite's own isolateTmux() clears both for exactly this reason.
// Counselors review on PR #48, codex finding 8.
```

## line 472

```
// See the header: ensureAttached() in src/tmux.ts pops open a native
// terminal on this machine's desktop whenever nobody is watching a
// project's tmux session, which an isolated instance must never do.
```

## line 489

```
// Exported (unlike cmdEnv/cmdDown's CLI-only siblings until now) so a
// programmatic caller -- the part-C gate script -- gets the paths as data
// instead of scraping the human-facing stderr banner and stdout env block
// with regexes. Returns undefined on any refusal (fail() already reported
// it); the CLI's own `main()` ignores the return value either way.
```

## line 501

```
// The pointer is stale, not live: existing.root is gone (external
// cleanup, a temp reaper, a previous crashed `up`), so there is no
// instance to protect and no reason to leave the pointer sitting there.
// Leaving it here was the bug: this process would still create a fresh
// scratch tree below, then collide on the "wx" writeState against this
// SAME surviving file, reporting a concurrent-race message when no race
// happened, and "try up again" could never work because every retry
// hits the identical stale file. Clearing it here, where the pointer is
// already known dead, is what down's own !existsSync(state.root) path
// does for the same reason -- this makes the two self-heal the same
// way. A genuine "wx" collision below (the pointer was live at THIS
// check but another `up` won the write) is still a real race and still
// gets that message. workerRoot lives inside this repo checkout rather
// than the OS tmpdir, so unlike `root` it will not clean itself up by
// sitting in a temp reaper's path; sweep it here too rather than leaving
// visible clutter under .claude/ behind a pointer we are about to erase.
// But this pointer came from disk, not from this process's own `up` --
// exactly the input checkWorkerRootRemovable exists to check before any
// rm -rf runs against it, on this shortcut same as cmdDown's.
```

## line 550

```
// The fourth axis (see header): a worker's project root, sited under this
// repo checkout so it inherits trust instead of raising Claude Code's
// folder-trust dialog, carrying the MCP config that points a worker at
// THIS BRANCH's dist via --mcp-config, not project-file auto-discovery.
// Anything failing here must not leave `root` behind either -- same
// all-or-nothing shape as the guard above, one door over.
```

## line 584

```
// stderr, not stdout: the documented usage is `eval "$(... up)"`, and a
// banner on stdout gets eval'd as a command ("isolated hive instance up at
// /path"). The shell reports "command not found" but still runs the rest
// of the block, so the env got set correctly behind a spurious error --
// confusing rather than broken, but needless. Counselors review on PR #48,
// opus's closing note.
```

## line 612

```
// The FULL guard set, not just existence and socket length: up's own flow
// cannot produce the default-store pair (dataDir always comes from a fresh
// mkdtemp), but env reads a state file it did not just create, and nothing
// stops that file's paths from having been replaced with a symlink to
// ~/.hive or to /tmp since. Counselors review on PR #48 (codex finding 3,
// opus finding 4, found independently by both seats): env used to skip
// checkNotDefaultStore entirely, so it would print the explicitly
// forbidden private-tmux/default-store pair as though it were isolated.
```

## line 629

```
// Exported for the same reason cmdUp is: a programmatic caller needs a
// success/failure signal without parsing console output. Returns true once
// the instance is confirmed gone (including the two "nothing to tear down"
// no-op cases, which are success by this function's own contract), false on
// any refusal.
```

## line 641

```
// Already gone (external cleanup, a previous crashed `down`, ...):
// nothing to validate against and nothing destructive left to attempt,
// so this is the same "safe to run twice" shape as no state file at all.
// workerRoot gets the same sweep as root's own EEXIST rollback above: it
// sits inside this repo checkout, not the OS tmpdir, so nothing else on
// the machine will ever clean it up on our behalf.
// THE CRITICAL this closes (counselors review on PR #60): this shortcut
// used to call rmRoots([state.workerRoot]) here unconditionally, entirely
// BEFORE checkOwnsInstance ever runs -- checkOwnsInstance sits below,
// gated on state.root existing, so a state file naming a nonexistent
// root and an arbitrary workerRoot (hand-edited, or corrupted) reached
// rm -rf on that arbitrary path with no ownership proof at all. Same
// marker check as checkOwnsInstance's own workerRoot half, usable here
// where the state.root half of that function cannot apply.
```

## line 677

```
// Counselors review on PR #48 (codex finding 7, opus finding 1): a
// stale dist used to make this throw, get swallowed, and fall through
// to deleting the socket directory anyway -- leaking the private
// server and every worker in it, unreachable, forever, while printing
// "torn down". Refuse instead: the scratch tree and state file are
// left in place so a retry after fixing the build can still tear down
// properly.
```

## line 690

```
// A live MCP process (the lead or a worker) can still hold this
// scratch store open with no tmux session at all, so an empty list
// here is not proof nothing is running -- but a NON-empty list is
// proof something plainly is, and that is the cheap half of a known,
// documented residual worth catching (see the CLAUDE.md note on
// cross-server rows and todo 108's comment on why the full fix needs a
// migration). Once this kills the server, that process's own later
// tmux calls resolve against a directory we are about to delete and
// silently fall back to the SHARED socket. Counselors review on PR
// #48, codex finding 2.
```

## line 710

```
// --force chose to proceed anyway; say so rather than letting a bare
// "torn down" read as though nothing was running (opus's coverage
// note on the same finding).
```

## line 718

```
// No server running there, or already gone.
```

## line 729

```
// [] both when the server is unreachable/gone and when it has no sessions;
// callers must not read either as "definitely nothing is running" (see the
// caller's own comment) but a NON-empty list is unambiguous.
```

## line 744

```
// Object.create(null): a plain {} object lookup walks the prototype chain,
// so `isolated-hive.mjs toString` or `... constructor` resolves an
// Object.prototype member, "succeeds," and exits 0 having done nothing. Any
// wrapper that reads exit 0 as "an instance is up" (part C is exactly that
// wrapper) would read success from a run that never ran a command.
// Counselors review on PR #48, opus finding 10.
```
