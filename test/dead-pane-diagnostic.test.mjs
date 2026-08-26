import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { isolateTmux, McpClient, resolvedTmuxSocket, scratchDirs, scratchGit } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the dead-pane diagnostic tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { pollPaneReadiness, sessionName } = await import("../dist/tmux.js");

scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

// Reproduces todo 581 comment 1922 exactly: codex printed a one-line usage error to stderr
// (an unrecognized flag) and exited immediately, before hive's readiness probe ever saw the box.
const ERROR_MARKER = "error: unexpected argument '--effort' found";
const binDir = join(dirs.tmp, "harness-bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "codex"), `#!/bin/sh\necho "${ERROR_MARKER}" 1>&2\nexit 2\n`);
chmodSync(join(binDir, "codex"), 0o755);

// A captured pane wraps at its own column width, which can split ERROR_MARKER across a newline
// (e.g. "fo\nund") depending on layout - unrelated to whether the marker is actually present.
// Strip all whitespace from both sides before comparing so wrapping can't fail the match.
const squash = (s) => s.replace(/\s+/g, "");
const containsMarker = (s) => typeof s === "string" && squash(s).includes(squash(ERROR_MARKER));

let mcp;
let anchor;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "10000", HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
  });
  await mcp.start();

  // A stable, long-lived pane first, so every dies-fast spawn below SPLITS into the existing
  // session instead of minting a brand-new one. A brand-new session whose sole window's process
  // exits immediately hits a separate, already-accepted race (a command that exits immediately
  // destroys the session `new-session` just made, per .claude/rules/tmux-and-panes.md) - out of
  // scope for this diagnostic and not what todo 585 is about.
  if (hasTmux) anchor = await mcp.call("agent_spawn", { name: "anchor", command: "sleep", extra_args: ["600"] });
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe(
  "a worker whose command exits during startup leaves a recoverable diagnostic",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("agent_spawn's receipt says the process exited and carries its stderr, not just 'never became ready'", async () => {
      const receipt = await mcp.call("agent_spawn", { name: "dies-fast", harness: "codex" });

      assert.equal(receipt.ready, false, "a command that exits on startup is not ready");
      assert.equal(
        receipt.exited,
        true,
        "the receipt must say the pane's process EXITED, distinctly from a live pane that " +
          `simply never became ready. Got: ${JSON.stringify(receipt)}`,
      );
      assert.ok(
        containsMarker(receipt.tail),
        `the pane's final screen (carrying the one string that explains the failure) must be on ` +
          `the receipt. Got tail: ${JSON.stringify(receipt.tail)}`,
      );
    });

    it("agent_status can reach the same diagnostic after the pane is gone", async () => {
      const receipt = await mcp.call("agent_spawn", { name: "dies-fast-2", harness: "codex" });
      const status = await mcp.call("agent_status", { agent_id: receipt.agent_id });

      assert.ok(
        containsMarker(status.exit_tail),
        `agent_status must expose the same captured screen agent_spawn saw, even though the tmux ` +
          `pane is gone by the time agent_status is called. Got: ${JSON.stringify(status)}`,
      );
    });

    it("the shared window's remain-on-exit is cleared once the gone outcome is handled", async () => {
      const receipt = await mcp.call("agent_spawn", { name: "dies-fast-3", harness: "codex" });
      assert.equal(receipt.exited, true);

      const window = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", anchor.tmux_target, "#{session_name}:#{window_id}"],
        { encoding: "utf8" },
      ).trim();
      const options = execFileSync("tmux", ["show-window-options", "-t", window], { encoding: "utf8" });
      assert.doesNotMatch(
        options,
        /remain-on-exit on/,
        `the anchor's shared window must not be left with remain-on-exit on after the dying pane's ` +
          `outcome was handled - a sibling (the anchor itself, or any later spawn into this window) ` +
          `would otherwise be silently retained on its own next exit. Got: ${options}`,
      );
    });
  },
);

describe(
  "pollPaneReadiness never reads an unreadable probe as the pane having exited",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `${sessionName()}-null-probe`;
    let target;

    before(() => {
      if (!hasTmux) return;
      const socket = resolvedTmuxSocket();
      target = execFileSync(
        "tmux",
        ["-S", socket, "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "sleep 600"],
        { encoding: "utf8" },
      ).trim();
    });

    after(() => cleanup(session));

    it("a hasInputBox that returns null on a genuinely alive pane resolves to timeout, never gone", async () => {
      // paneProcessExited(target) is the sole source of truth for "gone" now; this pane is alive
      // (sleep 600) so it always answers false. A hasInputBox that returns null simulates an
      // unrelated unreadable-probe case (a tmux timeout, an untrusted server) per its own contract
      // in defaultHasInputBox/codexPaneHasInputBox: null means "could not tell", never "confirmed dead".
      const outcome = await pollPaneReadiness(target, 900, () => null);
      assert.notEqual(
        outcome,
        "gone",
        "an unreadable probe on a live pane must never be reported as the process having exited",
      );
      assert.equal(outcome, "timeout");
    });
  },
);

describe(
  "remain-on-exit is cleared even when the guarded block throws",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {

    const throwDirs = scratchDirs();
    scratchGit(throwDirs.projectDir, "init", "-q");
    scratchGit(throwDirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
    writeFileSync(join(throwDirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

    const throwFakeHome = join(throwDirs.tmp, "fake-home");
    mkdirSync(join(throwFakeHome, ".codex"), { recursive: true });
    writeFileSync(join(throwFakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

    const throwBinDir = join(throwDirs.tmp, "harness-bin");
    mkdirSync(throwBinDir, { recursive: true });
    writeFileSync(join(throwBinDir, "codex"), `#!/bin/sh\necho "${ERROR_MARKER}" 1>&2\nexit 2\n`);
    chmodSync(join(throwBinDir, "codex"), 0o755);

    let throwMcp;
    let throwAnchor;

    before(async () => {
      if (!hasTmux) return;
      throwMcp = new McpClient({
        cwd: throwDirs.projectDir,
        dataDir: throwDirs.dataDir,
        env: { HIVE_SPAWN_READY_MS: "10000", HOME: throwFakeHome, PATH: `${throwBinDir}:${process.env.PATH}` },
      });
      await throwMcp.start();
      throwAnchor = await throwMcp.call("agent_spawn", { name: "anchor", command: "sleep", extra_args: ["600"] });

      // Forces the exit_tail UPDATE inside agent_spawn's readiness handler to throw a real,
      // ordinary SQLite error - not a simulated one - by dropping the column a second connection
      // to the SAME running server's database file. WAL mode allows the second connection; the
      // server's own db.prepare() re-parses the schema on every call, so it sees the drop
      // immediately on its next write.
      const store = new Database(join(throwDirs.dataDir, "hive.db"));
      try {
        store.exec("ALTER TABLE agents DROP COLUMN exit_tail");
      } finally {
        store.close();
      }
    });

    after(async () => {
      if (throwMcp) await throwMcp.close();

      // sessionName() reads HIVE_DATA_DIR at call time; this file's own process still has it set
      // to the main scratch dir, not throwDirs, so it must be flipped to compute THIS server's
      // session name, then restored.
      const savedDataDir = process.env.HIVE_DATA_DIR;
      process.env.HIVE_DATA_DIR = throwDirs.dataDir;
      const throwSession = sessionName();
      process.env.HIVE_DATA_DIR = savedDataDir;
      cleanup(throwSession);
    });

    it("a throw from the exit_tail write still clears the shared window's remain-on-exit", async () => {
      const receipt = await throwMcp.call("agent_spawn", { name: "dies-fast", harness: "codex" });

      // exited/exitTail are already set before the throwing UPDATE runs, so the receipt still
      // reports exited: true - that part is unaffected by this test. What this test pins is the
      // one thing the throw must never do: leave the window's remain-on-exit stuck on.
      assert.equal(receipt.exited, true);

      const window = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", throwAnchor.tmux_target, "#{session_name}:#{window_id}"],
        { encoding: "utf8" },
      ).trim();
      const options = execFileSync("tmux", ["show-window-options", "-t", window], { encoding: "utf8" });
      assert.doesNotMatch(
        options,
        /remain-on-exit on/,
        `an exception thrown while handling the "gone" outcome must not leave the shared window's ` +
          `remain-on-exit on. Got: ${options}`,
      );
    });
  },
);
