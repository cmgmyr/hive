import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { isolateTmux, recordingTmux, scratchDirs, tmuxCallsIn } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the sendText paste-path tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sendText, sessionName } = await import("../dist/tmux.js");

const session = sessionName();
let pane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", dirs.projectDir, "cat"]);
  pane = execFileSync("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
});

after(() => {
  cleanup(session);
});

// Must await inside: sendText sleeps ENTER_DELAY_MS before the Enter, so a
// synchronous finally would restore the PATH before that call is made and the
// shim would never see it.
async function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

describe("an empty text still presses Enter, where the buffer path would fail instead", () => {
  it("issues no set-buffer and no paste-buffer, and sends the Enter", NEEDS_TMUX, async () => {
    const log = join(dirs.tmp, "empty-calls.log");
    const shim = recordingTmux({ log });

    await withPath(shim, () => sendText(pane, "", true));

    const calls = tmuxCallsIn(log);
    assert.deepEqual(
      calls.filter((c) => c[0] === "set-buffer" || c[0] === "paste-buffer"),
      [],
      "an empty text must not reach the buffer path: set-buffer creates no buffer and paste-buffer then fails",
    );
    assert.ok(
      calls.some((c) => c[0] === "send-keys" && c.includes("Enter")),
      "the Enter is the whole point of an empty send and must still be delivered",
    );
  });
});

describe("a failed paste does not strand its buffer on the tmux server", () => {
  it("deletes the named buffer when paste-buffer fails after set-buffer succeeded", NEEDS_TMUX, async () => {
    const log = join(dirs.tmp, "leak-calls.log");
    // One shim rather than two on the PATH: fakeFailingTmux execs the real tmux
    // directly, so a recorder behind it would never see the calls.
    const shim = mkdtempSync(join(tmpdir(), "hive-pastefail-"));
    const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFileSync(log, "");
    writeFileSync(
      join(shim, "tmux"),
      `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\n'; } >> ${JSON.stringify(log)}\n` +
        `if [ "$1" = "paste-buffer" ]; then echo "tmux: paste-buffer failed" >&2; exit 1; fi\n` +
        `exec ${real} "$@"\n`,
      { mode: 0o755 },
    );

    await withPath(shim, () =>
      assert.rejects(sendText(pane, "text that must not be left on the server", false)),
    );

    const calls = tmuxCallsIn(log);
    const buffered = calls.find((c) => c[0] === "set-buffer");
    assert.ok(buffered, "the test is meaningless unless set-buffer really ran");
    const name = buffered[buffered.indexOf("-b") + 1];
    assert.ok(
      calls.some((c) => c[0] === "delete-buffer" && c.includes(name)),
      `the buffer ${name} holding the full message text was never deleted; nothing else ever reclaims a named buffer`,
    );
  });
});
