---
paths:
  - "src/abi.ts"
  - "src/db.ts"
  - "src/dispatcher.ts"
  - "package.json"
---

# The native addon, and the interpreter pin that keeps it loadable

## The addon is ABI-locked, and `require()` does NOT prove it works

`better-sqlite3` is ABI-locked to the interpreter that built it, and `require("better-sqlite3")` does NOT load it: the binding loads lazily inside `new Database()`. A passing require under two different Node majors therefore proves nothing, and reading it as proof is how an interpreter that could not open the store at all once got recommended as a fix.

To test an interpreter, open a database or call `checkAbi()` in `src/abi.ts`, which loads the addon itself.

`db.ts` calls `guardAbi()` on the line above `new Database`, so a mismatch is a sentence naming both `NODE_MODULE_VERSION`s instead of an `ERR_DLOPEN_FAILED` stack trace thrown out of an import where nothing downstream can catch it. Keep that call there.

Related and easy to get backwards: an in-process ABI check inside a command can never observe a mismatch, because if `db.js` loaded then the ABI matches by definition. The check has to run before `new Database`, which is why `src/abi.ts` is called from `db.ts`.

The build itself needs approving once: `npm approve-scripts better-sqlite3`.

## hive pins its interpreter on purpose

`hive setup` writes a dispatcher that execs the CLI under `process.execPath` as it stood at setup time, which is the Node that built the addon, so the pin and the ABI cannot disagree. Never write a literal path.

Anything that rebuilds must re-pin:

```bash
npm install && npm run build && hive setup
```

The advice for a mismatch used to loop, telling the user to run `hive setup` when setup pins whatever Node runs it and the `hive` on PATH is the command that just failed. Say which interpreter to run setup WITH.

## CI is the only thing that catches environment assumptions

Two tests shipped green locally and failed on the runner, both because they encoded one machine: one asserted an alternation over `hive setup`'s durability branches and the runner's Node path matched a third branch; the other asserted doctor's global exit code when the runner has no `claude` binary.

Local green is not evidence for anything environment-shaped. Before pushing a lane that touches paths, interpreters, or installed binaries, run the suite with a PATH that lacks them. Watch for a fixture that collides with reality: `/usr/local/bin/node` as the "some other interpreter" fixture is where nodejs.org's installer puts Node, so on such a machine the fixture IS `process.execPath` and the assertions invert silently.

**CI runs a matrix (Node 22 and 24), and each leg pairs its own `alt`.** The alt is a second Node installed *before* the primary and captured into `HIVE_TEST_ALT_NODE`, because `alternateInterpreter()` (`test/helpers.mjs`) needs an interpreter whose `NODE_MODULE_VERSION` differs from the running one to exercise the re-exec and ABI-mismatch paths at all. It does **not** need an older one, only a different one. That is why the alt is written out per leg instead of hardcoded: pinning the alt to one version silently stops discriminating on the leg where that version is the primary, `alternateInterpreter()` returns `null`, the ABI-mismatch cases skip, and the run still reports green. A matrix that hides its own skips is worse than one leg.

The matrix also catches the third environment class, alongside paths and installed binaries: **a version-gated API**. `package.json` declared `engines.node: ">=18"` while `test/docs.test.mjs` had depended on `fs.globSync` (Node 22) all along and `scripts/covering-rules.mjs` on `path.matchesGlob` (20.17+). Nothing tested either claim, so the floor was fiction in both directions. A Node 20 leg was tried on the branch that added this matrix and failed at exactly those two imports; **22 was chosen as the floor** rather than replacing `globSync` in a dead-rule check that genuinely wants a filesystem glob. The deciding reason was not the code: hive's own global install is pinned at 24, so no environment here needs a project install on 20, and paying to support one would buy nothing. `engines.node` is now `>=22.5.0`, and the patch component is deliberate: `fs.globSync` needs 22.0 but `path.matchesGlob` landed at exactly 22.5.0, so 22.0 through 22.4 satisfy a plain `">=22"` and still throw on import. The matrix cannot check that, because `node-version: 22` resolves to the latest 22.x; the `.5.0` is reasoned from the API's history and said out loud rather than exercised. When you raise a floor, raise the declaration with it, test what you can, and name the part you could not.
