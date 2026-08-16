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
