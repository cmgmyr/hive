---
paths:
  - "src/abi.ts"
  - "src/abiProbe.ts"
  - "src/sessionProbe.ts"
  - "src/db.ts"
  - "src/dispatcher.ts"
  - "package.json"
---

# The native addon, and the interpreter pin that keeps it loadable

## The addon is N-API now, which moved the failure rather than removing it

**Ask what result would refute the claim, then check the setup can produce that result.**

## Below Node 22.14.0 the addon does not fail, it kills the process

- **`checkAbi()` compares Node-API levels BEFORE it requires anything.** Any new code that loads the addon has to sit below that check, not above it.
- **The required level is read from the installed `better-sqlite3`'s own `binding.gyp`, not recorded in hive.**
- **`engines.node` is `"^22.14.0 || >=23.6.0"` because of the addon, not because of hive's own code.** A Node-API level starts once PER RELEASE LINE, not once.
- **Rebuilding is not the fix and advice must not say it is.**

What is still real:

- **`require("better-sqlite3")` still does NOT load the addon**, and reading one as proof is still exactly how a broken interpreter once got recommended as the fix. To test an interpreter, open a database or call `checkAbi()` in `src/abi.ts`, which loads the addon itself.
- **The addon can still be entirely missing**, and **A PLAIN `npm install` DOES NOT RESTORE IT.** Remove the package DIRECTORY and `npm install` brings it back from the tarball; `npm ci` does the same for the whole tree.
- **npm DOES invoke node-gyp for this package.** **Reason from what npm DOES, measured in a scratch tree, not from what package.json declares.**
- **`db.ts` still calls `guardAbi()` on the line above `new Database`**. Keep that call there.
- `addonPath()` (`src/abi.ts`) **mirrors `better-sqlite3/lib/binding.js` by hand, in its order**. Keep the order and keep the platform test in front of `process.report.getReport()`.
- **Issue #51's trap is retired in its original form and has a successor worth knowing.**

## hive still pins its interpreter, for a smaller reason than it used to

- `npm approve-scripts better-sqlite3` is LIVE. `package.json`'s
`"allowScripts": {"better-sqlite3@13.0.3": false}` is VERSION-PINNED on purpose: a bump re-requires approval. `false` IS WHAT SHIPS.

## The SessionStart hook is the one entry point the pin does not cover

- **THE NAMING IS IN THE BANNER, NOT IN kickoff.mjs, and that placement is the correction.** `kickoff.mjs`'s early returns are all silent again; keep them that way.
- **The rule underneath is the one this whole area keeps relearning: never report a stronger claim than you measured.**

Anything that changes which interpreter should be pinned must re-pin, and the re-pin has to NAME the interpreter:

```bash
"<the node you want pinned>" <checkout>/dist/cli.js setup
```

**Any advice ending in a bare `hive setup` is a loop, and this repo has shipped that loop twice.**

## CI is the only thing that catches environment assumptions

Local green is not evidence for anything environment-shaped. Before pushing a lane that touches paths, interpreters, or installed binaries, run the suite with a PATH that lacks them.

When you raise a floor, raise the declaration with it, then run a leg AT the boundary and one BELOW it - on every release line the constraint has one.

See `.claude/skills/hive-internals` for the measurements, incidents, and self-corrections behind these.
