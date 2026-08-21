import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
await assertScratchStore();

const { truncateWithEllipsis } = await import("../dist/dashboard.js");
const { truncate } = await import("../dist/kickoff.js");
const { truncateBody } = await import("../dist/tools/wakes.js");
const { renderLeadPointer } = await import("../dist/leadMessage.js");

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const reproducer = (n) => `${"e".repeat(n)}\u{1F600} rest of text after the emoji`;

describe("surrogate-safe truncation (todo 411)", () => {
  it("dashboard.ts's truncateWithEllipsis does not split an astral character at the bound", () => {
    const out = truncateWithEllipsis(reproducer(39), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("dashboard.ts's truncateWithEllipsis keeps an astral character whole when it fits inside the bound", () => {
    const out = truncateWithEllipsis(reproducer(38), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  it("kickoff.ts's truncate does not split an astral character at the bound", () => {
    const out = truncate(reproducer(39), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("kickoff.ts's truncate keeps an astral character whole when it fits inside the bound", () => {
    const out = truncate(reproducer(38), 40);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  it("wakes.ts's truncateBody does not split an astral character at its fixed 120 bound", () => {

    const out = truncateBody(reproducer(119));
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("wakes.ts's truncateBody keeps an astral character whole when it fits inside the bound", () => {
    const out = truncateBody(reproducer(118));
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  it("leadMessage.ts's renderLeadPointer does not split an astral character at its 140-char head bound", () => {
    const out = renderLeadPointer(7, "w", `${reproducer(139)}${"z".repeat(400)}`);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
  });

  it("leadMessage.ts's renderLeadPointer keeps an astral character whole when it fits inside the head", () => {
    const out = renderLeadPointer(7, "w", `${reproducer(138)}${"z".repeat(400)}`);
    assert.ok(!LONE_SURROGATE.test(out), `must not contain a lone surrogate half: ${JSON.stringify(out)}`);
    assert.ok(out.includes("\u{1F600}"), `must keep a fitting emoji intact: ${JSON.stringify(out)}`);
  });

  describe("no output change for input with no astral character on the boundary", () => {
    it("truncateWithEllipsis: unchanged on plain ASCII past the bound", () => {
      const text = "c".repeat(50);
      assert.equal(truncateWithEllipsis(text, 40), `${text.slice(0, 40)}…`);
    });

    it("truncateWithEllipsis: unchanged (no ellipsis) on text under the bound", () => {
      const text = "short text";
      assert.equal(truncateWithEllipsis(text, 40), text);
    });

    it("truncate: unchanged on plain ASCII past the bound", () => {
      const text = "c".repeat(50);
      assert.equal(truncate(text, 40), `${text.slice(0, 40).trimEnd()}\n[truncated]`);
    });

    it("truncate: unchanged on text under the bound", () => {
      const text = "short text";
      assert.equal(truncate(text, 40), text);
    });

    it("truncateBody: unchanged on plain ASCII past the 120 bound", () => {
      const text = "c".repeat(150);
      assert.equal(truncateBody(text), `${text.slice(0, 120)}…`);
    });

    it("truncateBody: unchanged on text under the 120 bound", () => {
      const text = "short body";
      assert.equal(truncateBody(text), text);
    });
  });
});
