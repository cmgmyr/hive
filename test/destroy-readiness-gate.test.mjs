import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isolateTmux } from "./helpers.mjs";

const { hasTmux } = isolateTmux("destroy readiness gate tests");
const target = "%readiness-gate";
const { waitForPaneEstablished } = await import("../dist/tmux.js");

describe("destroy readiness gate", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("waits until the pane child is established before returning", () => {
    let probes = 0;
    waitForPaneEstablished(target, 200, () => ++probes >= 3, () => "123");
    assert.equal(probes, 3);
  });

  it("falls through after the bounded wait when readiness never arrives", () => {
    const started = Date.now();
    waitForPaneEstablished(target, 30, () => false, () => "123");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 25, `returned before the bound: ${elapsed}ms`);
    assert.ok(elapsed < 250, `wait exceeded the fallback bound: ${elapsed}ms`);
  });
});
