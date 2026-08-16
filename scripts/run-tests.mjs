import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describeOpenCalls, installFakeOpen, openCallsFailed, readOpenCalls } from "./open-guard.mjs";
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

const named = positionalArgs.length > 0;

const LONGEST_FILE_HOIST = "wake-hold-notify.test.mjs";
const files = named
  ? []
  : readdirSync(testDir)
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => (file === LONGEST_FILE_HOIST ? join(testDir, file) : join("test", file)));

const singleFileTarget = isSingleFileTarget(positionalArgs);

let suiteLock = null;

let lockBlocked = false;
if (!singleFileTarget && noLockRequested()) {
  console.log("[suite-lock] skipped: HIVE_TEST_NO_LOCK=1");
} else if (!singleFileTarget) {

  let lockPath = null;
  let holderInfo = null;
  try {
    lockPath = resolveLockPath();
    holderInfo = currentHolder();
  } catch (err) {

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

  const fakeOpen = installFakeOpen();

  const child = spawn(process.execPath, ["--test", ...passthrough, ...files], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${fakeOpen.bin}${delimiter}${process.env.PATH}`,
      HIVE_TMUX_LEAK_MANIFEST: manifest,
    },
  });

  if (child.pid) suiteLock?.updateHolderPid(child.pid);
  child.on("error", (err) => {
    console.error(`[run-tests] could not start node --test: ${err.message}`);
    suiteLock?.release();
    process.exitCode = 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {

      }
    });
  }

  child.on("exit", (code, signal) => {

    const suiteFailed = signal !== null || code !== 0;
    const result = checkTmuxLeaks(manifest);
    const lines = describeLeaks(result, { requireManifest: !named });

    const leaked = leakCheckFailed(result, { requireManifest: !named });
    console.log(`\n${leaked ? "tmux leak check FAILED" : "tmux leak check"}: ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(line);

    const openCalls = readOpenCalls(fakeOpen.log);
    const openEscaped = openCallsFailed(openCalls);
    const openLines = describeOpenCalls(openCalls);
    console.log(`\n${openEscaped ? "open-call check FAILED" : "open-call check"}: ${openLines[0]}`);
    for (const line of openLines.slice(1)) console.log(line);

    rmSync(manifestDir, { recursive: true, force: true });
    fakeOpen.reap();

    suiteLock?.release();

    process.exitCode = suiteFailed ? (code ?? 1) : leaked ? 1 : openEscaped ? 1 : 0;
  });
}
