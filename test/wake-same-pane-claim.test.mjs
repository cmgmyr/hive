import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the same-pane wake claim tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const readyIdle = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");
const sink = join(dirs.tmp, "typed.log");
const env = { HIVE_SPAWN_READY_MS: "2000", HIVE_SCHEDULER_INTERVAL_MS: "100" };

let first;
let second;

before(async () => {
  first = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
  second = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
  await first.start();
  await second.start();
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);
});

after(async () => {
  await first.close();
  await second.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

describe("two scheduler instances delivering to one pane", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("submit two wakes due together as two separate lines, never one merged input", async () => {
    writeFileSync(sink, "");
    const spawned = await first.call("agent_spawn", {
      name: "same-pane-worker",
      command: fakeClaude(`cat '${readyIdle}'; cat >> '${sink}'`),
      extra_args: [],
      placement: "window",
    });
    await liveAgentRow(first, "same-pane-worker");

    const ids = [];
    for (const marker of ["SAMEPANE-ONE", "SAMEPANE-TWO"]) {
      const wake = await first.call("wake_set", { delay_seconds: 1, body: marker, deliver_to: spawned.agent_id });
      ids.push(wake.wake_id);
    }

    await until(() => {
      const typed = db.prepare(`SELECT COUNT(*) AS n FROM wakes WHERE id IN (${ids.join(",")}) AND typed_at IS NOT NULL`).get();
      return typed.n === 2;
    }, 15000);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const lines = readFileSync(sink, "utf8").split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 2, `expected two submitted lines, got: ${JSON.stringify(lines)}`);
    for (const [i, marker] of ["SAMEPANE-ONE", "SAMEPANE-TWO"].entries()) {
      assert.equal(lines.filter((line) => line.includes(marker)).length, 1, `${marker} must appear on exactly one line`);
      assert.ok(lines[i].includes("[hive wake #"), "each line is one wake");
    }
    assert.ok(!lines.some((line) => line.includes("SAMEPANE-ONE") && line.includes("SAMEPANE-TWO")), "the two wakes must not share a line");
  });

  it("releases the pane claim once a delivery finishes", async () => {
    const released = await until(
      () => db.prepare("SELECT COUNT(*) AS n FROM leases WHERE lock_key LIKE 'wake-pane:%'").get().n === 0,
      5000,
    );
    assert.ok(released, "the pane claim lease is still held after delivery finished");
  });
});
