import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadProjectYml } from "../dist/projectYml.js";
import { isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the layout tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { applyLayout, claimInitialWindow, configureHiveWindow, ensureSession, paneWindow, windowLayout } = await import(
  "../dist/tmux.js"
);

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
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
  const borderSession = `hive-layout-border-test-${process.pid}`;
  const ownedSession = `hive-owned-options-${process.pid}`;
  const claimedSession = `hive-owned-claim-${process.pid}`;
  const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).replace(/\n$/, "");

  after(() => cleanup(session, borderSession, ownedSession, claimedSession));

  const panes = (window) =>
    tmux("list-panes", "-t", window, "-F", "#{pane_id} #{pane_width} #{pane_height} #{pane_left} #{pane_top}")
      .split("\n")
      .map((row) => {
        const [id, width, height, left, top] = row.split(" ");
        return { id, width: +width, height: +height, left: +left, top: +top };
      });

  it("configures the window it created while leaving user windows alone", () => {
    tmux("new-session", "-d", "-s", ownedSession, "sleep 600");

    tmux("set-option", "-g", "allow-passthrough", "off");
    tmux("set-option", "-g", "pane-border-status", "off");
    assert.equal(tmux("show-options", "-g", "-v", "allow-passthrough"), "off");
    assert.equal(tmux("show-options", "-g", "-v", "pane-border-status"), "off");

    const userWindow = tmux(
      "new-window", "-P", "-F", "#{session_name}:#{window_id}", "-t", `=${ownedSession}`, "sleep 600",
    );
    configureHiveWindow(userWindow);
    assert.equal(tmux("show-options", "-w", "-A", "-v", "-t", userWindow, "pane-border-status"), "off");
    assert.equal(tmux("display-message", "-p", "-t", userWindow, "#{@hive-owned}"), "");

    const started = ensureSession(claimedSession, dirs.projectDir, { envFlags: [], command: "sleep 600" });
    const { pane, window } = claimInitialWindow(started, "claimed", null);
    assert.equal(tmux("show-options", "-w", "-v", "-t", window, "@hive-owned"), "1");
    assert.equal(tmux("show-options", "-p", "-A", "-v", "-t", pane, "allow-passthrough"), "all");
    assert.equal(tmux("show-options", "-w", "-A", "-v", "-t", window, "pane-border-status"), "top");
    assert.equal(
      tmux("show-options", "-w", "-A", "-v", "-t", window, "pane-border-format"),
      " #{pane_index} #{pane_title} ",
    );
    assert.equal(tmux("show-options", "-w", "-A", "-v", "-t", window, "monitor-bell"), "on");

    const staleWindow = tmux(
      "new-window", "-P", "-F", "#{session_name}:#{window_id}", "-t", `=${claimedSession}`, "sleep 600",
    );
    tmux("kill-window", "-t", staleWindow);
    tmux("set-window-option", "-t", window, "pane-border-status", "bottom");
    configureHiveWindow(staleWindow);
    assert.equal(
      tmux("show-options", "-w", "-A", "-v", "-t", window, "pane-border-status"),
      "bottom",
      "a dead target must not reconfigure the live hive-owned fallback window",
    );
    configureHiveWindow(window);
    assert.equal(tmux("show-options", "-w", "-A", "-v", "-t", window, "pane-border-status"), "top");

    const child = tmux("split-window", "-P", "-F", "#{pane_id}", "-t", window, "sleep 600");
    assert.equal(
      tmux("show-options", "-p", "-A", "-v", "-t", child, "allow-passthrough"),
      "all",
      "a later split must inherit the window-scoped pane option",
    );
    tmux("respawn-pane", "-k", "-t", pane, "sleep 600");
    assert.equal(tmux("show-options", "-w", "-A", "-v", "-t", window, "pane-border-status"), "top");
  });

  it("keeps the lead pane main across a spawn and close cycle", () => {
    tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "sleep 600");
    const window = tmux("list-windows", "-t", `=${session}`, "-F", "#{session_name}:#{window_id}").split("\n")[0];

    tmux("set-window-option", "-t", window, "pane-border-status", "off");
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

  it("still gives the lead the main slot under the pane borders hive applies", () => {

    tmux("new-session", "-d", "-s", borderSession, "-x", "200", "-y", "50", "sleep 600");
    const window = tmux(
      "list-windows", "-t", `=${borderSession}`, "-F", "#{session_name}:#{window_id}",
    ).split("\n")[0];
    tmux("set-window-option", "-t", window, "pane-border-status", "top");
    const lead = panes(window)[0].id;

    tmux("split-window", "-t", window, "sleep 600");
    applyLayout(window, "main-vertical");

    const arranged = panes(window);
    assert.equal(windowLayout(window), "main-vertical");
    assert.equal(arranged[0].id, lead, "the lead should still hold the main pane slot");
    assert.equal(arranged[0].left, 0);
    assert.equal(arranged[0].height, 49, "every pane gives one row back to its border");
    assert.ok(
      Math.abs(arranged[0].width - 100) <= 1,
      `lead should still take about half of 200 columns, got ${arranged[0].width}`,
    );
    assert.ok(arranged[1].left > 0, "workers still stack to the right");
  });

  it("does not throw on a dead window", () => {
    applyLayout(`=${session}:@9999`, "main-vertical");
    assert.equal(windowLayout(`=${session}:@9999`), null);
    assert.equal(paneWindow("%99999"), null);
  });
});
