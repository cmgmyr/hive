import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadProjectYml } from "../dist/projectYml.js";
import { applyLayout, paneWindow, recommendedTmuxOption, windowLayout } from "../dist/tmux.js";
import { isolateTmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the layout tests");

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
  const tmux = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).replace(/\n$/, "");

  after(() => cleanup(session, borderSession));

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
    // STATE THE GEOMETRY THIS TEST DEPENDS ON RATHER THAN INHERITING IT.
    // isolateTmux isolates the SOCKET, not the config: tmux reads the
    // developer's own ~/.tmux.conf when the scratch server starts. A pane
    // border costs every pane a row, so a developer who follows the raw-attach
    // advice hive itself now prints (docs/tmux.md, `hive setup --attach raw`)
    // saw this assert 49 against 50 and had no way to tell it from a real
    // regression. The recommended setting gets its own case below.
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

  it("still gives the lead the main slot under the pane borders hive recommends", () => {
    // hive tells raw-attach users to set pane-border-status top, so its own
    // layout has to survive that. The case exists because the recommendation
    // and the suite collided once already: the test above asserted 50 and got
    // 49 on a machine configured the way hive's own output asks for.
    // Read the value hive actually recommends rather than typing "top" here.
    // A copy would go on proving the OLD advice works the day the
    // recommendation changes, since the CLI and the doc would move together
    // and this file would not.
    const borderStatus = recommendedTmuxOption("pane-border-status");
    assert.ok(borderStatus, "hive no longer recommends pane-border-status; this test needs rewriting");

    tmux("new-session", "-d", "-s", borderSession, "-x", "200", "-y", "50", "sleep 600");
    const window = tmux(
      "list-windows", "-t", `=${borderSession}`, "-F", "#{session_name}:#{window_id}",
    ).split("\n")[0];
    tmux("set-window-option", "-t", window, "pane-border-status", borderStatus);
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
