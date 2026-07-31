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
