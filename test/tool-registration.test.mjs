import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toolRegistrationsByFile } from "./helpers.mjs";

// Issue #49. run() in src/result.ts is the ONLY guarded entry point for the
// tool layer: the design's whole argument against per-tool read/write checks
// is "a new tool inherits the guard for free" (see the issue thread and
// src/result.ts's own comment), which is true only for as long as every
// registered tool's handler actually routes through run(). Nothing else in
// the suite asserts that. This scans the source directly, so a tool added
// later that forgets run() - the exact failure mode the choke point was
// chosen to avoid - fails loudly here instead of silently reading stale
// state off an orphaned store forever.

const TOOL_REGISTRATIONS = toolRegistrationsByFile();

describe("every registered tool routes through run()", () => {
  for (const { file, src, names } of TOOL_REGISTRATIONS) {
    it(`${file}: each registerTool() call has a matching run() call in its handler`, () => {
      if (names.length === 0) return;

      // One chunk per registered tool: from this registerTool( call up to
      // (not including) the next one, or EOF. The handler and its run() call
      // live inside this slice, whatever the tool's inputSchema contains.
      const starts = [...src.matchAll(/registerTool\(/g)].map((m) => m.index);
      assert.equal(starts.length, names.length, `${file}: registerTool( occurrences do not match parsed tool names`);
      const chunks = starts.map((start, i) => src.slice(start, starts[i + 1] ?? src.length));

      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const chunk = chunks[i];
        // A bare `run(`, not `.run(`: better-sqlite3's Statement.run() is an
        // unrelated method used throughout this codebase and would otherwise
        // inflate the count with something that is not our choke point.
        assert.ok(
          /(?<!\.)\brun\(/.test(chunk),
          `${file}: tool "${name}" has no run( call in its handler - it would run against an orphaned store unguarded`,
        );
        // The handler's own body must BE a call to run(), not a block that
        // calls run() somewhere inside while doing other work around it:
        // every handler in this codebase is `(args) => run(...)`, not
        // `(args) => { ...; return run(...); }`.
        assert.match(
          chunk,
          /=>\s*run\(/,
          `${file}: tool "${name}"'s handler does not call run() as its direct body`,
        );
      }
    });
  }

  it("the whole tool layer has exactly as many run() calls as registered tools", () => {
    // The blunt version of the per-file checks above, and the number named
    // in the PR: 37 tools, 37 run() calls, verified per file rather than by
    // this global count alone (two offsetting mistakes could satisfy a bare
    // total). Fails if a future tool file is added and never wired into this
    // test's directory scan.
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
