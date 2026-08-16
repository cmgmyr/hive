import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolRegistrationsByFile } from "./helpers.mjs";

const TOOL_REGISTRATIONS = toolRegistrationsByFile();

describe("every registered tool routes through run()", () => {
  for (const { file, src, names } of TOOL_REGISTRATIONS) {
    it(`${file}: each registerTool() call has a matching run() call in its handler`, () => {
      if (names.length === 0) return;

      const starts = [...src.matchAll(/registerTool\(/g)].map((m) => m.index);
      assert.equal(starts.length, names.length, `${file}: registerTool( occurrences do not match parsed tool names`);
      const chunks = starts.map((start, i) => src.slice(start, starts[i + 1] ?? src.length));

      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const chunk = chunks[i];

        assert.ok(
          /(?<!\.)\brun\(/.test(chunk),
          `${file}: tool "${name}" has no run( call in its handler - it would run against an orphaned store unguarded`,
        );

        assert.match(
          chunk,
          /=>\s*run\(/,
          `${file}: tool "${name}"'s handler does not call run() as its direct body`,
        );
      }
    });
  }

  it("the whole tool layer has exactly as many run() calls as registered tools", () => {

    let totalTools = 0;
    let totalRunCalls = 0;
    for (const { src } of TOOL_REGISTRATIONS) {
      totalTools += [...src.matchAll(/registerTool\(/g)].length;
      totalRunCalls += [...src.matchAll(/(?<!\.)\brun\(/g)].length;
    }
    assert.ok(totalTools > 0, "no tools found; did src/tools/ move or get renamed?");
    assert.equal(totalRunCalls, totalTools, "every registered tool must route through exactly one run( call");
  });
});
