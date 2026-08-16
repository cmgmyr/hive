# Attic: test/kickoff-reexec.test.mjs

Comments removed from `test/kickoff-reexec.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 19

```
// hooks.json registers claude-plugin/kickoff.mjs under a bare `node`, which a
// version manager resolves from the session's working directory rather than
// the Node hive was built under (issue #50). This exercises the plugin entry
// point itself, not dist/kickoff.js (kickoff.test.mjs's target), because the
// re-exec has to happen before dist/kickoff.js -> dist/db.js is ever imported.
// It only fires when this interpreter cannot load the addon at all
// (checkAbi().ok === false), never on a bare path difference from the
// dispatcher's pin -- a healthy interpreter whose pin is merely stale must be
// left alone.
//
// "a genuine ABI mismatch" is what that said, and it under-described the gate
// after issue #105 lane B (hive todo 297 item 3). `ok === false` has always
// covered every failure branch, and the NODE_MODULE_VERSION mismatch it named
// is the one branch the shipped package can no longer reach. What reaches it
// in production now is "napi", a Node below better-sqlite3's Node-API floor,
// which is precisely what re-execing under a pinned interpreter cures - so
// the gate is doing more work than the old sentence claimed, not less. The
// cases below still drive the mismatch branch, because that is what a
// classic fixture plus a second real interpreter can reproduce on a machine
// with no sub-floor Node installed; the mechanism under test is the re-exec
// decision, which is the same one for either failure.
```

## line 42

```
// Issue #105 lane B. This whole file is built on alternateInterpreter()
// finding a real second Node whose ABI the REAL addon cannot load, so
// running KICKOFF_MJS under it reproduces "started under the wrong
// interpreter" for real. better-sqlite3 13's N-API prebuilds load under any
// Node major on this platform/arch, so that premise is gone for the real,
// currently-installed addon: alt.path can now load it fine too, and nothing
// below it ever needs to re-exec.
//
// The re-exec mechanism itself is unchanged and still needs covering, so the
// describe block below runs against a SCRATCH checkout (writeScratchAddon)
// whose addon is test/fixtures/native-addon-abi/'s classic, pre-13 build
// instead of the real one - the one that matches THIS interpreter's own ABI,
// so the healthy-path cases still recover, and alt.path still genuinely
// cannot load it, same as every case here always assumed. Two real
// interpreters are still required (this reconstructs which one CAN load a
// given file, not just that loading fails), so `alt` stays load-bearing.
```

## line 77

```
// Built once, reused by every test below: a scratch checkout whose
// better-sqlite3 addon is the classic build matching THIS interpreter's own
// ABI, so it behaves exactly like the real pre-13 addon used to - loads
// under process.execPath, refuses under alt.path. Skipped entirely when
// unavailable (see SKIP above), so this only runs when there is something
// real for it to load.
//
// WHAT THAT COSTS, named rather than discovered later (hive todo 297 item
// 4): the recovery cases here open a REAL hive store through
// better-sqlite3 12.11.1's driver, which production never runs. So these
// tests carry a dependency on 12.x's JS staying compatible with what
// src/db.ts asks for. The day db.ts uses an API only 13 has, these fail
// together, and the failure will point at re-exec while the cause is the
// fixture's driver. Accepted rather than fixed: the alternative is a second
// set of prebuilt binaries per ABI, and the fixture directory's README is
// explicit that this pair has to stay self-consistent. If you are here
// because six re-exec tests went red at once and the re-exec code did not
// change, check what db.ts started calling before looking anywhere else.
```

## line 99

```
// dispatcher.js reads its exec line back out; writing it by hand rather
// than through dispatcherScript() would silently drift from the format
// readDispatcher actually parses. Imported inside a function per
// test/CLAUDE.md: a static dist/ import hoisted above scratchDirs() picks
// the store for the whole file, even though dispatcher.js itself is
// store-free.
```

## line 145

```
// This cannot distinguish the existsSync(node) guard in kickoff.mjs
// from spawnSync's own result.error fallback a few lines later: a
// missing file trips both, they are deliberately redundant, and both
// converge on identical output by returning without touching
// process.exit either way. Proven by hand: commenting out the
// existsSync guard leaves this test passing unchanged. What this pins
// is the observable contract -- a pinned interpreter that cannot be
// executed falls through safely rather than crashing or hanging --
// not which specific guard caught it.
//
// Todo 307's NAMING of that missing interpreter is asserted where it
// lives, which is guardAbi()'s banner rather than this file: kickoff
// stays silent here, because a session can decline at a later gate and
// never reach a banner at all (test/doctor-session-abi.test.mjs).
```

## line 168

```
// Immune: stderr does carry generated scratch paths (`gone`'s tmp
// path, printed a few lines below), but no such path ever contains a
// literal "[" or "]" - mkdtemp/join produce plain path characters only
// - so nothing but a real "[hive]"-prefixed line can start with it.
```

## line 173

```
// The banner is what names it, and it does so because it is the thing
// that actually printed.
```

## line 180

```
// A dispatcher pinning a perfectly good interpreter (process.execPath)
// would normally recover this, per the first test above. With the
// marker already set, as it would be on a re-exec's own child, the
// check must refuse to act on it, or a pinned interpreter that also
// cannot load the addon re-execs into itself forever.
```

## line 200

```
// The regression this pins: a session running the interpreter that
// actually built the addon must fire normally even when the dispatcher
// names some other (here, broken) interpreter. The re-exec exists to
// fix an ABI mismatch, not to chase the dispatcher's pin for its own
// sake -- a rebuild that has not been re-pinned yet is an ordinary,
// common state (the README's own update recipe warns about it), not an
// exotic one, and it must not cost this session its kickoff.
```

## line 222

```
// The genuine loop risk, reproduced for real rather than asserted from
// reasoning: process.execPath always reports the RESOLVED real path of
// the running interpreter (verified by hand), even when invoked through
// a symlink. So a dispatcher that pins the *unresolved* alias of the
// exact interpreter already running mismatches process.execPath on
// every single hop -- the literal shape of a pin that never converges.
// Confirmed by hand with the loop guard temporarily disabled: this
// construction re-execs dozens of times a second until killed. With the
// guard, it must take exactly one hop and stop, whether or not that hop
// lands on a healthy interpreter (it does not, here: alias and target
// are the same broken binary).
```

## line 248

```
// The two below pin the SAME invariant from both sides: kickoff.mjs's cheap
// gate may only decline for a session dist/kickoff.js would also decline.
// They are a pair on purpose. Either one alone passes while the gate is
// wrong in the other direction, which is exactly how this shipped broken --
// HIVE_AGENT_ID alone read as "worker" here long after issue #27 made it
// true of the lead as well.
```

## line 258

```
// The regression. A lead sets HIVE_AGENT_ID and HIVE_LEAD=1 together
// (src/cli.ts), and dist/kickoff.js's own gate lets it through on the
// strength of the second. A mirror here that reads only the first skips
// the ABI check for the one session type that goes on to open the
// store, and the lead loses its entire digest to the mismatch this
// re-exec exists to repair.
```

## line 279

```
// Exit code and stdout cannot discriminate here: a worker is silent at
// exit 0 whether the gate returned early or dist/kickoff.js's own gate
// caught it one import later, so asserting either would be a test that
// the suite runs. The pinned interpreter is a script that records being
// run instead, which makes "a re-exec happened at all" directly
// observable. It exits nonzero so a gate that wrongly re-execs fails
// loudly on the code as well, rather than only on the sentinel.
```

## line 306

```
// POSIX single-quoting, unconditional -- src/dispatcher.ts's own shQuote for
// the same reason: this builds a shell command line from paths under
// os.tmpdir(), not one a human types, so a bare operand is the wrong default.
```

## line 315

```
// process.cwd() throws ENOENT once its directory has been unlinked out
// from under it, which happens here on purpose (verified by hand: a
// process that already has a directory open as its cwd keeps running
// after that directory is removed, but getcwd()/uv_cwd can no longer
// resolve a path for it). Reproducing that needs the cd and the rm to
// happen in the SAME shell, in order, before kickoff.mjs starts -- a
// spawn() with cwd pointed at an already-deleted directory is a
// different failure (spawn refuses at exec time) and would not exercise
// this at all.
```
