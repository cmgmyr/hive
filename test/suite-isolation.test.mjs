import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

// Issue #21. The doctor tests added in #20 read whatever tmux server the
// ambient env points at, which during development is the session the lead and
// its workers are running in. Nothing there writes, so the blast radius was
// zero, and that is exactly the wrong reason to leave it: the isolation is
// what makes the guarantee, not the fact that today's assertions happen only
// to read. A later test that adds a write, or a doctor check that grows one,
// inherits an unisolated server and nobody rereads the setup to notice.
//
// Fixing the file is not the fix. The rule "isolate tmux before you spawn
// hive" was already written down in CLAUDE.md and in isolateTmux's own header
// when seven files did not follow it, so the rule was not what was missing.
// This reads the suite's own source and fails when a file can reach tmux and
// does not isolate first, on the same reasoning as store-isolation.test.mjs:
// a guarantee that depends on the next author remembering is not a guarantee.

const TEST_DIR = join(REPO, "test");
const files = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();
// Read once. Both describes below want every file's text, and the second one
// wants helpers.mjs too.
const sources = new Map(
  [...files, "helpers.mjs"].map((f) => [f, readFileSync(join(TEST_DIR, f), "utf8")]),
);

// Anything that starts a hive process, plus a direct import of the module that
// runs tmux. Every hive command can reach the server: `hive status` and
// `hive doctor` both call janitor(), which probes it, and the MCP agent tools
// drive it outright. Which commands reach it is not worth tracking per file,
// because it changes whenever a command does.
//
// ONE table, with a flag, rather than a second list for the ordering check.
// The first version of this file had two, and they had already drifted apart
// by a `\s*` on the day it was written.
//
// `spawns` marks the ones that start a process when the line RUNS. A static
// import is not one: node hoists every static import above the whole module
// body, so "import dist/tmux.js after isolateTmux" is not a thing anyone can
// write, and it is harmless anyway because tmux.ts execs no tmux at load.
const REACHES_TMUX = [
  { pattern: /\brunCli\s*\(/, what: "runCli", spawns: true },
  { pattern: /\brunNode\s*\(/, what: "runNode", spawns: true },
  { pattern: /new McpClient\s*\(/, what: "McpClient", spawns: true },
  // hive's own entry points placed into an argv array, which the helper names
  // above miss. store-isolation.test.mjs runs `dist/cli.js status` this way,
  // and `status` runs the janitor, so a file can reach the server without
  // going through runCli at all.
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
      // Column zero and not a comment. isolateTmux sets TMUX_TMPDIR and clears
      // TMUX/TMUX_PANE in this process so every child inherits them, which does
      // nothing for a child that already started; inside a before() hook it
      // would run after another file-level statement had already spawned.
      //
      // `^\S` rather than a startsWith(" ") check, because that check reads a
      // tab-indented call as top level, which is exactly the not-top-level case
      // this exists to reject. `[^\s/]` because a column-zero COMMENT naming
      // isolateTmux would otherwise satisfy the guard without calling anything.
      //
      // The negative lookahead consumes nothing, which matters: `^[^\s/].*`
      // spent a character before `.*` could start, so a file whose line IS the
      // bare call, `isolateTmux("...")` at column zero with no assignment in
      // front of it, read as "never calls isolateTmux". A file that does not
      // need the returned handle is the normal shape for a test that spawns
      // hive but creates no tmux session of its own.
      const topLevelCall = /^(?![\s/]).*\bisolateTmux\(/;
      const at = lines.findIndex((line) => topLevelCall.test(line));
      assert.notEqual(
        at,
        -1,
        `${file} can reach tmux but never calls isolateTmux at module top level. Add it there ` +
          "and clean up with the handle it returns; see test/helpers.mjs.",
      );

      // Nothing above it may spawn, at any indentation: a spawn inside a
      // top-level IIFE or await block runs before the call just as surely as an
      // unindented one does.
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
  it("never tears down with kill-server", () => {
    // CLAUDE.md's invariant, and the one mistake in this area that is not
    // recoverable. Code under test resolves its server from the env, so a test
    // cannot pin one with -L; a bare kill-server takes down whatever the
    // ambient env points at, which during development is the session running
    // the suite.
    //
    // Quoted, because probe.test.mjs and helpers.mjs both name it in a comment
    // explaining why they do not call it, and a check that cannot tell those
    // apart from a call gets deleted rather than obeyed.
    for (const file of [...files, "helpers.mjs"]) {
      const source = sources.get(file);
      assert.ok(
        !/["']kill-server["']/.test(source),
        `${file} must tear down with kill-session -t =<name>, never kill-server`,
      );
    }
  });

  it("never asks the server for every pane it has", () => {
    // list-panes -a lists every pane on the SERVER and ignores -t, so a test
    // written as `list-panes -a -s -t =mysession` reads as scoped and is not.
    // On a correctly isolated server that is harmless, which is exactly why it
    // survived: it is only wrong on the day isolation is already broken, and
    // then it hands the test the developer's own panes to type into.
    //
    // That day was 2026-07-29. cleanup() removed the socket dir, TMUX_TMPDIR
    // went on naming a path tmux does not create, tmux fell back to the shared
    // socket, and a `list-panes -a` picked up two live claude panes as the
    // watched and delivery targets for a wake test. Both halves are fixed; this
    // is the half a future test file can reintroduce on its own.
    //
    // Scope with -s -t =<session> instead: all panes in that session, across
    // its windows, and nothing else.
    for (const file of [...files, "helpers.mjs"]) {
      const source = sources.get(file);
      assert.ok(
        !/["']list-panes["']\s*,\s*["']-a["']/.test(source),
        `${file} must scope list-panes to its own session (-s -t =<name>), never -a`,
      );
    }
  });
});
