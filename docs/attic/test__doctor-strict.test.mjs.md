# Attic: test/doctor-strict.test.mjs

Comments removed from `test/doctor-strict.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 16

```
// Todo 292. `hive doctor`'s exit code ignored warns, so an update script
// ending in `... && hive doctor && echo updated` reported success with an
// interpreter-mismatch warning on screen - the single condition such a script
// exists to catch.
//
// TWO SHAPES SHIPPED HERE, and the second is the one to understand. `--strict`
// first promoted EVERY warn, which made it a flag that cannot return 0 on the
// machines it exists for: doctor warns about the lead row after every normal
// session exit, and a registered project pinning a sub-floor Node warns on
// every run by design. Both counselors seats found it independently. Now each
// warn site declares whether it GATES, `--strict` promotes only those, and the
// DEFAULT IS NON-GATING so a warn added later cannot break an update chain the
// day it lands.
//
// HOW THESE TESTS CAN FAIL, which is the part that has gone wrong here before.
// Exit codes saturate at 1, and doctor already exits 1 on CI over a missing
// `claude` binary, so comparing two exit codes to prove --strict did something
// passes on exactly the box where the regression matters
// (.claude/sessions/dead-ends/2026-07-28-exit-code-comparison-as-environment-proof.md).
// Every claim below is made against the COUNTS on the summary line, which do
// not saturate. The exit-code assertions that remain are either unambiguous (a
// refused argument, where nothing else ran) or conditional on those counts.
```

## line 44

```
// HIVE_BIN_DIR at a directory with no dispatcher, and a PATH with no `hive` on
// it, so no DISPATCHER warn can appear: every dispatcher warn gates, and one
// arriving from the developer's own ~/.local/bin would silently turn the
// non-gating cases below into mixed ones. `node` still resolves, since the
// probe and the CLI both need it.
```

## line 69

```
// A NON-GATING warn that is present on every machine and every CI leg, and
// that nothing about the environment can take away: a hive.yml whose
// layout key is misspelled parses with a warning by design.
```

## line 73

```
// No registration at all, so nothing gating can come from there either.
```

## line 80

```
// The guard that keeps everything below from being vacuous: with no
// warnings at all, every count matches trivially.
```

## line 95

```
// THE CASE THAT MATTERS MOST, and the one the first shape got wrong: the
// promote-everything version turned this warn into a problem, so an update
// chain ending in `hive doctor --strict` failed on a healthy machine.
```

## line 107

```
// SAID OUT LOUD, because a green here is not the evidence it looks like:
// this test passes against the promote-everything code too. There the
// warn IS promoted, the problem count is 1, and both the implication and
// the conditional below are satisfied honestly. The discriminating claim
// is `promotedCount === 0` in the test above; this one pins the property
// that connects it to an exit code.
//
// The implication rather than a constant: on a box where an unrelated
// check FAILs (CI has no `claude`) doctor correctly exits 1, so the claim
// that survives everywhere is that the exit code agrees with the count on
// the summary line, not that it is any particular number.
```

## line 120

```
// And on a machine with nothing else wrong, the end-to-end statement.
```

## line 125

```
// A registration running a bare `node` is the gating warn with the fewest
// moving parts, and it is the exact condition todo 292 was filed about:
// the dispatcher and the MCP server naming different Nodes.
```

## line 132

```
// One more warn than the non-gating run, and this time it IS promoted.
```

## line 140

```
// Bare doctor is unchanged by any of this: the gating warn is still just a
// warn without the flag.
```

## line 152

```
// The other half of todo 292's report: doctor used to print "All good."
// with warns on the screen above it.
```

## line 158

```
// A typo'd flag must not produce a clean-looking run: `hive doctor
// --stict` in an update script would otherwise report success while
// gating on nothing at all, which is todo 298's shape one surface over.
// Unambiguous exit code here - nothing else in doctor ran.
```
