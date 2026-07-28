import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadProjectYml } from "../dist/projectYml.js";
import { applyLayout, paneWindow, windowLayout } from "../dist/tmux.js";

// Every tmux call below, including the ones inside dist/tmux.js, inherits this
// process's env. Pointing TMUX_TMPDIR at a private socket dir keeps the suite
// off the developer's own tmux server, so a hard crash cannot strand a session
// there; clearing TMUX/TMUX_PANE stops tmux from treating the pane running the
// tests as a target. Short dir: unix socket paths cap out around 104 bytes.
const tmuxTmp = mkdtempSync(join(tmpdir(), "hive-tmux-"));
process.env.TMUX_TMPDIR = tmuxTmp;
delete process.env.TMUX;
delete process.env.TMUX_PANE;

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// CI installs tmux, so a skip there means the workflow lost that step and these
// tests are quietly covering nothing. Fail instead of skipping.
if (!hasTmux && process.env.CI) {
  throw new Error("tmux is missing on CI; the layout tests cannot run. Restore the install step in ci.yml.");
}

describe("hive.yml layout", () => {
  it("accepts every supported preset", () => {
    for (const value of ["tiled", "main-vertical", "main-horizontal", "even-horizontal", "even-vertical"]) {
      const { config, warnings } = loadProjectYml(ymlProject(`layout: ${value}\n`));
      assert.equal(config.layout, value);
      assert.deepEqual(warnings, []);
    }
  });

  it("warns and falls back when the value is not a preset", () => {
    const { config, warnings } = loadProjectYml(ymlProject("layout: diagonal\n"));
    assert.equal(config.layout, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /layout must be one of/);
  });

  it("leaves layout unset when the key is absent", () => {
    const { config, warnings } = loadProjectYml(ymlProject("placement: split\n"));
    assert.equal(config.layout, null);
    assert.deepEqual(warnings, []);
  });
});

describe("tmux layout application", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const session = `hive-layout-test-${process.pid}`;
  const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).replace(/\n$/, "");

  after(() => {
    try {
      // Never kill-server here. The code under test resolves its server from
      // the ambient env, so the suite cannot pin one with -L, and a bare
      // kill-server takes down whatever server that env happens to point at --
      // including the developer's own if the isolation above ever fails to
      // apply. Killing this one session caps the blast radius at our own.
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    } catch {
      // Never started, or already gone.
    }
    rmSync(tmuxTmp, { recursive: true, force: true });
  });

  const panes = (window) =>
    tmux("list-panes", "-t", window, "-F", "#{pane_id} #{pane_width} #{pane_height} #{pane_left} #{pane_top}")
      .split("\n")
      .map((row) => {
        const [id, width, height, left, top] = row.split(" ");
        return { id, width: +width, height: +height, left: +left, top: +top };
      });

  it("keeps the lead pane main across a spawn and close cycle", () => {
    tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "sleep 600");
    const window = tmux("list-windows", "-t", `=${session}`, "-F", "#{session_name}:#{window_id}").split("\n")[0];
    const lead = panes(window)[0].id;

    for (let i = 0; i < 3; i++) {
      tmux("split-window", "-t", window, "sleep 600");
      applyLayout(window, "main-vertical");
    }
    assert.equal(windowLayout(window), "main-vertical");

    const spawned = panes(window);
    assert.equal(spawned.length, 4);
    assert.equal(spawned[0].id, lead, "the lead should still hold the main pane slot");
    assert.equal(spawned[0].left, 0);
    assert.equal(spawned[0].height, 50, "main-vertical gives the lead the full column height");
    assert.ok(Math.abs(spawned[0].width - 100) <= 1, `lead should take about half of 200 columns, got ${spawned[0].width}`);
    for (const worker of spawned.slice(1)) assert.ok(worker.left > 0, "workers stack to the right");

    // Closing takes the same path agent_close does: resolve the window from
    // the pane first, kill it, then re-apply the layout hive recorded.
    const victim = spawned[1].id;
    assert.equal(paneWindow(victim), window);
    tmux("kill-pane", "-t", victim);
    applyLayout(window, windowLayout(window) ?? "tiled");

    const survivors = panes(window);
    assert.equal(survivors.length, 3);
    assert.equal(survivors[0].id, lead, "the lead should still hold the main pane slot after a close");
    assert.ok(Math.abs(survivors[0].width - 100) <= 1, `lead should keep half the window, got ${survivors[0].width}`);
    assert.equal(survivors[0].height, 50);
    const stacked = survivors.slice(1);
    assert.ok(stacked.every((p) => p.left === stacked[0].left), "workers share one column");
    assert.ok(
      Math.max(...stacked.map((p) => p.height)) - Math.min(...stacked.map((p) => p.height)) <= 1,
      "workers are evenly divided after the re-tile",
    );
  });

  it("does not throw on a dead window", () => {
    applyLayout(`=${session}:@9999`, "main-vertical");
    assert.equal(windowLayout(`=${session}:@9999`), null);
    assert.equal(paneWindow("%99999"), null);
  });
});
