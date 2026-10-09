import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { isolateTmux, resolvedTmuxSocket, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the isolateTmux first-call tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

describe("isolateTmux", () => {
  it("creates the tmux-<uid> socket dir with mode 0700 inside its own scratch dir", () => {
    const socket = resolvedTmuxSocket();
    assert.equal(dirname(dirname(socket)), realpathSync(process.env.TMUX_TMPDIR));
    assert.equal(statSync(dirname(socket)).mode & 0o777, 0o700);
  });

  it("the first -S tmux call on a fresh isolateTmux dir creates the server", { skip: hasTmux ? false : "tmux is not installed" }, (t) => {
    const session = "isolate-first-call";
    t.after(() => cleanup(session));
    tmux("new-session", "-d", "-s", session, "sleep 600");
    assert.doesNotThrow(() => execFileSync("tmux", ["-S", resolvedTmuxSocket(), "has-session", "-t", `=${session}`], { stdio: "ignore" }));
  });
});
