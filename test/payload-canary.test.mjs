import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeRows, evaluateRun } from "../scripts/payload-canary.mjs";
import { deriveManifest } from "../scripts/payload-shape.mjs";

// analyzeRows and evaluateRun are the two pure functions this lane's live
// wiring script (scripts/payload-canary.mjs) uses to decide, and report,
// whether a run passed. Both were exported and untouched by `npm test`
// until this file: exactly the "checker that cannot fire" shape
// test/payload-shape.test.mjs's own header warns about, one directory over.
// No isolateTmux() here: plain data in, plain data out, same as
// test/part-c-assert.test.mjs one door over for the same reason.

// A tiny synthetic corpus, not the real one: these tests are pinning
// analyzeRows' OWN aggregation (stopCount, anyStopWithBackgroundTasks,
// parseFailures, findings roll-up), not payload-shape.mjs's derivation,
// which test/payload-shape.test.mjs already owns against the real corpus.
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
    // Missing background_tasks entirely: required in the synthetic
    // manifest above (present, if sometimes empty, in both Stop fixtures).
    const rows = [row("stop", { hook_event_name: "Stop", session_id: "s1" })];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.equal(result.shapeFailures.length, 1);
    assert.equal(result.shapeFailures[0].kind, "missing_required");
  });

  it("keys the manifest lookup on the payload's hook_event_name, never the DB row's own event column", () => {
    // The row's own `event` column is "stop" (src/hook.ts's CLI arg), which
    // is not a key the manifest has. If analyzeRows ever used row.event
    // instead of payload.hook_event_name, this well-formed Stop row would
    // get an "unknown_event" INFO instead of being checked for real.
    const rows = [row("stop", { hook_event_name: "Stop", session_id: "s1", background_tasks: [] })];
    const result = analyzeRows(SYNTHETIC_MANIFEST, rows);
    assert.equal(result.perRow[0].rowEvent, "stop");
    assert.equal(result.perRow[0].hookEvent, "Stop");
    assert.ok(!result.perRow[0].findings.some((f) => f.kind === "unknown_event"));
  });
});

describe("evaluateRun", () => {
  // A fully conformant, fully VALID run: identical git snapshots, a fired
  // (not cancelled) wake, the branch's own hive-iso server confirmed, at
  // least one subagent demonstrably ran, and a clean analysis. Each test
  // below mutates ONE field off this baseline.
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
    partial.completionFiles = []; // would independently be INCONCLUSIVE
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

  // THE TWO TESTS THAT MATTER MOST (lead review after run 2): a lazy worker
  // and a real #24 regression must never produce the same verdict, even
  // though both leave background_tasks empty. The only thing that tells
  // them apart is whether a subagent demonstrably ran.
  it("run 2's actual shape: no subagent ran and background_tasks is empty -> INCONCLUSIVE, not FAIL", () => {
    const partial = cleanPartial();
    partial.completionFiles = [];
    partial.mcpServerConfirmed = null; // run 2's own observed shape: step 0 never ran either
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
