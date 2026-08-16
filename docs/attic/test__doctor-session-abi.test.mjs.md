# Attic: test/doctor-session-abi.test.mjs

Comments removed from `test/doctor-session-abi.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 17

```
// Todos 306 and 307. Two questions doctor could not answer, and one silent
// failure in the hook that makes the second one matter:
//
//   306: can a session starting in ANOTHER registered project load hive's
//        addon? Everything else doctor reports is about the machine and the
//        directory doctor itself ran in. A single project pinning a Node
//        below better-sqlite3's floor is why one symptom looked intermittent
//        and project-specific for as long as that project existed.
//   307: the SessionStart hook's re-exec resolves ONE pinned interpreter. If
//        a version manager retires it, the pre-#122 banner returns with the
//        fix still in place and nothing naming the pin as the reason.
//
// WHAT WOULD MAKE THESE TESTS GREEN WHILE THE BEHAVIOUR IS BROKEN, since that
// is the question test/CLAUDE.md asks and this lane's whole subject is a
// measurement:
//
//   - "doctor names an interpreter per project" would pass trivially if
//     doctor reported its own process.execPath for every project. So the
//     per-directory case puts a REAL version-manager-shaped shim first on
//     PATH and requires doctor to name a DIFFERENT absolute path for the
//     project that shim redirects - derived from alternateInterpreter(),
//     never a literal, so the fixture cannot collide with process.execPath.
//   - "the probe reports a failure" would pass against a mocked verdict. So
//     the failing verdict is produced by a scratch better-sqlite3 declaring a
//     Node-API level no interpreter provides, or by a pre-N-API addon a second
//     real interpreter genuinely cannot load.
//   - COUNSELORS ROUND 1, FINDING 2, and it is the reason this file grew: the
//     info-vs-warn decision itself had no test. Mutating sessionStartVerdict
//     to `if (true)` made doctor report "which loads hive's addon" for a
//     project that cannot, with the whole suite green. The pure unit block
//     below pins every branch, and the end-to-end block pins that doctor is
//     actually wired to it - a unit test alone would still pass with
//     probeSessionInterpreter hardcoded to ok.
//   - Exit codes are not asserted anywhere here. Doctor already exits 1 on CI
//     over a missing `claude`, and exit codes saturate at 1.
//
// WHAT THIS FILE CANNOT REACH, stated rather than implied: a REAL sub-floor
// Node resolved from a real .tool-versions. This machine has one Node and no
// asdf, and a Node below the floor cannot run doctor in the first place.
```

## line 62

```
// A scratch checkout whose better-sqlite3 declares a Node-API level no
// interpreter provides, so checkAbi() refuses for real under any Node, on any
// machine and every CI leg. ONE variable moves: the addon installed is the
// real, working one, so the tree runs fine with the requirement removed, which
// is what makes a refusal mean something. The assertion is inside the helper so
// no caller can drop the control and silently pass `prebuild: undefined`.
```

## line 75

```
// The two probe shapes the verdict consumes, built by hand so every branch is
// reachable without a second machine. These are the only hand-built values in
// this file; everything they feed is the real function.
```

## line 90

```
// COUNSELORS FINDING 2. This block exists because the decision it covers had
// no test at all: the end-to-end cases below assert which interpreter got
// named, never whether hive believed it worked. Pure and exported, so this
// needs no second Node, no scratch tree and no spawn.
```

## line 110

```
// The thunk is the cost decision made testable: resolving the re-exec
// target now costs a spawn, and a healthy machine must never pay it.
```

## line 125

```
// Counselors P1, the scenario in one assertion: doctor runs under Node 24,
// the project resolves Node 20, and a stale dispatcher pins an EXISTING
// Node 22.13 that is itself below the floor. Before this round the verdict
// read "an existing file" as "session start survives" and said so.
```

## line 185

```
// COUNSELORS P2, and .claude/rules/native-addon.md's own words: "Any advice
// ending in a bare `hive setup` is a loop, and this repo has shipped that loop
// TWICE." This is the property, asserted at the new site because
// test/interpreter.test.mjs asserts it over abiFixLines' output specifically
// and so could not see a fourth remediation surface being added elsewhere.
```

## line 220

```
// The control for every per-project claim below. A probe that reported
// a constant, or the spawning process's own interpreter, passes the
// test above and fails this one.
```

## line 230

```
// Same construction interpreter.test.mjs uses for the in-process guard;
// see brokenAddonTree for why it discriminates.
```

## line 236

```
// Exit 0 with a verdict on stdout, NOT a crash: doctor reads this back,
// and a probe that dies has told it nothing.
```

## line 246

```
// Todo 307, driven by the GENERAL condition rather than the specific one.
// "asdf pruned 24.12.0 on a second machine" cannot be reproduced here - one Node,
// no asdf - but "the interpreter the dispatcher pins is no longer on disk" is
// a scratch dispatcher naming a path nobody ever created, which is the same
// condition with the version manager taken out of it.
```

## line 258

```
// doctor answers "what does typing `hive` run" from PATH, so HIVE_BIN_DIR
// alone does not isolate this: a real ~/.local/bin/hive on the developer's
// PATH would win and doctor would report THAT dispatcher. Same reasoning as
// interpreter.test.mjs's own hivelessPath.
```

## line 266

```
// One tree, reused: writeScratchAddon copies all of dist/ and claude-plugin/
// and symlinks every real node_modules entry, so building it per test is a
// real cost. Same pattern as kickoff-reexec.test.mjs's own scratch tree.
```

## line 277

```
// A lead checkout: hive.yml, a profile this machine has, and the default
// lead branch. This one reaches the store and so reaches the banner.
```

## line 282

```
// Identical except for the branch, which is what makes it the control.
```

## line 287

```
// One doctor run, read by the two cases below. Doctor is the most
// expensive command in this suite and now forks a probe per project.
```

## line 294

```
// The path on the warn line, not only on the info line above it: this is
// the line that gets read on its own out of an update script's output.
```

## line 300

```
// `hive` on PATH is the dispatcher whose exec target just went missing, so
// the old advice did not merely re-pin the wrong Node - it failed with an
// exec error naming a path the user has never seen.
```

## line 307

```
// IMMUNE to generated data: report.stdout does carry scratch paths (this
// describe block's goneNode/leadProject/featureProject), but every
// segment of them comes from mkdtempSync/join - alphanumeric and hyphens
// only, never a space or "&" - so they can never reproduce this literal,
// space-and-&&-laden phrase. A match here can only mean doctor's own
// code actually emitted the old, retired remediation advice.
```

## line 317

```
// Todo 307's naming lives in guardAbi() (src/abi.ts), NOT in kickoff.mjs.
// The scratch tree declares an impossible Node-API level, so checkAbi()
// fails under the running interpreter and this reaches the banner with no
// second Node needed.
```

## line 334

```
// The discriminator. Same broken tree, same failing addon, same banner -
// only the pin differs. Without this, "the banner says something about a
// dispatcher whenever the addon fails" would satisfy the case above just
// as well as "when the PIN is gone".
```

## line 344

```
// IMMUNE to generated data, same reasoning as the "npm install && npm run
// build && hive setup" check above: "is not on disk" is a fixed suffix in
// sessionProbe.ts's own template (the dynamic part, `${pinned.path}`, is
// interpolated BEFORE it), and every scratch path in this describe block
// is alphanumeric-and-hyphen only, so it can never contain the space
// characters this phrase requires.
```

## line 355

```
// COUNSELORS FINDING 1, and the reason the message moved out of
// kickoff.mjs. This is the same directory as the banner case above except
// for its branch: kickoff clears its two cheap mirrored gates, checkAbi()
// fails, the pin is gone - and then runKickoff declines at the lead-branch
// gate (src/kickoff.ts) BEFORE db.js is imported, so no banner follows.
// For one commit this printed four [hive] lines here: net-new output on a
// session that was silent and working. Kickoff's contract is silence, and
// this lane may only replace a misleading message, never add one.
```

## line 376

```
// COUNSELORS, SMALLER FINDING: these two cases need no second Node, and they
// sat inside a describe gated on one - so on a one-Node machine the gate
// they pin was untested and the suite still reported green. "A matrix that
// hides its own skips is worse than one leg" (.claude/rules/native-addon.md).
```

## line 391

```
// Registered, then the config removed: `hive init` is the only way to get
// a project row here and it always writes one.
```

## line 397

```
// Both kickoff gates return before the addon without one, so a warning
// there would be a warning about nothing - and the spawn would be paid for
// a project with nothing to say.
```

## line 409

```
// Every spawned worker gets HIVE_PROJECT_LOCK=1, and doctor is a command
// workers run. Before this lane doctor was cwd-scoped, so a machine-wide
// loop that prints every project's absolute path and spawns a process in
// each is new reach into a locked context.
```

## line 430

```
// One shim that resolves a different interpreter per directory - the exact
// mechanism a version manager uses, and the reason this question cannot be
// answered without spawning something.
```

## line 462

```
// The discriminator. If doctor answered from its own process instead of
// spawning per directory, this line would name process.execPath too.
```

## line 477

```
// The shim's own words: doctor has to pass the reason through, or a
// reader has nothing to act on.
```

## line 484

```
// `pwd -P`, not $PWD: a shell inherits PWD from its parent and only corrects it
// at startup, and the physical path is what the project rows hold (addProject
// realpaths, and os.tmpdir() sits under a symlinked /var on darwin).
```

## line 502

```
// THE END-TO-END HALF OF COUNSELORS FINDING 2, and the only construction on a
// one-Node-family machine that can produce a genuinely failing project verdict
// through doctor itself. A scratch checkout carrying test/fixtures'
// pre-N-API addon built for THIS interpreter's ABI: the scratch `hive doctor`
// runs fine, and a project whose shim resolves the second interpreter gets a
// real ERR_DLOPEN_FAILED from Node rather than a fabricated one.
//
// Without this block the unit tests above still pass with
// probeSessionInterpreter hardcoded to `ok: true`. With it, that mutation
// reports a loading addon for a project that measurably cannot load it.
```

## line 545

```
// AN ALIAS OF THE SAME BROKEN INTERPRETER, which is what makes the
// "pinned interpreter cannot load it either" branch reachable with only
// two Nodes on the machine: process.execPath always reports the RESOLVED
// real path, so a pin naming the symlink is a DIFFERENT path than the
// probe reports while being the same binary. kickoff-reexec.test.mjs uses
// the identical construction for the same reason.
```

## line 574

```
// The control in the same run: doctor is not simply warning about
// everything. This is the mutation guard - `if (true)` in the verdict, or
// `ok: true` in the probe, breaks one of these two lines.
```

## line 591

```
// COUNSELORS P1 END TO END: the dispatcher pins an interpreter that EXISTS
// and cannot load the addon. The old code reported this project as covered
// by the re-exec; the hook would have re-execed into it and printed the
// banner anyway. Nothing but probing the pin can tell these two apart -
// existsSync answers identically here and in the covered case above.
```

## line 602

```
// IMMUNE to generated data, same reasoning as the unit-level version of
// this same assertion above: "survives this" is a fixed phrase inside
// sessionProbe.ts's own hard-coded sentence, and this describe block's
// scratch paths (good/bad/pinGood/pinSame/pinCannot, all mkdtempSync +
// join) never contain a space, so they cannot supply it.
```
