import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the dead-pane pid probe tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { paneProcessExited, paneReissued, targetLiveProbe } = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const SESSION = "dead-pane-pid-probe";

function heldDeadPane() {
  const [pane, pid] = execFileSync(
    "tmux",
    ["new-session", "-d", "-P", "-F", "#{pane_id} #{pane_pid}", "-s", SESSION, "sleep 600", ";", "set-window-option", "-t", `=${SESSION}`, "remain-on-exit", "on"],
    { encoding: "utf8" },
  ).trim().split(" ");
  process.kill(Number(pid), "SIGKILL");
  const deadline = Date.now() + 5000;
  while (paneProcessExited(pane) !== true) {
    if (Date.now() > deadline) throw new Error("setup bug: the held pane never read as dead");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return { pane, pid };
}

describe("a held-dead pane's pid probe", () => {
  it("an empty pid field reads as null, never the empty string", needsTmux, (t) => {
    t.after(() => cleanup(SESSION));
    const { pane, pid } = heldDeadPane();
    const probe = targetLiveProbe(pane);
    assert.equal(probe.live, true);
    assert.ok(probe.pid === null || probe.pid === pid, `pid was ${JSON.stringify(probe.pid)}`);
    assert.equal(paneReissued(pid, probe), false, "a dead pane read as reissued");
  });

  it("paneReissued is false for a live pane with no pid", () => {
    assert.equal(paneReissued("4242", { live: true, pid: null }), false);
    assert.equal(paneReissued("4242", { live: true, pid: "4243" }), true);
  });
});
