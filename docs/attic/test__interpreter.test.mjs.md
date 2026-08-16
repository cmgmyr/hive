# Attic: test/interpreter.test.mjs

Comments removed from `test/interpreter.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 20

```
// doctor and status both run the janitor, which probes the tmux server; isolate
// first, or these read the one the lead and its workers are running in.
```

## line 25

```
// hive lets the working directory pick its interpreter unless something stops
// it, and better-sqlite3's addon does not load under every Node. What that
// second clause means changed with 13 (issue #105 lane B): "only loads under
// the Node that compiled it" was true of the classic node-gyp build and is not
// true of the N-API prebuild, which loads under any Node providing Node-API 10
// and, below that, kills the process inside dlopen instead of refusing. These
// cover the diagnostic half: doctor naming what it compared, and the guard
// that turns a failure inside an import into a sentence rather than a stack
// trace - or, for the sub-floor case, into a refusal rather than exit 139.
```

## line 37

```
// Point the in-process dist imports at the scratch store before any of them
// resolve dataDir. See assertScratchStore.
```

## line 54

```
// An absolute interpreter that is definitely not the one running the suite.
// A literal like /usr/local/bin/node is not: that is where nodejs.org's
// installer puts Node, so on such a machine the fixture would silently BE
// process.execPath and every "pins a different interpreter" assertion would
// invert. Derived from execPath, so it cannot collide with it.
```

## line 61

```
// A NOTE ON THIS FILE'S doesNotMatch ASSERTIONS, checked against the shape
// that broke test/attach-mode.test.mjs (see its header): a negative assertion
// whose haystack is wider than the thing under test can match GENERATED DATA
// for a reason unrelated to what the test names. Audited (todo 323): every
// doesNotMatch below was traced to its haystack's construction and none is
// exposed, but for THREE different reasons worth stating rather than
// assuming (counselors review: an earlier version of this note claimed
// "every pattern here" fell into the first reason, which was false for at
// least two sites - correcting that here rather than leaving a universal
// claim a reader would trust file-wide).
//
// Most of the real CLI stdout/stderr checked here (doctor, setup) DOES carry
// generated data elsewhere in the string - dirs.tmp and dirs.projectDir are
// mkdtemp() paths, and writeScratchAddon()'s root and status.addon can appear
// in a diagnostic line. What makes MOST of those assertions immune is that
// their pattern is a multi-word literal ("npm install && npm run build",
// "claude mcp add", the OFFER sentence) or a column-aligned marker
// ("warn {2}dispatcher", "ok {4}better-sqlite3: ..."), and mkdtemp's random
// suffix is six characters from a plain alphanumeric set - no spaces, no
// "&&", no underscores. A path built from that suffix plus this file's own
// (also space-free) literal segments structurally cannot spell any of these
// patterns, the way attach-mode's scratch suffix could spell "-CC": that flag
// was two characters wholly inside the alphanumeric charset a path can
// produce.
//
// One site does NOT fit that shape and needs its own reason: the
// `durabilityLines()` check (`/cannot be removed|is yours to keep\b|safe/`)
// includes the bare word "safe", four letters fully inside mkdtemp's own
// alphabet - the same size of exposure as the "gone" this lane fixed
// elsewhere, not covered by the punctuation argument above. It is immune
// anyway, but for the THIRD reason below: durabilityLines()'s "unowned"
// branch (src/dispatcher.ts) returns a fixed literal string regardless of
// its input, and every path this call site passes it is a hand-typed
// fixture (`/opt/homebrew/bin/node`, etc.), never one resolved at run time -
// so no generated data reaches this haystack at all, the same shape as the
// AbiStatus fixtures below.
//
// The rest never have generated data in the specific string being matched at
// all: the "mismatch"/"missing"/"linuxMismatch" AbiStatus objects the
// abi.ts-unit-level tests build by hand carry a literal "/x/..." addon path
// the test itself wrote, not one resolved at run time, and describeAbi()'s
// "napi" branch (the /NaN/ check) never reads status.addon in the first
// place, so no path - generated or not - reaches that string.
```

## line 116

```
// THIS ASSERTION USED TO BE THE OPPOSITE, and it could not fail. It read
// "addon built for NODE_MODULE_VERSION (\d+), matches" and checked that
// number against the interpreter's - but checkAbi() set it BY COPYING the
// interpreter's, so the two agreed by construction whatever the addon
// was. Same shape as
// dead-ends/2026-07-29-seeding-a-test-row-with-the-value-it-asserts.md.
// The statement was also false: an N-API addon is built for no
// NODE_MODULE_VERSION at all.
```

## line 129

```
// What a passing run may say is what was actually compared: the level the
// installed package declares, against the level this Node provides. Both
// are real reads from independent places.
```

## line 138

```
// better-sqlite3 13's N-API prebuilds are named by platform+arch
// (darwin-arm64.node), not the pre-13 build/Release/better_sqlite3.node;
// addonPath() (src/abi.ts) falls back to the old name for a platform/arch
// with no prebuild, so both are real, current shapes.
```

## line 148

```
// Issue #21. Doctor is not a passive reader of the environment: its stale
// state check runs the janitor, which probes the server, and its sessions
// check runs `tmux ls`. Both went to whatever server the ambient env named,
// which during development is the one the lead and its workers run in.
//
// One session on the isolated server, and doctor must report that one and
// nothing else. Listing it at all proves doctor read the isolated server,
// since it exists nowhere else. Listing ONLY it is the half that catches a
// regression, and it is worth being honest that its power depends on the
// developer having live hive sessions, which is exactly when this matters
// and never on a CI runner. suite-isolation.test.mjs is what carries CI.
```

## line 176

```
// Null, not the running NODE_MODULE_VERSION. checkAbi() never reads the
// addon's build ABI, so a number here would be this process's own value
// laundered into a claim about the file.
```

## line 182

```
// The lazy-binding half of this - that requiring the package does not
// pull in the addon - is now its own test below, with a positive control.
// It used to be an inline probe here, and that probe had gone dead: it
// looked for a require.cache key ending "better_sqlite3.node", which is
// the PRE-13 filename. v13's prebuild is darwin-arm64.node, so the probe
// reported "not-loaded" whether or not the addon had loaded.
```

## line 190

```
// ISSUE #105 LANE B1, ROUND 2, ITEM 4. This is the claim the whole guard
// design rests on: db.ts's `import Database from "better-sqlite3"` runs
// BEFORE guardAbi(), and backup.ts does the same, so if the package's
// entrypoint ever loaded the addon itself the check would arrive after the
// process was already dead. Nothing in the suite tested it - it is an
// empirical fact about better-sqlite3's internals, hive declares ^13.0.3,
// and a consumer can resolve any later 13.x.
```

## line 198

```
// One child does both halves so the two readings come from one process
// and one resolution of the package.
```

## line 209

```
// The exact form db.ts uses, not a bare require.
```

## line 219

```
// Without this the test passes when the import silently fails, which is
// the shape that makes "nothing was loaded" meaningless.
```

## line 229

```
// THE POSITIVE CONTROL, and the reason the assertion above means
// something: the same instrument, in the same process, DOES see the addon
// once a Database is constructed. Any probe that cannot show this is
// reporting "not loaded" about its own blindness - which is exactly what
// the inline probe this replaces had started doing, by matching a
// filename that no longer exists.
```

## line 262

```
// THIS ASSERTION HAS PINNED TWO REMEDIES THAT COULD NOT WORK, which is
// the reason it is worth this much comment. First "npm install && npm run
// build" - neither half produces better_sqlite3.node. Then a bare "Install
// it: npm install", which reads correct and is not: measured against
// 13.0.3, deleting the prebuild from an installed tree and running `npm
// install` prints "up to date" and restores nothing, because npm does not
// re-examine a package already present at the locked version. A test
// demanding a command is what keeps that command in the product, so the
// test has to know which command actually restores the file.
```

## line 305

```
// `hive setup` pins whatever Node runs it, and the `hive` on PATH is the
// command that just failed. Advice that loops back to it is no advice.
```

## line 310

```
// With a dispatcher on disk, hive knows an interpreter that works.
```

## line 315

```
// `Number(undefined)` is NaN and `NaN < 10` is FALSE, so the level check
// read as "high enough" on any runtime omitting process.versions.napi and
// fell through to the require - a fail-open in the one comparison this
// file exists to hold shut. Anything that cannot report a level cannot
// load an N-API addon either, so "absent" has to mean "below".
//
// A child process, because the level has to be gone before checkAbi runs
// and this one has already answered.
```

## line 344

```
// Issue #105 lane B1, item 4. addonPath() mirrors
// better-sqlite3/lib/binding.js by hand, and had drifted from it twice.
// Both drifts are silent in the direction that matters: one refuses a tree
// that works, the other just costs.
```

## line 354

```
// No prebuilds/ entry at all, addon at build/Debug only. binding.js loads
// this tree; addonPath() used to skip straight from prebuilds/ to
// build/Release and report "missing", so guardAbi exited 1 on a checkout
// better-sqlite3 itself would have opened.
```

## line 365

```
// process.report.getReport() builds a full diagnostic report - heap walk,
// libuv handle dump - and addonPath() called it unconditionally, on the
// module-load path of every hive process and every SessionStart kickoff,
// to read a glibc field that exists only on linux. binding.js tests the
// platform first; so does this now.
//
// Counted in a child process, since checkAbi has already run in this one.
// This can only fail off linux, which is the macOS leg's job - on linux
// the call is correct and expected. Said out loud rather than left as a
// test that quietly proves nothing on two of the three CI legs.
```

## line 394

```
// Issue #105 lane B1. The Node-API floor, which is what N-API replaced the
// NODE_MODULE_VERSION equality with. These two tests are a pair: the first
// pins the number hive derives its engines floor from, the second proves
// hive refuses rather than dies when an interpreter is below it.
```

## line 400

```
// 10 is not copied from anything this process knows: it is what
// better-sqlite3 13's binding.gyp says, and the whole guard is void if
// that read ever silently starts returning null (binding.gyp dropped from
// the tarball, the define renamed). Then the guard would pass everything
// through to a require that segfaults, in exactly the shape this lane was
// opened to fix, and nothing else in the suite would notice.
```

## line 408

```
// The running side of the comparison, so a reader can see both halves are
// real values from independent sources rather than one value twice.
```

## line 419

```
// ONE variable moves: the addon installed here is the real, working one,
// and only the DECLARED Node-API level is impossible. So the scratch tree
// runs fine with the guard removed, which is what makes a pass mean
// something. 99 cannot be reached by any Node, so this discriminates on
// every machine and every CI leg without a sub-floor interpreter -
// measured against a real one separately, see the PR body.
```

## line 432

```
// The advice that started this: a source build reads the same binding.gyp,
// so telling the user to build is telling them to reproduce the problem.
// status.stderr DOES carry generated data here - the scratch addon path
// under root (dirs.tmp's mkdtemp suffix) prints on its own line above
// this check - but the pattern needs a literal space and "&&", which no
// path built from that suffix or this file's own literal segments can
// contain. See the file-level note near OTHER_NODE.
```

## line 441

```
// stdout is a JSON-RPC stream for the MCP server; the diagnostic stays off it.
```

## line 451

```
// Issue #105 lane B. better-sqlite3 13's N-API prebuilds load under any
// Node major on this platform/arch (measured: the identical darwin-arm64
// prebuild opened a database under NODE_MODULE_VERSION 137 and 147), so
// alternateInterpreter() can no longer make the REAL addon mismatch - both
// of the tests below used to run the real addon under a genuinely
// different Node and watch it refuse. There is nothing left in
// node_modules capable of refusing that way.
//
// Rather than document the mismatch as unreachable, these swap in
// test/fixtures/native-addon-abi/'s classic (pre-13, NODE_MODULE_VERSION-
// locked) build in place of the real prebuild, in a scratch checkout that
// does not touch the real node_modules other tests in this suite run
// against concurrently. That reconstructs a genuine ERR_DLOPEN_FAILED from
// Node itself - not a fabricated error string - so classifyAddonLoadError's
// "mismatch" branch (src/abi.ts) still has something real to classify.
```

## line 492

```
// stderr also carries the scratch addon path (status.addon, under root)
// on its own line, same as the napi-floor case above. Still immune: an
// mkdtemp suffix and this file's own literal path segments are plain
// alphanumeric, never underscores, so nothing generated here can spell
// "ERR_DLOPEN_FAILED". See the file-level note near OTHER_NODE.
```

## line 498

```
// stdout is a JSON-RPC stream for the MCP server; the diagnostic stays off it.
```

## line 502

```
// The other reachable failure (src/abi.ts's AbiStatus["missing"]): nothing
// built at all. No fixture or alt interpreter needed - a scratch checkout
// with an empty prebuilds/ reaches this on any platform.
```

## line 515

```
// The remedy has to be one that can actually put the file there, and this
// is the end-to-end half of the unit assertions above: `npm run build` is
// tsc, and a plain `npm install` over an already-unpacked package reports
// "up to date" without restoring the addon. Both were once printed here.
```

## line 529

```
// doctor answers "what does typing `hive` actually run" from PATH, not from
// HIVE_BIN_DIR (reportDispatcher -> firstHiveOnPath). So HIVE_BIN_DIR alone
// does not isolate these tests: an inherited PATH carrying a real
// ~/.local/bin/hive wins over the scratch one, and doctor then reports the
// developer's own dispatcher. That made two of the tests below pass only on
// a machine that had never run `hive setup`, which is to say green on CI and
// on any checkout whose owner had not yet followed hive's own README.
// PATH is an input to what is under test here, so every case states it.
// node comes from PATH too: runCli spawns a bare "node".
```

## line 553

```
// Derived from process.execPath, never a literal, and the reason is no
// longer the one this comment gave ("the Node running setup is the Node
// that built better-sqlite3, so the pin and the ABI cannot disagree").
// Nothing builds better-sqlite3 here now. What is asserted is the property
// that survived: setup pins the interpreter it is RUNNING UNDER, which is
// what makes "run setup with the Node you want pinned" the whole
// instruction everywhere hive gives it.
// includes, not a regex built from a path: a checkout or a Node install
// under a directory with a regex metacharacter in it would otherwise fail
// here for a reason that has nothing to do with hive.
```

## line 568

```
// The point of the whole feature: PATH cannot pick the interpreter.
```

## line 587

```
// The durability paragraph has one branch per kind of interpreter, and which
// one a machine produces says nothing about whether the others are right.
// The version this replaced asserted "one of two texts appeared", passed on
// a laptop whose Node is a version manager's, and broke on a CI runner whose
// Node is in a hosted toolcache: neither branch it accepted. So each branch
// is driven here with a path chosen by the test, and the wiring is a
// separate assertion.
```

## line 614

```
// The escape hatch has to NAME an interpreter. This asserted
// `npm install && npm run build && hive setup` until issue #105's
// cleanup lane, which is advice that cannot work: `hive` on PATH is the
// dispatcher pinned to the very Node being moved away from, so setup ran
// under it and re-pinned it. Pin the property rather than the sentence -
// an absolute interpreter, then setup, with no bare `hive` anywhere.
// The path is QUOTED, and that is asserted rather than assumed. This
// read `\S*dist/cli.js` until the review gate pointed out it can never
// cross a space, so it passed only because this checkout has none and
// would have failed on the space-containing path it was supposed to
// cover. Pinning the quotes is the property; the shape was an accident.
```

## line 633

```
// Homebrew: genuinely outside a version manager
```

## line 635

```
// The exact path that broke CI. A hosted toolcache is not a version
// manager's install directory and not a system Node either.
```

## line 638

```
// A version manager hive does not know about. It lands here too, which
// is why this branch must not claim the interpreter is safe.
```

## line 650

```
// The list can miss a version manager but never invent one, so the
// claim it must never make is that nothing can remove this Node.
```

## line 659

```
// Which branch that is depends on the machine, which is the point: the
// text of each is pinned above, and this pins that setup prints the one
// matching what it just wrote into the dispatcher.
```

## line 665

```
// Regenerating is part of updating, or the pin drifts from the build.
```

## line 731

```
// binDir comes off PATH as well as out of HIVE_BIN_DIR: the earlier cases
// left a real dispatcher there, and doctor would report that one rather
// than the absence this asserts.
```

## line 754

```
// A registration hive cannot vouch for is not a broken install. The claim
// is that the warning does not change doctor's verdict, so it is made by
// comparing two runs that differ only in the registration. Asserting
// exit 0 outright made this test a proxy for the whole environment, and
// it failed on a runner with no `claude` binary over a check that has
// nothing to do with registrations.
```

## line 767

```
// The exit code alone saturates: on a box where doctor already fails for
// an unrelated reason, both runs are 1 and the comparison proves nothing.
// The summary line carries the count, so it keeps its power everywhere.
// config-warnings.test.mjs compares the same line for the same reason.
//
// THE PROBLEM COUNT, not the whole line. Todo 292 put the warn count on
// that line too, so comparing the line whole now fails on the one thing
// these two runs are SUPPOSED to differ by - the registration warning
// itself - and says nothing about whether it was counted as a problem.
```

## line 781

```
// The positive control for the comparison above: if the two runs did not
// actually differ in their warnings, the equal problem counts would be
// vacuous - two identical runs always agree.
```

## line 816

```
// Re-registering under hive's own name would leave the user with two
// servers, so the fix keeps the name they chose.
```

## line 824

```
// Unquoted, this breaks on the machine hive was written on: a version
// manager's interpreter lives under "Application Support".
```

## line 839

```
// Pinning the `hive` command says nothing about the MCP server: Claude Code
// starts that from its own registration. Setup is where a user is already
// acting on instructions, so it names a registration that disagrees with the
// pin it just made, and says nothing when there is nothing to fix.
```

## line 848

```
// An earlier suite leaves a project-scope registration in this directory.
```

## line 857

```
// Doctor's words, not a second description of the same problem.
```

## line 871

```
// Handing someone a command to run when nothing is wrong trains them to
// ignore the times something is.
```

## line 887

```
// Deliberate: setup reads one config dir and at most one project's
// .mcp.json, so it cannot tell "not registered" from "registered
// somewhere I cannot see". The README supplies the line for a fresh
// install; doctor reports the absence as info.
//
// The fixture is a config with no mcpServers block, which is the state
// setup cannot interpret. A config that HAS the block, empty or not, is a
// fact about a file rather than an inference, and the suite below owns it.
```

## line 902

```
// The one registration state setup can establish rather than infer: this
// config file exists, parses, lists MCP servers, and hive is not among them.
// Round 2 stays silent on "no hive registration found", which is an inference
// about the machine; this is a fact about a file hive just read.
```

## line 909

```
// Its own config dir and bin dir so deleting the file cannot disturb, or be
// disturbed by, the suites either side of this one.
```

## line 928

```
// Empty is the shape Claude Code writes for someone who has never added a
// server, which is the fresh install this exists for.
```

## line 934

```
// An offer, not a fault: the "!" block is round 2's, for a registration
// that disagrees with the pin. A fresh install has nothing wrong with it.
// (setup's other "!" block, the version-manager caveat, is unrelated.)
```

## line 970

```
// The case the whole silence decision was built around. hive is correctly
// registered project-scope, and the user config legitimately has an
// mcpServers block without hive in it. Offering here would tell someone
// whose setup is right to add a second, duplicate registration.
```

## line 990

```
// Regression pin, not a duplicate of the round 2 cases: the offer must
// stay out of both, including the bare one where a `claude mcp add` line
// does print for a different reason.
```
