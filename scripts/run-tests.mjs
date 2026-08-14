// Todo 375 item 3. `npm test` runs the suite and then asks every tmux socket
// the suite created whether a server is still on it.
//
// WHY THIS IS A WRAPPER RATHER THAN A SECOND npm SCRIPT. `posttest` does not
// run when `test` fails, and a failed or killed run is precisely the one most
// likely to have left a server behind - the same reason .github/workflows/
// ci.yml gives its own leak step `if: always()`. `npm test && node
// scripts/tmux-leaks.mjs` has the identical hole. So the check has to sit
// after the runner INSIDE one process that owns both exit codes.
//
// Everything else about `npm test` is unchanged on purpose: same
// `node --test`, same file list (the shell glob this replaces, resolved here
// instead), same stdio, so CI's own summary parsing and skip-budget gate read
// exactly what they always did.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireSuiteLock,
  currentHolder,
  isSingleFileTarget,
  noLockRequested,
  resolveLockPath,
  SuiteLockTimeoutError,
} from "./suite-lock.mjs";
import { checkTmuxLeaks, describeLeaks, leakCheckFailed } from "./tmux-leaks.mjs";

const testDir = fileURLToPath(new URL("../test", import.meta.url));
const passthrough = process.argv.slice(2);
const positionalArgs = passthrough.filter((arg) => !arg.startsWith("-"));
// ANY positional argument means the caller is naming its own targets - a
// file, a directory, a pattern - so the glob is skipped entirely and node
// --test resolves them itself. Splitting on `.test.mjs` instead (the first
// shape of this) quietly made `npm test -- test/` run the whole suite PLUS
// that directory, which is this wrapper deciding something node --test is
// better at. Flags-only invocations still get the full list.
const named = positionalArgs.length > 0;
const files = named
  ? []
  : readdirSync(testDir)
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => join("test", file));

// Todo 401 fix round 1 (counselors, all three seats independently): "named
// ⇒ cheap, skip the lock" was too broad. `npm test -- test/` and `npm test
// -- test/*.test.mjs` are `named` - the caller passed a positional - but
// node --test then runs the ENTIRE directory: full tmux/MCP contention, no
// lock, the exact shape this file exists to serialize. A flag's own value
// being misread as a target (`npm test -- --test-name-pattern foo`) lands
// here too. Only a single, explicit `.test.mjs` file is actually cheap;
// anything else - no target, a directory, several files - takes the lock.
const singleFileTarget = isSingleFileTarget(positionalArgs);

let suiteLock = null;
// process.exitCode, never process.exit, for the same reason the child's exit
// handler below gives at length: this can run ahead of queued stdout on a
// piped run, and the lock's own timeout message is exactly the line that
// would go missing. `lockBlocked` gates the rest of the file instead.
let lockBlocked = false;
if (!singleFileTarget && noLockRequested()) {
  console.log("[suite-lock] skipped: HIVE_TEST_NO_LOCK=1");
} else if (!singleFileTarget) {
  // Two separate try/catches on purpose (counselors round 1: opus, codex).
  // Resolving the lock path and the current holder are git lookups that can
  // legitimately fail in a broken-git environment, which is a fault far
  // bigger than this lock and worth failing OPEN for. A failure INSIDE
  // acquireSuiteLock itself - a filesystem without hardlink support, a
  // permission error - means the lock mechanism is broken, not absent, and
  // failing open there would silently turn off the one thing this file
  // exists to guarantee. That case is left to propagate and crash the
  // wrapper loudly instead of being folded into the same fail-open path.
  let lockPath = null;
  let holderInfo = null;
  try {
    lockPath = resolveLockPath();
    holderInfo = currentHolder(); // also a git call - same fail-open bucket as resolveLockPath above
  } catch (err) {
    // Counselors round 2 (all three seats): resolveLockPath() can succeed
    // and THEN currentHolder() throw - a JS try block does not roll back an
    // earlier assignment just because a later statement in it fails. Without
    // this line, lockPath stayed set with holderInfo still null, so the
    // branch below acquired anyway with holder: null - writing a lock file
    // containing only startedAt, no pid. Every later contender's isAlive()
    // then got a non-numeric pid and read it as alive forever, wedging every
    // lane on the machine for the full 20-minute TTL. Both-or-neither.
    lockPath = null;
    console.log(`[suite-lock] disabled: could not resolve a lock path (${err.message})`);
  }
  if (lockPath) {
    try {
      suiteLock = await acquireSuiteLock({ lockPath, holder: holderInfo });
    } catch (err) {
      if (!(err instanceof SuiteLockTimeoutError)) throw err;
      console.error(`[suite-lock] ${err.message}`);
      process.exitCode = 1;
      lockBlocked = true;
    }
  }
}

if (!lockBlocked) {
  const manifestDir = mkdtempSync(join(tmpdir(), "hive-leakcheck-"));
  const manifest = join(manifestDir, "sockets");

  const child = spawn(process.execPath, ["--test", ...passthrough, ...files], {
    stdio: "inherit",
    env: { ...process.env, HIVE_TMUX_LEAK_MANIFEST: manifest },
  });
  // Counselors round 1 (codex): the lock was acquired against THIS process's
  // pid, but this process is the supervisor, not the one running the suite.
  // A SIGKILL to the wrapper alone (uncatchable, so it cannot release) would
  // leave the still-running child behind a lock recording a now-dead pid,
  // reclaimed instantly by the next contender while the original suite is
  // still going. Repointing at the child's pid the moment it exists closes
  // that window down to the few ms between acquire and spawn.
  // `child.pid` guard (counselors round 2): `uv_spawn` is synchronous, so
  // `child.pid` is populated by the time spawn() returns in the ordinary
  // case, but an async spawn failure (fd exhaustion) leaves it undefined,
  // and JSON.stringify would then drop the pid key entirely - the same
  // non-numeric-pid hazard readHolder() now guards against, but no reason to
  // write it in the first place.
  if (child.pid) suiteLock?.updateHolderPid(child.pid);
  child.on("error", (err) => {
    console.error(`[run-tests] could not start node --test: ${err.message}`);
    suiteLock?.release();
    process.exitCode = 1;
  });

  // SIGNALS ARE FORWARDED, and this script's own header is why (counselors
  // round 2). It exists because a failed or KILLED run is the one most
  // likely to have left a server behind - and before this, a supervisor
  // that signalled the wrapper rather than the whole process group killed
  // the wrapper first, so the leak check never ran and `node --test` could
  // be left alive. CI sets cancel-in-progress: true, which is exactly that
  // shape. Whether a given runner signals the group or the leader is
  // environmental, so it is not something this script may assume.
  //
  // Killing the child rather than exiting: the "exit" handler below then
  // runs the check on a run that has genuinely stopped, which is the case
  // the check is most for. A default-disposition SIGTERM does NOT run a
  // test file's own process.on("exit") handlers (measured, todo 375 comment
  // 899), so the manifest - written at socket CREATION - is the only thing
  // that can still name what that run leaked.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Already gone; the exit handler below has it.
      }
    });
  }

  child.on("exit", (code, signal) => {
    // The suite's own result always wins the exit code; the leak check can
    // only ever turn a green run red, never a red run green.
    const suiteFailed = signal !== null || code !== 0;
    const result = checkTmuxLeaks(manifest);
    const lines = describeLeaks(result, { requireManifest: !named });
    // A MISSING MANIFEST IS ONLY A FAILURE WHEN THE FILE LIST IS OURS (PR
    // gate, fix round 1). For the full suite it is a real fault: this
    // script built that list, every hive-reaching file in it must call
    // isolateTmux() (test/CLAUDE.md), so no manifest means the wiring broke
    // and the check silently stopped covering anything. For a NAMED target
    // the list is the caller's, and plenty of legitimate targets never
    // touch tmux at all - `npm test -- test/db.test.mjs` exited 1 with
    // "tmux leak check FAILED" on a clean pass. Strict where it can be
    // justified, not where it cannot.
    const leaked = leakCheckFailed(result, { requireManifest: !named });
    console.log(`\n${leaked ? "tmux leak check FAILED" : "tmux leak check"}: ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(line);
    rmSync(manifestDir, { recursive: true, force: true });
    // RELEASE ON EVERY PATH this handler can be reached by: normal exit,
    // test failure, and a signal forwarded above - all three land here, the
    // same reasoning the manifest cleanup above already relies on. Nothing
    // released it if we never acquired one (named run, NO_LOCK, or a
    // disabled resolver), which is why suiteLock can be null here.
    suiteLock?.release();
    // process.exitCode, NEVER process.exit (counselors round 2). CI runs
    // `npm test 2>&1 | tee`, so stdout is a PIPE, and node's pipe writes are
    // asynchronous: process.exit() drops whatever is still queued. Measured
    // on this node - a single 500KB console.log followed by process.exit(0)
    // piped to `wc -c` delivers 65536 bytes, the pipe buffer, and nothing
    // more. The line at risk is this script's own verdict, including "tmux
    // leak check FAILED: <reason>", so the failure shape is a red exit code
    // with the reason missing. Short writes usually survive; a long leak
    // list, or a reader that has stalled, does not. Setting the code and
    // letting the process end on its own costs nothing here: the child has
    // exited and no handles are left to keep the loop alive.
    process.exitCode = suiteFailed ? (code ?? 1) : leaked ? 1 : 0;
  });
}
