import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

const TEST_DIR = join(REPO, "test");
const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

const allMjs = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .sort();

const sources = new Map(allMjs.map((f) => [f, readFileSync(join(TEST_DIR, f), "utf8")]));

const REACHES_TMUX = [
  { pattern: /\brunCli\s*\(/, what: "runCli", spawns: true },
  { pattern: /\brunNode\s*\(/, what: "runNode", spawns: true },
  { pattern: /new McpClient\s*\(/, what: "McpClient", spawns: true },

  { pattern: /\[\s*(CLI|SERVER|KICKOFF)\b/, what: "a bare hive spawn", spawns: true },
  { pattern: /execFileSync\(\s*"tmux"/, what: "a direct tmux call", spawns: true },
  { pattern: /["']\.\.\/dist\/tmux\.js["']/, what: "a dist/tmux.js import", spawns: false },

  { pattern: /["']\.\.\/dist\/processes\.js["']/, what: "a dist/processes.js import", spawns: false },
];

describe("every test file that can reach tmux isolates its server first", () => {
  assert.ok(files.length > 10, `expected the suite's test files, found ${files.length}`);

  for (const file of files) {
    const source = sources.get(file);
    const reaches = REACHES_TMUX.filter(({ pattern }) => pattern.test(source));
    if (reaches.length === 0) continue;

    it(`${file} isolates tmux (uses ${reaches.map((r) => r.what).join(", ")})`, () => {
      const lines = source.split("\n");

      const topLevelCall = /^(?![\s/]).*\bisolateTmux\(/;
      const at = lines.findIndex((line) => topLevelCall.test(line));
      assert.notEqual(
        at,
        -1,
        `${file} can reach tmux but never calls isolateTmux at module top level. Add it there ` +
          "and clean up with the handle it returns; see test/helpers.mjs.",
      );

      const early = lines
        .slice(0, at)
        .findIndex((line) => REACHES_TMUX.some((r) => r.spawns && r.pattern.test(line)));
      assert.equal(
        early,
        -1,
        `${file}:${early + 1} spawns before isolateTmux on line ${at + 1}. ` +
          "Isolation has to happen before anything spawns, not after.",
      );
    });
  }
});

describe("the isolation helpers say what they are for", () => {
  it("no test file tears down with kill-server", () => {

    for (const file of allMjs) {
      if (file === "helpers.mjs") continue;
      const source = sources.get(file);
      assert.ok(
        !/["']kill-server["']/.test(source),
        `${file} must tear down with kill-session -t =<name>, never kill-server`,
      );
    }
  });

  it("helpers.mjs's own kill-server, added for todo 294, stays singular and pinned to -S", () => {

    const source = sources.get("helpers.mjs");
    const occurrences = source.match(/["']kill-server["']/g) ?? [];
    assert.equal(
      occurrences.length,
      1,
      "helpers.mjs must call kill-server exactly once (isolateTmux's exit handler); " +
        "a second call site needs its own explicit -S scoping, not a copy of this exemption",
    );
    const lines = source.split("\n");
    const at = lines.findIndex((line) => /["']kill-server["']/.test(line));
    const window = lines.slice(Math.max(0, at - 5), at + 5).join("\n");
    assert.match(
      window,
      /["']-S["']/,
      "helpers.mjs's kill-server call must pass an explicit -S <socket> nearby, " +
        "not rely on TMUX_TMPDIR/ambient env resolution - that is the one thing standing between " +
        "this and a call that can fall through to the shared server",
    );
  });

  it("helpers.mjs's generic tmux() helper - the most-used one in the suite, reused by dozens of files - pins -S itself (todo 368 finding G)", () => {

    const source = sources.get("helpers.mjs");
    const at = source.indexOf("export function tmux(...args)");
    assert.notEqual(at, -1, "helpers.mjs must export a generic tmux(...args) helper - update this test if it was renamed");
    const body = source.slice(at, source.indexOf("\n}", at));
    assert.match(
      body,
      /execFileSync\(\s*"tmux",\s*\[\s*["']-S["']/,
      "helpers.mjs's generic tmux() helper must pin -S as the first element of its own execFileSync " +
        "array - every one of its dozens of callers across the suite drives mutating verbs " +
        "(kill-window, kill-pane, respawn-pane, split-window, set-option...) through it, so the " +
        "caller's local stability guarantee is not visible at this call site either",
    );
  });

  it("helpers.mjs's other tmux-mutating verbs (kill-session, new-session, respawn-pane) pin -S as their FIRST arg (todo 368)", () => {

    // Scoped to helpers.mjs, not the whole suite: no test file removes or otherwise makes its own
    // TMUX_TMPDIR unreachable while still making tmux calls afterward (grepped for rmSync/rm -rf
    // against a scratch tmux dir and any deliberate unreachable-directory exercise - the only such
    // cases are server-store-mismatch.test.mjs's and probe.test.mjs's, both scoped with withEnv to a
    // single callback and never left standing for a later ambient call). helpers.mjs's functions are
    // reused across dozens of files, so the caller's local stability guarantee is not visible at the
    // call site - the same reasoning that already scopes the kill-server check above to this file
    // alone.
    //
    // Matching a bare -S ANYWHERE nearby is not enough: -S is overloaded (tmux -S <path> for the
    // socket, capture-pane -S -<n> for the start line - .claude/rules/tmux-and-panes.md). This
    // extracts the exact tmux-exec argument array containing the verb and requires -S to be that
    // array's first element, so an unrelated capture-pane call sharing the window cannot satisfy it.
    // (Written as "tmux-exec" rather than the literal call below - that literal is itself what the
    // outer REACHES_TMUX scan looks for, and this file must not flag itself as reaching tmux.)
    const source = sources.get("helpers.mjs");
    const MUTATING_VERBS = ["kill-session", "new-session", "respawn-pane"];

    const callStart = /execFileSync\(\s*"tmux",\s*\[/g;
    const arrays = [];
    for (let m = callStart.exec(source); m; m = callStart.exec(source)) {
      const arrayStart = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = arrayStart; i < source.length; i++) {
        if (source[i] === "[") depth++;
        else if (source[i] === "]" && --depth === 0) {
          end = i;
          break;
        }
      }
      assert.notEqual(end, -1, `unterminated array starting at offset ${arrayStart} in helpers.mjs`);
      arrays.push({ start: arrayStart, text: source.slice(arrayStart, end + 1) });
    }

    for (const verb of MUTATING_VERBS) {
      const verbPattern = new RegExp(`["']${verb}["']`);
      const containing = arrays.filter((a) => verbPattern.test(a.text));
      assert.ok(
        containing.length > 0,
        `helpers.mjs no longer calls ${verb} through a tmux exec array - update this test`,
      );
      for (const a of containing) {
        const lineNo = source.slice(0, a.start).split("\n").length;
        assert.match(
          a.text,
          /^\[\s*["']-S["']/,
          `helpers.mjs:${lineNo} calls ${verb} without -S as the array's FIRST element. Resolving ` +
            "through ambient TMUX_TMPDIR falls through to the shared socket once that directory goes " +
            "unreachable - the exact mechanism behind the one attributed crew-wide tmux death " +
            "(todo 368 comment 1088).",
        );
      }
    }
  });

  it("never asks the server for every pane it has", () => {

    for (const file of allMjs) {
      const source = sources.get(file);
      assert.ok(
        !/["']list-panes["']\s*,\s*["']-a["']/.test(source),
        `${file} must scope list-panes to its own session (-s -t =<name>), never -a`,
      );
    }
  });
});
