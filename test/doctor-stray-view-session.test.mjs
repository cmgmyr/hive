import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, sleep } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("doctor's stray view-session report (todo 273)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { ensureSession, sessionName, viewSessionName } = await import("../dist/tmux.js");

const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

function hasSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function attachClient(target) {
  return spawn("tmux", ["-C", "attach", "-t", target], { stdio: ["pipe", "pipe", "pipe"] });
}

function detach(client) {
  return new Promise((resolve) => {
    client.once("exit", () => resolve());
    client.kill("SIGTERM");
  });
}

describe(
  "hive doctor reports a stray (clientless) view session, and never kills one",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const base = sessionName();
    const view = viewSessionName();

    before(async () => {
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      ensureSession(base, dirs.projectDir, { bare: true });

      execFileSync("tmux", ["new-session", "-d", "-t", `=${base}`, "-s", view]);
    });

    after(() => cleanup(view, base));

    it("warns, names the session, and prints a QUOTED removal command", async () => {
      const out = await runCli(["doctor"], opts);
      assert.match(
        out.stdout,
        new RegExp(`warn {2}view session: ${view} has no attached client`),
        `expected a stray-view-session warning for ${view}; stdout:\n${out.stdout}`,
      );

      assert.ok(
        out.stdout.includes(`tmux kill-session -t '=${view}'`),
        `expected a quoted kill-session command for ${view}; stdout:\n${out.stdout}`,
      );
    });

    it("never kills the session it reports", async () => {
      await runCli(["doctor"], opts);
      assert.ok(hasSession(view), "doctor must only report a stray view session, never kill it");
    });
  },
);

describe(
  "hive doctor does not report a view session that still has a client",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const base = sessionName();
    const view = viewSessionName();
    let client;

    before(async () => {
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      ensureSession(base, dirs.projectDir, { bare: true });
      execFileSync("tmux", ["new-session", "-d", "-t", `=${base}`, "-s", view]);
      client = attachClient(`=${view}`);
      await sleep(300);
      assert.notEqual(
        execFileSync("tmux", ["list-clients", "-t", `=${view}`], { encoding: "utf8" }).trim(),
        "",
        "setup bug: the view must show a client before this case means anything",
      );
    });

    after(async () => {
      await detach(client);
      cleanup(view, base);
    });

    it("says nothing about a view session that is in active use", async () => {
      const out = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        out.stdout,
        /view session/,
        `an attached view session is not stray and must not be reported; stdout:\n${out.stdout}`,
      );
    });
  },
);

describe(
  "hive doctor's \"sessions\" check reports the base session, not a linked view",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const base = sessionName();
    const view = viewSessionName();

    before(async () => {
      const init = await runCli(["init"], opts);
      assert.equal(init.code, 0, init.stderr);
      ensureSession(base, dirs.projectDir, { bare: true });
      execFileSync("tmux", ["new-session", "-d", "-t", `=${base}`, "-s", view]);
    });

    after(() => cleanup(view, base));

    it("names the base session and never the view", async () => {
      const out = await runCli(["doctor"], opts);
      assert.match(out.stdout, new RegExp(`ok {4}sessions: .*\\b${base}\\b`), out.stdout);
      assert.doesNotMatch(
        out.stdout,
        new RegExp(`ok {4}sessions:.*${view}`),
        `the "sessions" line must not fold a view session in with the base one; stdout:\n${out.stdout}`,
      );
    });
  },
);
