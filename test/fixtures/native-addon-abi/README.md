# Classic (NODE_MODULE_VERSION-locked) native addon fixtures

Issue #105 lane B. better-sqlite3 13 moved to N-API (`NAPI_VERSION=10` in its
own `binding.gyp`): a prebuild shipped in the npm package, one file per
platform+arch, selected without looking at the Node version at all, and even
a from-source `node-gyp rebuild` of the same tree, since the C++ itself now
targets N-API rather than the classic V8-ABI-dependent macro. Measured
directly on this machine: `prebuilds/darwin-arm64.node` opened a real
database under both NODE_MODULE_VERSION 137 and 147, and so did a freshly
`node-gyp rebuild`-ed `build/Release/better_sqlite3.node`. That is correct and
desirable, and it also means there is no longer any way for this package, on
any platform this project ships on (darwin/linux/win32, x64/arm64) or any way
of building it, to produce an addon `guardAbi()`'s mismatch branch can
legitimately see - not "harder to hit", unreachable.

**Scoped, because the unscoped version of that sentence shipped and was
wrong.** It holds on a Node that provides Node-API 10, which begins at
**22.14.0**. Below that the addon does not mismatch, it segfaults inside
`dlopen` with no output at all, and `checkAbi()`'s `"napi"` branch is what
catches it before the load. Both measurements above are NODE_MODULE_VERSION
137 and 147, which are Node 24 and 26 - both above that floor, so neither
could have detected it. See `.claude/rules/native-addon.md`.

These four files are the last CLASSIC build better-sqlite3 published for this
project's dependency line: `better-sqlite3@12.11.1`'s node-gyp output,
downloaded from WiseLibs' own GitHub release (not built here, not modified).
They stand in for the real addon in a scratch copy of `node_modules` so tests
can exercise a genuine ABI mismatch again, the same way a v12 addon used to
mismatch a wrong interpreter, without depending on this machine happening to
have a second Node install with a different ABI around.

| File | Source | NODE_MODULE_VERSION | sha256 |
|---|---|---|---|
| `darwin-arm64-abi127.node` | `better-sqlite3-v12.11.1-node-v127-darwin-arm64.tar.gz` | 127 (Node 22) | `1946ab352978b5b3493f99080dc04ed6d0a4157c511c7139cbf50b3d44d8d560` |
| `darwin-arm64-abi137.node` | `better-sqlite3-v12.11.1-node-v137-darwin-arm64.tar.gz` | 137 (Node 24) | `c6fac315df023cf5efec45a3511e6515c6b0f7461a4a284b1b7a79c7ef8febe7` |
| `linux-x64-abi127.node` | `better-sqlite3-v12.11.1-node-v127-linux-x64.tar.gz` | 127 (Node 22) | `df9fbd0d061f360d81fb51e265c53c9605020bd68219e34f33c07c85de15719a` |
| `linux-x64-abi137.node` | `better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz` | 137 (Node 24) | `45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2` |

Downloaded from `https://github.com/WiseLibs/better-sqlite3/releases/download/v12.11.1/`,
extracted from the tarball's `build/Release/better_sqlite3.node`, renamed by
platform+arch+ABI, no other change. Each `.node` file itself was verified by
hand before being committed: `require()`-ing the matching-ABI file under the
interpreter that ABI number names loads it, and `require()`-ing it under an
interpreter with the OTHER NODE_MODULE_VERSION throws Node's real
`ERR_DLOPEN_FAILED`, naming both versions - the exact error `classifyAddonLoadError`
(`src/abi.ts`) matches on. `file(1)` confirms genuine Mach-O arm64 bundles for
the darwin pair and genuine ELF x86-64 shared objects for the linux pair, not
just correctly-named garbage.

127 and 137 were chosen because they are `.github/workflows/ci.yml`'s own
matrix (Node 22 and 24), not an arbitrary pair: whichever one is CURRENTLY
running matches one fixture and mismatches the other, on every CI leg and on
this project's own pinned dev interpreter (Herd's Node 24.19.0, ABI 137).
`test/helpers.mjs`'s `classicAddonFixture()` picks the matching file to make a
scratch addon behave exactly like the real thing, and the non-matching file
where a test wants a guaranteed, single-process mismatch with no second
interpreter involved at all. If this project's CI matrix ever moves off Node
22/24, add the new ABI's pair here rather than replacing these - the tests
that want "always different from whatever is running" only need any two
distinct values, but the tests that want "matches this session's dispatcher"
need the ABI actually in use to be present.

Only darwin-arm64 and linux-x64 are covered because that is what
`.github/workflows/ci.yml` runs. A test needing a fixture for a platform/arch
pair not listed here skips with a clear reason, the same way `alternateInterpreter()`-based
tests already skip when no second real Node is available - never fakes a pass.

## `classic-package/`

`checkAbi()` (`src/abi.ts`) requires the `.node` file directly, so pairing one
of the ABI files above with 13's own `lib/` is enough to test it: dlopen either
succeeds or throws, nothing else runs. A test that goes on to open a real
`Database` needs more than that - db.ts's `import Database from
"better-sqlite3"` walks 13's `lib/binding.js`/`database.js`, which calls
native methods 13's addon exports and a 12.x addon does not (confirmed by
hand: pairing a 12.x `.node` file with 13's `lib/` throws `addon.initialize is
not a function` the moment a query runs, not at `require()` time). So a test
that needs the classic addon to be genuinely FUNCTIONAL, not just loadable
(`test/kickoff-reexec.test.mjs`'s recovery cases, which open a real store),
needs 12.x's own `lib/` talking to a 12.x binary - a self-consistent pair, the
same as any real install ever was.

`lib/`, `package.json` and `LICENSE` here are `better-sqlite3@12.11.1`'s own,
unmodified, from `https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.11.1.tgz`.
Re-verified 2026-08-06: `lib/` is byte-identical to that published tarball,
and `LICENSE` was taken from it (sha256
`09856b52897c91ab67e7456ef43067019f31dfd3b87fda72e655736b1ebdee55`).

**`LICENSE` covers the four `.node` files above as well as this directory.**
They are builds of this same MIT-licensed source, and MIT requires the notice
to travel with the copy. It was missing when this fixture first landed, while
`vendor/bindings` and `vendor/file-uri-to-path` both carried theirs, so the
omission looked deliberate rather than forgotten. Anything else vendored here
brings its licence with it, at the level of the thing it licenses.
`vendor/bindings` and `vendor/file-uri-to-path` are `database.js`'s own
dependency (`require('bindings')('better_sqlite3.node')`) for locating the
addon on disk, at the exact versions (`bindings@1.5.0`, `file-uri-to-path@1.0.0`)
this repo's own git history shows were resolved before this lane's bump - `git
show a8fb745:package-lock.json` names them. Both packages dropped out of
`package-lock.json` when better-sqlite3 13 stopped needing them (13 has no
`install`/`postinstall` script at all), so they cannot be symlinked from the
real `node_modules` any more and are vendored here instead, trimmed to their
runtime files (no tests, no `.travis.yml`). Named `vendor/`, not
`node_modules/`: `.gitignore`'s `node_modules/` pattern matches that name
anywhere in the tree, and a fixture actually called that would be silently
untracked. `writeScratchAddon()` copies each entry into a real
`node_modules/` in the SCRATCH tree, which is where `require('bindings')`
actually needs to find it.

`test/helpers.mjs`'s `writeScratchAddon(root, { classic: true, prebuild })`
installs this directory plus one of the `.node` files above, at `build/Release/
better_sqlite3.node` (12.x's own layout, not 13's `prebuilds/`), instead of
13's `lib/`.
