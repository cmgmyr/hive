# Attic: test/dependency-versions.test.mjs

Comments removed from `test/dependency-versions.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Issue #105. @types/better-sqlite3 described better-sqlite3 v7 while the
// runtime ran v12, for the life of the project, and nothing noticed for
// sixteen months. The issue that started this asked for a check that the
// types' major matches the runtime's major. THAT IS NOT IMPLEMENTABLE:
// DefinitelyTyped's major.minor convention has plainly diverged from the
// package it describes. There is no 8.x of @types/better-sqlite3 at all; the
// DT line jumps 7.6.13 straight to 9.6.0, which is the ts5.7-ts6.0 tag, while
// better-sqlite3 itself is at major 12 going on 13. A "majors must match"
// assertion would be false the moment it was written, and loosening it into
// something that cannot fail would be worse than deleting it.
//
// So this pins the VERIFIED PAIR instead: the exact (better-sqlite3,
// @types/better-sqlite3) versions that a human has actually built and opened
// a real store under, together. Any bump to either side fails this test until
// somebody updates VERIFIED_PAIR deliberately - which is the exact event that
// went unnoticed for sixteen months, now forced into the open. A bump to only
// one side (e.g. types alone, or the addon alone) is exactly what this
// catches; a coincidental matching pair of version numbers cannot satisfy it
// by accident, because there is nothing coincidental to match.
//
// If you are updating this because a lane just bumped one of these packages:
// confirm the new pair actually opens a real store under the interpreter hive
// runs (see .claude/rules/native-addon.md - `require()` proves nothing), then
// move VERIFIED_PAIR to match package.json and say so in the PR body. That is
// this check doing its job, not a check to route around.
```

## line 54

```
// Issue #105 lane C, and the reason this is NOT a second VERIFIED_PAIR.
// Counselors round 20 asked for the pair idea to be extended to zod, on the
// argument that a types package silently describing a different major went
// unnoticed for sixteen months and zod moves its types substantially between
// majors. THE PAIR SHAPE DOES NOT TRANSFER, because zod has no second side to
// drift from: it ships its own types, there is no @types/zod, and a version
// pin on zod alone would only restate what package.json already says.
//
// The event that WOULD go unnoticed for zod is A SECOND COPY OF IT IN THE TREE,
// and getting the reason right matters more than the check does.
//
// THE FIRST VERSION OF THIS COMMENT SAID "instanceof is false across two copies,
// so the SDK stops recognising hive's schemas". THAT IS FALSE, on both halves,
// and it is corrected here rather than softened because a load-bearing comment
// stating a wrong mechanism is how this project keeps getting bitten.
//   The SDK does NOT use instanceof on the tool path. It detects v4
//   STRUCTURALLY - `!!schema._zod` in server/zod-compat.js - and dispatches on
//   shape, so a schema from a different physical copy is recognised normally.
//   The one instanceof in server/mcp.js (`field instanceof ZodOptional`) is on
//   the PROMPT path and guards completion detection; hive's registerPrompts
//   passes no argsSchema at all, so it never runs here.
//
// The scarier mechanism proposed in its place - that zod 4 moved .describe()
// into a module-level singleton, so two copies would look up metadata in the
// wrong registry and every description would silently vanish from tools/list -
// IS ALSO NOT WHAT HAPPENS, and it is worth knowing why. The write side
// (zod/v4/classic/schemas.js) and the read side (zod/v4/core/to-json-schema.js,
// `params?.metadata ?? globalRegistry`) are both real. But the registry is not
// module-level. zod/v4/core/registries.js pins it to the REALM:
//     globalThis.__zod_globalRegistry ??= registry()
// so every copy in a process shares one registry object, which is zod's own
// deliberate defence against exactly this hazard. Measured, not reasoned: two
// physically separate zod 4.4.3 installs, `A.core.globalRegistry ===
// B.core.globalRegistry` is true in either load order, and converting a
// B-built schema with A's toJSONSchema keeps the description. Descriptions do
// not vanish.
//
// SO WHAT IS THIS CHECK ACTUALLY FOR, honestly, now that the dramatic version
// is gone? A second copy has no demonstrated failure mode on hive's tool path
// today. It is worth failing on anyway, for a smaller and more durable reason:
// a duplicate means hive's declared zod range and its consumers' have DIVERGED,
// and the SDK is being handed schemas built by a version it does not declare
// support for. The compat layer's structural detection works across the pairs
// tried here, but it is version-sensitive by construction, and the registry
// sharing that saves the descriptions is an INTERNAL of zod's - an undocumented
// globalThis key that exists for this hazard and can change without a major.
// Failing on the divergence is cheap; discovering which internal stopped
// holding is not. Do not restore the description-loss claim without
// re-measuring it against the zod actually installed.
//
// It is installable today. @modelcontextprotocol/sdk@1.30.0 lists zod in BOTH
// dependencies and peerDependencies as "^3.25 || ^4.0". While hive's own
// declaration overlaps that range npm dedupes to one copy at the root; the day
// hive moves to a zod the SDK's range excludes, npm satisfies the SDK with a
// NESTED copy and installs cleanly with two.
//
// THE CHECK IS DELIBERATELY BROAD: it fails on a second zod ANYWHERE, not only
// under the SDK's subtree. An unrelated dependency vendoring its own nested zod
// would redden it even though no schema crosses that boundary, and that is
// accepted rather than overlooked. Today the SDK subtree is the only candidate
// producer in this tree, so the false positive is hypothetical; when one
// arrives, narrow this deliberately and NAME the dependency here, rather than
// pre-narrowing to a path pattern nobody has needed yet.
//
// What this does NOT cover, said plainly: whether a new zod changes the
// emitted JSON Schema. test/wire-surface.test.mjs covers that, against a
// committed snapshot, per tool. Do not widen this check to compensate.
```

## line 134

```
// The lockfile is what CI installs from (`npm ci`), so the check above is
// the one that holds on the runner. It is NOT what a developer runs against.
// `npm i zod@3 --no-save`, an interrupted install, or a node_modules older
// than the lockfile all leave the lockfile assertion green with two copies
// actually on disk - and node_modules is the tree the hazard lives in. So
// this asserts the same property against the artifact rather than the record
// of it. Same derived shape, no version number.
```

## line 142

```
// Walks PACKAGE POSITIONS ONLY, never a package's own source tree. The
// first version of this walk claimed to do that in a comment and did not:
// its guard read `!rel.includes("node_modules")`, which is TRUE at the top
// level and TRUE again one level into every package, so it only stopped
// descending after already stepping through a directory literally named
// node_modules. Measured on this tree: 627 directories visited, including
// @modelcontextprotocol/sdk/dist/cjs/client. A bare `mkdir -p
// node_modules/better-sqlite3/lib/zod` - an EMPTY directory, not a package
// - was enough to fail the test. Found by the PR review gate on #123.
//
// The structure below follows npm's layout instead of guessing at it. A
// node_modules directory holds exactly two kinds of entry: a scope
// directory (@scope), whose children are packages, and a package
// directory, which may hold a nested node_modules of its own. Nothing
// else is a place a package can be, so nothing else is descended into.
//
// Two things follow, and the second is why this is not just tidier. A
// directory named zod that is not a package can no longer match, because
// matching happens only at a package position. And the cost is now bounded
// by the number of INSTALLED PACKAGES rather than by every directory in
// every package - which is the reason the original comment gave for not
// walking everything, correct about the cost and about the false match,
// wrong only in the code under it.
//
// A scoped package named zod (node_modules/@scope/zod) is deliberately NOT
// a match: that is the package `@scope/zod`, a different package, not a
// second copy of `zod`. The lockfile check above already draws the same
// line, since its `split("node_modules/").pop()` yields "@scope/zod".
//
// Measured on this tree after the fix: 101 package positions visited where
// the old walk visited 627 directories, same single result, and the test
// went from ~14ms to ~2ms.
```

## line 179

```
// A missing directory is not an error here: every package having no
// nested node_modules is the normal, fully-deduped case. node_modules
// missing entirely surfaces as an empty `found` and fails the
// assertion below, which is the right report for "nothing installed".
```

## line 186

```
// scan() enumerates one node_modules directory; visitPackage() handles one
// package and descends into its own node_modules if it has one. Mutually
// recursive, which is what makes nesting depth fall out rather than being
// a case to handle.
```

## line 191

```
// Only an UNSCOPED package directory named zod is the zod package.
```

## line 211

```
// Without this, the checks above turn into a tautology the day nothing but
// hive depends on zod: hive's own copy would be the only one possible,
// nothing could produce a second, and passing would mean nothing. This
// pins the PREMISE, not a version.
//
// It reads the whole lockfile rather than only the SDK's manifest, because
// the SDK is not the only path: it also depends on zod-to-json-schema,
// which declares its OWN zod peer range, so a second copy stays reachable
// even if the SDK itself dropped zod. Pinning the SDK alone would have
// read narrower than the premise actually is.
```

## line 232

```
// Issue #105 lane B1, and the reason this is a test rather than a comment in
// package.json: engines.node is NOT an independent choice. better-sqlite3 13's
// addon is built with NAPI_VERSION=10, a Node that does not provide Node-API 10
// segfaults inside dlopen with no output at all, and hive declared ">=22.5.0"
// through that whole range because nothing tied the two numbers together.
//
// Both sides are read here, neither is derived from the other: the required
// level comes from the installed dependency's own binding.gyp, and the
// declaration comes from package.json.
//
// THE ASSERTION'S SHAPE IS THE FIX, NOT THE VERSION IN IT. This test first
// shipped asserting `engines.node === ">=" + <one lowest version>`, which
// hardcoded the assumption that a Node-API level starts at a single version.
// It does not - it starts once per release line - so the CORRECT declaration
// (`^22.14.0 || >=23.6.0`, which excludes the Node-API 9 releases 23.0.0 to
// 23.5.0) FAILED the test that claimed to keep the numbers in step. A test
// that has to be edited to accept a correct value was pinning the bug.
// Comparing against the derived range means the test follows the model
// instead of restating one case of it.
```

## line 270

```
// The lockfile carries its own copy of engines and npm only refreshes it
// on an install. It was left at ">=22.5.0" for a whole commit after
// package.json moved, which is a second declaration saying something
// false about the same tree.
```

## line 284

```
// The property, stated where it can fail: every line but the last is
// capped at its own major, because the next major sits BELOW the level
// until its own start point. Node 23.0.0-23.5.0 is the concrete case -
// it satisfies ">=22.14.0" and provides Node-API 9.
```
