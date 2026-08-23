import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-codex-harness-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { codexHarness, harnessFor, registerHarness, screenClassifiable, unregisterHarness } = await import(
  "../dist/harnesses.js"
);

// todo 523 proved codex could be CLASSIFIED; todo 524 proved hive could actually DRIVE a codex pane
// end to end (hook-trust bypass and brief delivery, both verified live) and registered it by
// default. codexHarness is exported too, for the unregister/re-register proof below and for any
// later lane that wants to build a synthetic variant against the same shape.
describe("codex is registered by default (todo 524)", () => {
  it("resolves from a bare command and one carrying flags", () => {
    assert.equal(harnessFor("codex").name, "codex");
    assert.equal(harnessFor("codex --sandbox read-only").name, "codex");
    assert.equal(harnessFor("/opt/homebrew/bin/codex --sandbox read-only").name, "codex");
  });

  it("is screen-classifiable, so agent_send's text path and wakes do not refuse it at the door", () => {
    assert.equal(screenClassifiable("codex"), true);
  });

  it("carries a real paneClassifier, not just the boolean - classifiesPaneScreen without one is exactly what registerHarness refuses", () => {
    const h = harnessFor("codex");
    assert.equal(h.classifiesPaneScreen, true);
    assert.notEqual(h.paneClassifier, null);
    assert.equal(typeof h.paneClassifier.choiceCheck, "function");
    assert.equal(typeof h.paneClassifier.inputBoxState, "function");
    assert.equal(typeof h.paneClassifier.hasInputBox, "function");
  });

  it("needs a prepared home (CODEX_HOME) rather than briefDelivery's CLI-arg shape - developer_instructions and the MCP registration live in config.toml, not on the command line", () => {
    const h = harnessFor("codex");
    assert.equal(h.briefDelivery, null);
    assert.equal(h.needsHome, true);
  });

  it("does not set supportsRename, and does not claim a state/transcript/resume correctness this lane did not prove - todo 525 (C3) owns the notify redesign and subagent latch that would earn stateSource/transcriptDir/contextTokens/supportsResume, not this one", () => {
    const h = harnessFor("codex");
    assert.equal(h.supportsRename, false);
    assert.equal(h.stateSource, false);
    assert.equal(h.transcriptDir, false);
    assert.equal(h.contextTokens, false);
    assert.equal(h.supportsResume, false);
  });

  it("reverts to unknown once unregistered, and resolves again once re-registered - proving registration (not some other path) is what makes it resolve", () => {
    unregisterHarness("codex");
    try {
      assert.equal(harnessFor("codex").name, "unknown");
      assert.equal(screenClassifiable("codex"), false);
    } finally {
      registerHarness(codexHarness);
    }
    assert.equal(harnessFor("codex").name, "codex");
  });
});
