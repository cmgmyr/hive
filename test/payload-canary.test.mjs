import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeRows, evaluateRun } from "../scripts/payload-canary.mjs";
import { deriveManifest } from "../scripts/payload-shape.mjs";

const SYNTHETIC_MANIFEST = deriveManifest([
  { event: "Stop", payload: { hook_event_name: "Stop", session_id: "s1", background_tasks: [] } },
  {
    event: "Stop",
    payload: { hook_event_name: "Stop", session_id: "s1", background_tasks: [{ id: "a", type: "subagent", status: "running" }] },
  },
  { event: "UserPromptSubmit", payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" } },
]);

function row(dbEvent, payload) {
  return { event: dbEvent, payload: JSON.stringify(payload), created_at: "2026-01-01 00:00:00.000" };
}

describe("analyzeRows", () => {
  it("passes clean, aligns stopCount with background_tasks ever populated", () => {
    const rows = [
      row("prompt", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" }),
      row("stop", { hook_event_name: "Stop", session_id: "s1", background_tasks: [{ id: "a", type: "subagent", status: "running" }] }),
      row("stop", { hook_event_name: "Stop", session_id: "s1", background_tasks: [] }),
    ];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.deepEqual(result.shapeFailures, []);
    assert.equal(result.stopCount, 2);
    assert.equal(result.anyStopWithBackgroundTasks, true);
    assert.equal(result.runLevelOk, true);
    assert.equal(result.parseFailures, 0);
  });

  it("reports runLevelOk false when no Stop ever carried a non-empty background_tasks", () => {
    const rows = [
      row("stop", { hook_event_name: "Stop", session_id: "s1", background_tasks: [] }),
      row("stop", { hook_event_name: "Stop", session_id: "s1", background_tasks: [] }),
    ];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.equal(result.stopCount, 2);
    assert.equal(result.anyStopWithBackgroundTasks, false);
    assert.equal(result.runLevelOk, false);
  });

  it("counts an unparseable payload as a parse failure, not a Stop or a finding", () => {
    const rows = [{ event: "stop", payload: "{not valid json", created_at: "2026-01-01 00:00:00.000" }];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.equal(result.parseFailures, 1);
    assert.equal(result.stopCount, 0);
    assert.equal(result.perRow[0].findings.length, 0);
    assert.ok(result.perRow[0].parseError);
  });

  it("rolls a real shape finding up into shapeFailures", () => {

    const rows = [row("stop", { hook_event_name: "Stop", session_id: "s1" })];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.equal(result.shapeFailures.length, 1);
    assert.equal(result.shapeFailures[0].kind, "missing_required");
  });

  it("keys the manifest lookup on the payload's hook_event_name, never the DB row's own event column", () => {

    const rows = [row("stop", { hook_event_name: "Stop", session_id: "s1", background_tasks: [] })];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.equal(result.perRow[0].rowEvent, "stop");
    assert.equal(result.perRow[0].hookEvent, "Stop");
    assert.ok(!result.perRow[0].findings.some((f) => f.kind === "unknown_event"));
  });
});

describe("evaluateRun", () => {

  function cleanPartial() {
    return {
      gitBefore: { head: "abc123", status: "" },
      gitAfter: { head: "abc123", status: "" },
      timer: { fired_at: "2026-01-01 00:00:10", cancelled_at: null },
      mcpServerConfirmed: "mcp__hive-iso__whoami",
      completionFiles: ["1.completed"],
      analysis: {
        perRow: [],
        shapeFailures: [],
        shapeInfos: [],
        parseFailures: 0,
        stopCount: 1,
        anyStopWithBackgroundTasks: true,
        runLevelOk: true,
      },
    };
  }

  it("PASSes on a fully clean, fully valid partial", () => {
    const result = evaluateRun(cleanPartial(), undefined);
    assert.deepEqual(result, { verdict: "PASS", reasons: [] });
  });

  it("FAILS when HEAD moved during the run even with an identical status (the commit-inside-checkout case)", () => {
    const partial = cleanPartial();
    partial.gitAfter = { head: "def456", status: partial.gitBefore.status };
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.reasons.some((r) => /HEAD moved/.test(r)), JSON.stringify(result.reasons));
  });

  it("FAILS when git status changed during the run even with an identical HEAD", () => {
    const partial = cleanPartial();
    partial.gitAfter = { head: partial.gitBefore.head, status: "M some-file.txt\n" };
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.reasons.some((r) => /git status changed/.test(r)), JSON.stringify(result.reasons));
  });

  it("a dirtied tree FAILS even when the run was ALSO otherwise inconclusive -- git checks first", () => {
    const partial = cleanPartial();
    partial.gitAfter = { head: "def456", status: partial.gitBefore.status };
    partial.completionFiles = [];
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.reasons.some((r) => /HEAD moved/.test(r)), JSON.stringify(result.reasons));
  });

  it("is INCONCLUSIVE (not FAIL) when the idle wake's timer never fired", () => {
    const partial = cleanPartial();
    partial.timer = { fired_at: null, cancelled_at: "2026-01-01 00:00:05" };
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.ok(result.reasons.some((r) => /idle wake never fired/.test(r)), JSON.stringify(result.reasons));
  });

  it("is INCONCLUSIVE (not FAIL) when mcpServerConfirmed is null", () => {
    const partial = cleanPartial();
    partial.mcpServerConfirmed = null;
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.ok(result.reasons.some((r) => /mcp__hive-iso__/.test(r)), JSON.stringify(result.reasons));
  });

  it("is INCONCLUSIVE (not FAIL) when mcpServerConfirmed names a tool from the wrong server", () => {
    const partial = cleanPartial();
    partial.mcpServerConfirmed = "mcp__hive__whoami";
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.ok(result.reasons.some((r) => r.includes("mcp__hive__whoami")), JSON.stringify(result.reasons));
  });

  it("run 2's actual shape: no subagent ran and background_tasks is empty -> INCONCLUSIVE, not FAIL", () => {
    const partial = cleanPartial();
    partial.completionFiles = [];
    partial.mcpServerConfirmed = null;
    partial.analysis.anyStopWithBackgroundTasks = false;
    partial.analysis.runLevelOk = false;
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.ok(result.reasons.some((r) => /no subagent ever demonstrably ran/.test(r)), JSON.stringify(result.reasons));
    assert.ok(!result.reasons.some((r) => /run-level check/.test(r)), JSON.stringify(result.reasons));
  });

  it("the real #24 detector: a subagent demonstrably ran and background_tasks is STILL empty -> FAIL, not INCONCLUSIVE", () => {
    const partial = cleanPartial();
    partial.completionFiles = ["1.completed", "2.completed", "3.completed"];
    partial.analysis.anyStopWithBackgroundTasks = false;
    partial.analysis.runLevelOk = false;
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.reasons.some((r) => /run-level check/.test(r)), JSON.stringify(result.reasons));
  });

  it("does NOT fail on parseFailures alone -- the deliberate exclusion", () => {
    const partial = cleanPartial();
    partial.analysis.parseFailures = 3;
    const result = evaluateRun(partial, undefined);
    assert.deepEqual(result, { verdict: "PASS", reasons: [] });
  });

  it("FAILS on shapeFailures, one reason naming the count", () => {
    const partial = cleanPartial();
    partial.analysis.shapeFailures = [{ severity: "FAILURE", kind: "missing_required", event: "Stop", path: "background_tasks", message: "x" }];
    const result = evaluateRun(partial, undefined);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.reasons.some((r) => /1 shape FAILURE/.test(r)), JSON.stringify(result.reasons));
  });

  it("is INCONCLUSIVE on a canaryError alone, and skips every other check a mid-run throw never got to populate", () => {
    const result = evaluateRun({}, new Error("boom"));
    assert.equal(result.verdict, "INCONCLUSIVE");
    assert.equal(result.reasons.length, 1);
    assert.ok(/the run itself failed: boom/.test(result.reasons[0]), JSON.stringify(result.reasons));
  });
});
