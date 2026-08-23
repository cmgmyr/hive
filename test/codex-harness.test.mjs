import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-codex-harness-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { codexHarness, harnessFor, registerHarness, screenClassifiable, unregisterHarness } = await import(
  "../dist/harnesses.js"
);

// codexHarness is exported but never pushed into the default HARNESSES table (todo 523): this lane
// makes codex CLASSIFIABLE, not spawnable - the hive.yml agents: key that decides whether a project
// may spawn one is its own lane (todo 526). So harnessFor("codex") must resolve to "unknown" until
// something explicitly registers it, the same way todo 526 will.
describe("codex is exported and registerable, but not registered by default (todo 523)", () => {
  it("resolves to unknown before anything registers it", () => {
    assert.equal(harnessFor("codex").name, "unknown");
    assert.equal(screenClassifiable("codex"), false);
  });

  describe("once registered", () => {
    before(() => registerHarness(codexHarness));
    after(() => unregisterHarness("codex"));

    it("accepts the entry - a boolean flip alone would have violated 507's guard, since codex sets classifiesPaneScreen without a real paneClassifier would throw", () => {
      assert.equal(harnessFor("codex").name, "codex");
    });

    it("resolves both a bare command and one carrying flags to the same entry", () => {
      assert.equal(harnessFor("codex").name, "codex");
      assert.equal(harnessFor("codex --sandbox read-only").name, "codex");
      assert.equal(harnessFor("/opt/homebrew/bin/codex --sandbox read-only").name, "codex");
    });

    it("is now screen-classifiable, so agent_send's text path and wakes no longer refuse it at the door", () => {
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

    it("does not set supportsRename or briefDelivery - those are later, separate lanes (todo 524/525/527), not this one", () => {
      const h = harnessFor("codex");
      assert.equal(h.supportsRename, false);
      assert.equal(h.briefDelivery, null);
      assert.equal(h.stateSource, false);
    });

    it("reverts to unknown once unregistered, proving the registration (not some other path) was what made it resolve", () => {
      unregisterHarness("codex");
      assert.equal(harnessFor("codex").name, "unknown");
      registerHarness(codexHarness);
    });
  });
});
