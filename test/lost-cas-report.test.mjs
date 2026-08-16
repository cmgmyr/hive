import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { classifyLostCas } = await import("../dist/tools/agents.js");

describe("classifyLostCas", () => {
  it("reads a closed, unparked row as retired and not parked", () => {
    assert.deepEqual(classifyLostCas({ status: "closed", parked_at: "" }), { outcome: "retired", parked: false });
  });

  it("reads a closed row carrying a park stamp as retired AND parked", () => {
    assert.deepEqual(classifyLostCas({ status: "closed", parked_at: "2026-08-11 20:00:00" }), {
      outcome: "retired",
      parked: true,
    });
  });

  it("reads a running row as revived, regardless of any stale park stamp", () => {

    assert.deepEqual(classifyLostCas({ status: "running", parked_at: "2026-08-11 20:00:00" }), {
      outcome: "revived",
    });
  });
});
