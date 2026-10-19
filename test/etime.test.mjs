import assert from "node:assert/strict";
import test from "node:test";

import { parseEtimeSeconds } from "../dist/etime.js";

test("etime accepts seconds and all standard ps forms", () => {
  for (const [value, seconds] of [
    ["2-03:04:05", 183845],
    ["03:04", 184],
    ["02:03:04", 7384],
    ["45", 45],
    ["0", 0],
    ["99:59", 5999],
    ["25:03:04", 90184],
  ]) {
    assert.equal(parseEtimeSeconds(value), seconds, value);
  }
});

test("etime rejects malformed fields and unsafe totals", () => {
  for (const value of [
    "2-03:04",
    "1-25:03:04",
    "00:60",
    "1:60:00",
    " 1:02",
    "+1:02",
    "1e2:03",
    "0x10:03",
    "1.0:02",
    ":",
    "9007199254740992",
    "999999999999999999999-00:00:00",
    "",
    "bad",
    "1:02:03:04",
  ]) {
    assert.equal(parseEtimeSeconds(value), null, value);
  }
});
