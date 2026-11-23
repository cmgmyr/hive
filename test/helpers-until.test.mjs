import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { until, untilOrTimeout } from "./helpers.mjs";

describe("until helpers", () => {
  it("until throws on timeout", async () => {
    await assert.rejects(until(() => false, 5, 1, "marker appeared"), {
      name: "AssertionError",
      message: "Timed out after 5ms waiting for marker appeared",
    });
  });

  it("until names the predicate when it times out without a message", async () => {
    await assert.rejects(until(() => false, 5, 1), {
      name: "AssertionError",
      message: "Timed out after 5ms waiting for () => false",
    });
  });

  it("untilOrTimeout returns false on timeout without throwing", async () => {
    assert.equal(await untilOrTimeout(() => false, 5, 1), false);
  });
});
