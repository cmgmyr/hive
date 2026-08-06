---
paths:
  - "src/abi.ts"
  - "src/db.ts"
  - "src/dispatcher.ts"
  - "package.json"
---

# The native addon, and the interpreter pin that keeps it loadable

## The addon is N-API now, which moved the failure rather than removing it

`better-sqlite3` moved to N-API at 13.0.0 (`NAPI_VERSION=10` in its own `binding.gyp`, via `node-addon-api`), which is deliberately ABI-stable across Node majors - that is the entire point of N-API. Measured directly on this machine (issue #105 lane B): the shipped `prebuilds/darwin-arm64.node` opened a real database under both NODE_MODULE_VERSION 137 and 147, and so did a from-source `node-gyp rebuild` of the identical 13.0.3 tree.

**N-API replaced an equality constraint with a minimum one.** The addon no longer has to match the running interpreter's `NODE_MODULE_VERSION`, and it does require a Node that provides **Node-API 10, which begins at Node 22.14.0**. So the "different Node, same compiled addon, `ERR_DLOPEN_FAILED`" mismatch this file was written against is **unreachable on any Node that clears that floor** - not "unless you build from source", not "on some platforms", but for any build this package can currently produce on any platform this project ships on (darwin/linux/win32, x64/arm64). Below the floor a different failure takes its place, and it is worse. See the next section.

That scope is the correction, and the unscoped version of this paragraph shipped. Lane B measured the addon under `NODE_MODULE_VERSION` 137 and 147, the lead re-measured under 137 and 147, and both are Node 24 and 26 - both above the Node-API 10 floor. The experiment had no power to detect what it claimed, and running it twice added confidence without adding coverage. **Ask what result would refute the claim, then check the setup can produce that result.**

The only way to see the old `NODE_MODULE_VERSION` mismatch again is to depend on a pre-N-API major, which is what `test/fixtures/native-addon-abi/` does on purpose to keep `guardAbi()`'s mismatch branch tested - see that directory's README.

## Below Node 22.14.0 the addon does not fail, it kills the process

Measured on Node 22.13.1 (Node-API 9) against a 13.0.3 tree, deterministic over three runs:

```
$ node -e 'new(require("better-sqlite3"))(":memory:")'
exit 139 (SIGSEGV), stdout empty, stderr empty
```

There is no error to catch. `require()` of the `.node` file dies inside `dlopen`, **inside a `try`/`catch`**, so `checkAbi()`'s own require was the crash site rather than the thing that reported it. hive declared `engines.node: ">=22.5.0"` while this was true, so every version from 22.5.0 to 22.13.x satisfied hive's own floor, installed cleanly, and printed nothing at all.

What follows from that, and what the code now does:

- **`checkAbi()` compares Node-API levels BEFORE it requires anything.** `process.versions.napi` needs no native load, so the comparison is possible; after the require there is no process left to report from. Any new code that loads the addon has to sit below that check, not above it.
- **The required level is read from the installed `better-sqlite3`'s own `binding.gyp`, not recorded in hive.** `engines.node` is derived from that number, so a constant in hive would agree with a stale declaration by construction and let the segfault back in on the next upstream bump. `test/dependency-versions.test.mjs` fails until the two move together.
- **`engines.node` is `"^22.14.0 || >=23.6.0"` because of the addon, not because of hive's own code.** hive's own APIs need 22.5.0 (`path.matchesGlob`); the addon needs Node-API 10, so that wins. **A Node-API level starts once PER RELEASE LINE, not once.** nodejs.org's matrix gives level 10 as "v22.14.0+, v23.6.0+ and all later versions", so a bare `">=22.14.0"` admits Node 23.0.0 to 23.5.0, which provide level 9 and cannot load the addon. The first version of this lane's fix shipped exactly that, which is the same defect one release line over. `src/abi.ts`'s `NODE_API_STARTS` records the start points and derives the range, so the declaration cannot restate one case of the matrix and call it the rule.
- **The boundary is exercised, not reasoned, and on both release lines.** The ubuntu CI leg is pinned at 22.14.0 exactly, and a `floor-boundary` job runs `doctor` under 22.13.1 and 23.5.0 requiring a diagnostic rather than a segfault, and under 23.6.0 requiring the addon to load. This file used to argue the opposite - that pinning a leg to the floor "would test a version nobody runs" - and that argument is what let a false floor ship. The point of a boundary leg is the boundary, not the popularity of the version, and one leg per boundary is one per LINE.
- **Rebuilding is not the fix and advice must not say it is.** A source build reads the same `binding.gyp` and asks for the same Node-API level. `abiFixLines()`'s `"napi"` branch says so and names an interpreter instead.

What is still real:

- **`require("better-sqlite3")` still does NOT load the addon**, and reading one as proof is still exactly how a broken interpreter once got recommended as the fix. The binding loads lazily inside `new Database()` (`better-sqlite3/lib/database.js`), unchanged by the N-API move. To test an interpreter, open a database or call `checkAbi()` in `src/abi.ts`, which loads the addon itself.
- **The addon can still be entirely missing**: install has not run, or this platform/arch has no prebuild in the tarball. **npm will not build one.** v13 sets `gypfile: false` and ships no `install` or `postinstall` script, so npm never invokes node-gyp for this package, whether or not a compiler is present. A platform with no prebuild gets a clean, successful install and no addon. This file previously said the fallback "still builds from source", which was false and contradicted the issue #51 bullet at the end of this list; `abiFixLines()`'s `"missing"` branch now says the same thing the user needs to hear. A source build is something a human runs by hand (`npm run build-release` inside the package), and `build/Debug` or `build/Release` is where it lands.
- **`db.ts` still calls `guardAbi()` on the line above `new Database`**, so a failure - "missing" or "napi" in practice, rather than "mismatch" - is a sentence naming the problem instead of a raw error thrown out of an import where nothing downstream can catch it. Keep that call there. An in-process check inside a command can never observe a failure, because if `db.js` loaded at all the check already passed; the guard has to run before `new Database`, which is why `src/abi.ts` is called from `db.ts` rather than from inside a command.
- `addonPath()` (`src/abi.ts`) **mirrors `better-sqlite3/lib/binding.js` by hand, in its order**: `prebuilds/<platform>-<arch>.node` first (13's layout, chosen without reference to the Node version at all), then `build/Debug/better_sqlite3.node`, then `build/Release/better_sqlite3.node`. Keep the order and keep the platform test in front of `process.report.getReport()`. Both have drifted once: the missing `build/Debug` step made `guardAbi()` refuse a tree that `better-sqlite3` itself would have opened, and an unconditional `getReport()` built a full diagnostic report - heap walk and libuv handle dump - on the module-load path of every hive process and every SessionStart kickoff, on platforms where the glibc field it reads cannot exist. A mirror that drifts fails toward refusing working checkouts, which is worse than the failure it guards.
- **Issue #51's trap - `npm install` silently skipping the rebuild and leaving the ABI broken while every step reports success - cannot happen for this package any more.** 13 ships no `install` or `postinstall` script at all; the correct prebuild is just a file in the tarball, selected at `require()` time. There is nothing for `npm install` to skip.

## hive still pins its interpreter, for a smaller reason than it used to

`hive setup` writes a dispatcher that execs the CLI under `process.execPath` as it stood at setup time. The reason THIS FILE originally gave - "so the pin and the ABI cannot disagree" - is narrower than it was: the addon no longer cares which Node MAJOR runs it, only that the Node provides Node-API 10 (`^22.14.0 || >=23.6.0`). Say that plainly rather than quietly keeping the old justification.

What the pin still buys, honestly:

- **A version manager resolves a bare `node` from the current working directory**, so `cd`-ing into a directory pinning a different Node changes which interpreter `hive` runs under, and that directory can pin one below the floor. Pinning makes `hive` behave identically regardless of which directory invoked it or what a version manager currently has active - a durability property, not an ABI one. `src/dispatcher.ts`'s `durabilityLines()` documents the version-manager-uninstall side of this same concern.
- **There is a real version floor, and both hive's code and the addon set one.** hive's own APIs (`fs.globSync`, `path.matchesGlob`) need 22.5.0; the addon needs Node-API 10, so `engines.node` is `"^22.14.0 || >=23.6.0"`. An ambient `node` resolved from PATH can be below either, and pinning avoids depending on whatever happens to be first on PATH.
- `npm approve-scripts better-sqlite3` is no longer part of any hive workflow. 13 ships no script for npm to hold, so there is nothing to approve; the line survives here only so a reader who finds it in older docs knows it is dead.

Anything that rebuilds must still re-pin:

```bash
npm install && npm run build && hive setup
```

The advice for a mismatch used to loop, telling the user to run `hive setup` when setup pins whatever Node runs it and the `hive` on PATH is the command that just failed. Say which interpreter to run setup WITH.

## CI is the only thing that catches environment assumptions

Two tests shipped green locally and failed on the runner, both because they encoded one machine: one asserted an alternation over `hive setup`'s durability branches and the runner's Node path matched a third branch; the other asserted doctor's global exit code when the runner has no `claude` binary.

Local green is not evidence for anything environment-shaped. Before pushing a lane that touches paths, interpreters, or installed binaries, run the suite with a PATH that lacks them. Watch for a fixture that collides with reality: `/usr/local/bin/node` as the "some other interpreter" fixture is where nodejs.org's installer puts Node, so on such a machine the fixture IS `process.execPath` and the assertions invert silently.

**CI runs a matrix (Node 22.14.0 and 24), and each leg pairs its own `alt`.** The alt is a second Node installed *before* the primary and captured into `HIVE_TEST_ALT_NODE`, because `alternateInterpreter()` (`test/helpers.mjs`) needs an interpreter whose `NODE_MODULE_VERSION` differs from the running one to exercise the re-exec path (a real ABI question independent of the addon: which interpreter a session starts under) at all. Since the real addon no longer mismatches under a different `alt` either (see above), any test that needs the addon ITSELF to fail now pairs `alternateInterpreter()`'s real second Node with `classicAddonFixture()`'s pre-N-API build in a scratch `node_modules` (`test/interpreter.test.mjs`, `test/kickoff-reexec.test.mjs`, `test/hook-registration-abi.test.mjs`) rather than trusting the real addon to refuse. It does **not** need an older interpreter, only a different one. That is why the alt is written out per leg instead of hardcoded: pinning the alt to one version silently stops discriminating on the leg where that version is the primary, `alternateInterpreter()` returns `null`, and the re-exec cases skip while the run still reports green. A matrix that hides its own skips is worse than one leg.

The matrix also catches the third environment class, alongside paths and installed binaries: **a version-gated API**. `package.json` declared `engines.node: ">=18"` while `test/docs.test.mjs` had depended on `fs.globSync` (Node 22) all along and `scripts/covering-rules.mjs` on `path.matchesGlob` (20.17+). Nothing tested either claim, so the floor was fiction in both directions. A Node 20 leg was tried on the branch that added this matrix and failed at exactly those two imports; **22 was chosen as the floor** rather than replacing `globSync` in a dead-rule check that genuinely wants a filesystem glob. The deciding reason was not the code: hive's own global install is pinned at 24, so no environment here needs a project install on 20, and paying to support one would buy nothing. The patch component was deliberate even then: `fs.globSync` needs 22.0 but `path.matchesGlob` landed at exactly 22.5.0, so 22.0 through 22.4 satisfy a plain `">=22"` and still throw on import.

**The floor is `"^22.14.0 || >=23.6.0"` now, and it is run rather than reasoned.** The version-gated APIs were never the binding constraint; the addon was, and nobody checked. The old text here said the `.5.0` was "reasoned from the API's history and said out loud rather than exercised", and offered that as the honest move. It is not enough. A floor that nothing runs is a claim, and this repo has now carried a false one twice. `node-version: 22` resolving to the latest 22.x is exactly what hid it, so the ubuntu leg pins **22.14.0 exactly** and a `floor-boundary` job runs `doctor` under **22.13.1**, **23.5.0** and **23.6.0**. When you raise a floor, raise the declaration with it, then run a leg AT the boundary and one BELOW it - **on every release line the constraint has one**, since the first attempt at this fixed the 22 line and left the 23 line broken. Naming the part you could not test is the last resort, not the first.
