# Attic: test/isolated-hive.test.mjs

Comments removed from `test/isolated-hive.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 39

```
// scripts/isolated-hive.mjs's own `up`/`down` never touch the ambient tmux
// server -- its scratch TMUX_TMPDIR always comes from a fresh mkdtemp, and
// `down` passes that path explicitly rather than reading the ambient env. But
// this file's own dynamic `../dist/tmux.js` imports trip suite-isolation's
// textual scan regardless, so isolate the same way every other file here does.
```

## line 70

```
// Must actually exist: tmuxSocketPath falls back to the DEFAULT socket
// for a directory it cannot reach (trap 3), which would make this
// measure the short default path instead of the long one under test.
```

## line 139

```
// ensureAttached() in src/tmux.ts pops a native terminal onto the
// developer's own desktop for a project nobody is watching; an isolated
// instance must neutralise that the same way it neutralises the shared
// store and the shared tmux server. Found by running the gate and
// watching windows open on a real screen, not by reading the wiring.
```

## line 147

```
// down's kill-server path had zero coverage before this: no test ever
// started a server in a scratch dir, so execFileSync always threw "no
// server running" into a catch and the real kill line never ran.
// killSocket separates the DECISION from the ACTION so it is testable
// without ever starting or stopping a real tmux server (counselors
// review on PR #48, codex finding 9 / opus's coverage note).
```

## line 176

```
// checkOwnsInstance is the guard between a stale or hand-edited state file
// and down doing rm -rf plus kill-server against something it did not
// create -- the PR's own most dangerous finding. It had zero coverage:
// deleting the call in cmdDown, or breaking the function to always return
// null, left every existing test in this file green, because the
// lifecycle test only ever exercises the happy path where up just wrote a
// well-formed state file (PR gate re-review).
```

## line 203

```
// Same proof, second root (see the function's own comment): a state file
// missing workerRoot entirely -- e.g. one written by a pre-part-C build
// of this script -- must refuse rather than let `down` skip validating a
// path it never checked.
```

## line 233

```
// The literal name, not the (unexported) MARKER_FILE constant: this is
// what up actually writes to disk, which is the thing worth pinning.
```

## line 248

```
// The trust-inheritance mechanism the header documents only holds if this
// directory is actually created UNDER the repo checkout, not under the OS
// tmpdir like the other scratch paths -- that placement is the entire
// point, so pin it rather than trusting the implementation to keep it.
```

## line 282

```
// No env block: the worker's pane already carries the right
// HIVE_DATA_DIR/HIVE_AGENT_ID (spawn.ts sets both), and this config
// must not hold a second, driftable copy of either.
```

## line 293

```
// statePath() and the mkdtemp root both go through os.tmpdir(), with no
// env override, keyed only by a hash of this repo checkout -- so an
// inherited env makes this suite share ONE state file with a real
// instance a developer brought up in this same worktree to test the
// branch by hand (counselors review on PR #48, opus finding 3, "bites
// ME"). Without this, a second `up` here would refuse for the WRONG
// reason (colliding with the developer's real instance, not the previous
// test case's), the assertion would fail, and after()'s unconditional
// `down` would kill-server the developer's private tmux server and rm -rf
// their scratch store -- while their workers were still running in it.
//
// A SHORT base, not one nested under the real TMPDIR: os.tmpdir() on this
// machine is already a long /var/folders/... path, and stacking a second
// mkdtemp under it pushes the socket path past the ~100-byte cap, making
// `up` refuse for a different wrong reason (trap 2, not test isolation).
```

## line 311

```
// spawnSync, not execFileSync: execFileSync only returns stdout on
// success and throws stderr away entirely unless the process exits
// non-zero, so a caller asserting on stderr (e.g. up's banner, which
// lives there even on success) saw undefined for every passing run.
```

## line 323

```
// A case failing partway through the lifecycle must not strand a scratch
// tree or a real tmux server for the next run to trip over.
```

## line 337

```
// The exit code alone passes for ANY refusal reason -- an unbuilt dist,
// a stale dist, a thrown TypeError, a bad argv (test/CLAUDE.md's named
// false-green shape; counselors review on PR #48, opus finding 8).
// Assert the actual sentence, which is what distinguishes "already up"
// from every other way this could fail closed.
```

## line 366

```
// The whole reason this directory lives inside the repo checkout rather
// than the OS tmpdir: trust inherits from an already-trusted ancestor,
// which only holds if the path is actually nested under REPO_DIR. If a
// future change moved it back under the tmpdir "for consistency" with
// the other scratch paths, this is the test that would catch it.
```

## line 388

```
// PR gate re-review, post-merge-readiness pass. The stale case (pointer
// present, root gone -- external cleanup, a temp reaper, a crashed `up`)
// used to fall through readState()'s check silently, so this process
// went on to create a fresh scratch tree and then collided on the "wx"
// writeState against the SAME surviving file: it reported "another `up`
// claimed the instance pointer first" when no concurrent run existed,
// and "try up again" could never work, since every retry hits the
// identical stale file. up now clears a stale pointer at the same place
// it already decided the instance is dead, matching down's own
// !existsSync(state.root) self-heal.
```

## line 405

```
// External cleanup: the tree is gone, the state file survives. Only
// `root` -- unlike workerRoot, this is what a temp reaper or a crashed
// `up` would actually remove, since workerRoot lives inside the repo
// checkout, not the OS tmpdir a reaper would ever touch.
```

## line 415

```
// Immune: second.stderr does carry generated scratch paths (data dir,
// tmux tmp dir, hash-tagged state file name), but this is a full,
// multi-word English sentence with spaces at fixed word boundaries -
// no run of random path characters (mkdtemp's alnum suffix, or the
// hex statePath() hash) can ever spell it out.
```

## line 434

```
// The self-heal above genuinely succeeds and leaves a live instance,
// unlike every other case in this describe block, which fails before
// ever writing state. Leave the shared state file clean for whatever
// test runs next.
```

## line 443

```
// The wiring half of checkOwnsInstance's coverage: the unit tests above
// pin the function itself, but deleting the call in cmdDown would leave
// every one of them passing. This forges a state file at the exact path
// the spawned script will read (statePath()'s own hash-of-REPO_DIR
// scheme, replicated here) and asserts down refuses through the real
// CLI, not just the pure function.
```

## line 467

```
// THE CRITICAL, counselors review on PR #60: both `down`'s "root already
// gone" shortcut and `up`'s stale-pointer self-heal used to call
// rmRoots([workerRoot]) unconditionally, entirely before checkOwnsInstance
// (or any marker check at all) ever ran -- because both shortcuts trigger
// exactly when state.root does not exist, which is also exactly when
// checkOwnsInstance's own workerRoot check never gets reached. A state file
// naming a gone root and an arbitrary, unmarked workerRoot reached rm -rf
// on that arbitrary directory with no ownership proof. This forges exactly
// that state file -- root gone, workerRoot a real scratch directory this
// script never created -- and asserts both `down` and `up` refuse rather
// than deleting it. Deleting the checkWorkerRootRemovable calls added
// alongside this test (or reverting to the unconditional rmRoots) makes
// this fail with the target directory gone.
```

## line 484

```
// Stands in for "an arbitrary directory this script never created" --
// real production report named /Users/dev/Code, the entire checkout
// tree; this is the same shape, just scoped to a directory this test can
// safely assert on.
```

## line 543

```
// in case up somehow left a live instance behind
```

## line 548

```
// A plain {} lookup table resolves these via the prototype chain and
// "succeeds" silently; COMMANDS must be null-prototype (or checked with
// Object.hasOwn) so each of these hits the usage refusal instead.
```

## line 557

```
// Both pin that a specific guard is actually WIRED into the CLI, not just
// correct as a standalone function. Deleting checkDistFresh from
// loadHiveDist's `??` chain, or deleting the whole firstFailure call from
// cmdUp, left every other test in this file passing: the lifecycle test
// above only ever runs `up` against a fresh dist and a fresh mkdtemp, so
// neither guard's pure unit test is evidence about the script calling it
// (counselors review on PR #48, opus finding 7).
```

## line 580

```
// Mutates a real repo file's MTIME, not its content, and restores it in
// `finally`, so this is repeatable regardless of run order and leaves no
// trace: content is untouched, so no rebuild is needed afterward.
```

## line 593

```
// in case `up` somehow got far enough to leave state
```

## line 598

```
// The lifecycle test above never starts a real tmux server and has no
// live process during `down`, so its "and only that tree" assertion
// cannot detect deletion of an additional or substituted tree, and the
// single most dangerous line in cmdDown -- the actual kill-server exec
// -- never ran against a live server in any prior test (test
// false-green audit, counselors review on PR #48). isolateTmux() at
// this file's top already put the WHOLE FILE on its own private ambient
// socket, standing in for "the developer's shared session" from
// cmdDown's point of view: if down ever reached ambient TMUX_TMPDIR by
// mistake, THIS session -- not some untouched real machine state -- is
// what would die.
```

## line 618

```
// Todo 375, counselors round 2 (F6). A real server on an instance
// socket that is not this file's own, so the run-level leak check has
// to be told about it - `down --force` below is what reaps it, and a
// case that fails before reaching that line is exactly when it matters.
```

## line 627

```
// Confirm setup actually landed on the SCRATCH socket, not the
// ambient one, before trusting the teardown assertion below.
```

## line 632

```
// A live session now makes a plain `down` refuse (the finding-2
// mitigation); --force is the intentional-teardown escape hatch.
```

## line 649

```
// Already gone.
```
