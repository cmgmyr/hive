import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { clearHiveEnv, fakeFailingTmux, isolateTmux, paneField, recordingTmux, scratchDirs, tmux, tmuxCallsIn } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the row ownership classifier tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { rowOwnership, ownershipLiveness, paneReissued, tmuxSocketPath, tmuxSaysNothingThere, TmuxError } = await import("../dist/tmux.js");

const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

function snapshot({ panes = {}, windows = [], serverAnswered } = {}) {
  const snap = { panes: new Set(Object.keys(panes)), windows: new Set(windows), pids: new Map() };
  for (const [pane, pid] of Object.entries(panes)) if (pid) snap.pids.set(pane, pid);
  if (serverAnswered !== undefined) snap.serverAnswered = serverAnswered;
  return snap;
}

const row = (target, pid, socket = ownSocket) => ({ tmux_target: target, tmux_socket: socket, pane_pid: pid });

function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

describe("rowOwnership: the four-state table over a supplied snapshot", () => {
  const live = snapshot({ panes: { "%5": "100", "%6": "" }, windows: ["hive-main:@2"], serverAnswered: true });
  const table = [
    ["matching recorded and observed pid is live", row("%5", "100"), live, "live"],
    ["a matching pid on a legacy empty socket is still live", row("%5", "100", ""), live, "live"],
    ["a different known pid is reissued", row("%5", "999"), live, "reissued"],
    ["an empty recorded pid on a live pane id is unknown, never live", row("%5", ""), live, "unknown"],
    ["an empty observed pid is unknown", row("%6", "100"), live, "unknown"],
    ["an answered snapshot without the pane is gone", row("%9", "100"), live, "gone"],
    ["an empty target on the local socket is gone", row("", "100"), null, "gone"],
    ["a foreign recorded socket is unknown even with a matching pid", row("%5", "100", FOREIGN_SOCKET), live, "unknown"],
    ["a foreign socket wins over an empty target", row("", "", FOREIGN_SOCKET), live, "unknown"],
    ["a failed snapshot is unknown", row("%5", "100"), null, "unknown"],
    ["serverAnswered=false is no observation, not gone", row("%9", "100"), snapshot({ serverAnswered: false }), "unknown"],
    ["an absent serverAnswered keeps the fixture's own evidence", row("%9", "100"), snapshot(), "gone"],
    ["an existing legacy window target is unknown", row("hive-main:@2", "100"), live, "unknown"],
    ["a missing legacy window target is gone", row("hive-main:@7", "100"), live, "gone"],
  ];
  for (const [name, r, snap, expected] of table) {
    it(name, () => assert.equal(rowOwnership(r, snap), expected));
  }

  it("projects live to true, gone and reissued to false, unknown to null", () => {
    assert.deepEqual(
      ["live", "gone", "reissued", "unknown"].map(ownershipLiveness),
      [true, false, false, null],
    );
  });

  it("paneReissued keeps treating an empty recorded pid as no mismatch", () => {
    assert.equal(paneReissued("", { live: true, pid: "100" }), false);
  });
});

describe("tmuxSaysNothingThere: only a connect failure that proves no server is nothing there", () => {
  const connect = (errno) => `error connecting to /tmp/tmux-501/default (${errno})`;
  const table = [
    ["no server running", "no server running on /tmp/tmux-501/default", true],
    ["a missing socket", connect("No such file or directory"), true],
    ["Connection refused, kept for older tmux wording", connect("Connection refused"), true],
    ["a socket the process may not open (EACCES)", connect("Permission denied"), false],
    ["a connect a sandbox refuses (EPERM)", connect("Operation not permitted"), false],
    ["a socket path over the length limit", connect("File name too long"), false],
    ["a connect failure with no reason to read", "error connecting to /tmp/tmux-501/default", false],
    ["an unrelated tmux failure", "tmux: connection interrupted", false],
  ];
  for (const [name, stderr, expected] of table) {
    it(name, () => assert.equal(tmuxSaysNothingThere(new TmuxError("tmux list-panes failed", stderr)), expected));
  }
});

describe("rowOwnership: probing", () => {
  const session = `hive-row-ownership-${process.pid}`;
  let pane;
  let pid;

  before(() => {
    if (!hasTmux) return;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
    pane = tmux("list-panes", "-t", `=${session}`, "-F", "#{pane_id}").split("\n")[0];
    pid = paneField(pane, "#{pane_pid}");
  });

  after(() => cleanup(session));

  it("a supplied snapshot, even null, never launches tmux", { skip: !hasTmux && "tmux not installed" }, () => {
    const log = join(mkdtempSync(join(tmpdir(), "hive-rowown-")), "calls.log");
    const dir = recordingTmux({ log });
    withPath(dir, () => {
      rowOwnership(row(pane, pid), snapshot({ panes: { [pane]: pid }, serverAnswered: true }));
      rowOwnership(row(pane, pid), null);
    });
    assert.deepEqual(tmuxCallsIn(log), []);
  });

  it("an omitted snapshot reads the real server: matching pid live, other pid reissued, empty pid unknown", { skip: !hasTmux && "tmux not installed" }, () => {
    assert.match(pid, /^\d+$/);
    assert.equal(rowOwnership(row(pane, pid)), "live");
    assert.equal(rowOwnership(row(pane, "1")), "reissued");
    assert.equal(rowOwnership(row(pane, "")), "unknown");
    assert.equal(rowOwnership(row("%99999", pid)), "gone");
  });

  it("an omitted snapshot whose tmux call fails is unknown, not gone", { skip: !hasTmux && "tmux not installed" }, () => {
    const dir = fakeFailingTmux({ failOn: "list-panes" });
    assert.equal(withPath(dir, () => rowOwnership(row(pane, pid))), "unknown");
  });

  it("a list-panes that cannot connect (EACCES) is unknown, a missing socket is gone", { skip: !hasTmux && "tmux not installed" }, () => {
    const refused = fakeFailingTmux({ failOn: "list-panes", stderr: "error connecting to /tmp/tmux-501/default (Permission denied)" });
    assert.equal(withPath(refused, () => rowOwnership(row(pane, pid))), "unknown");
    const absent = fakeFailingTmux({ failOn: "list-panes", stderr: "error connecting to /tmp/tmux-501/default (No such file or directory)" });
    assert.equal(withPath(absent, () => rowOwnership(row(pane, pid))), "gone");
  });
});
