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
// Todo 294 counselors. Broader than `files`: the kill-server checks below
// need every .mjs under test/, not just *.test.mjs, or a future non-test
// helper file (a second one alongside helpers.mjs) with a bare kill-server
// would be covered by NEITHER check - files excludes it by suffix, and the
// helpers.mjs-specific check below excludes it by name.
const allMjs = readdirSync(TEST_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .sort();
// Read once. Every describe below wants some file's text; allMjs is the
// superset, so reading it once here covers every describe.
const sources = new Map(allMjs.map((f) => [f, readFileSync(join(TEST_DIR, f), "utf8")]));

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
  it("no test file tears down with kill-server", () => {
    // CLAUDE.md's invariant for every FILE in the suite, still absolute here:
    // code under test resolves its server from the env, so a test cannot pin
    // one with -L, and a bare kill-server takes down whatever the ambient env
    // points at, which during development is the session running the suite.
    // helpers.mjs itself is checked separately below, for a narrower rule -
    // see that test for why isolateTmux() is now allowed exactly one.
    //
    // Quoted, because probe.test.mjs names it in a comment explaining why it
    // does not call it, and a check that cannot tell that apart from a call
    // gets deleted rather than obeyed.
    //
    // Iterates allMjs minus helpers.mjs, not `files`: a future non-test .mjs
    // helper alongside helpers.mjs (a second shared-code file, not matching
    // *.test.mjs) needs to be covered here too, or it escapes both this
    // check and the narrower one below by not matching either's selector.
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
    // Todo 294. cleanup()'s by-name kill-session left any session a describe
    // forgot to name (or named from stale env - the actual bug this todo
    // found, test/attach-mode.test.mjs) outliving the file: the SERVER that
    // `new-session -d` forks on a cold socket setsid()s away from this
    // process tree entirely, so nothing here dies with a parent, and it kept
    // running after its own socket directory was rm -rf'd out from under it,
    // unreachable and never asked to exit again. isolateTmux()'s exit handler
    // now kills that server too, before removing the directory.
    //
    // This does not weaken the rule above. The general check still forbids a
    // BARE kill-server, which resolves through the ambient env and can reach
    // the shared server; the whole reason this one is safe is that it is not
    // bare. An EARLIER version of this call scoped itself by passing
    // TMUX_TMPDIR: tmuxTmp in the child's env instead of -S, and counselors
    // caught why that was still not safe: TMUX_TMPDIR names a directory tmux
    // must be able to REACH, not a pinned server, and tmuxSocketPath()'s own
    // fallback rule (src/tmux.ts) means an unreachable directory resolves
    // silently to the SHARED socket - an env-scoped call could still become
    // a bare one under the right failure, which is exactly what this test
    // could not have caught, because it only looked for TMUX_TMPDIR nearby,
    // not for whether the call could ever fall through it. -S has no
    // fallback to fall through: it names the socket FILE directly, so this
    // is checked against -S now, a stronger claim than the env token ever
    // was. Checked structurally rather than trusted: kill-server must appear
    // EXACTLY once in helpers.mjs (one call site, not a second one added
    // without this same scoping in mind), and an explicit -S flag must sit
    // within a few lines of it, not just somewhere else in the file.
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
    //
    // allMjs, not [...files, "helpers.mjs"]: the same future-file gap the
    // kill-server check above closes applies here identically.
    for (const file of allMjs) {
      const source = sources.get(file);
      assert.ok(
        !/["']list-panes["']\s*,\s*["']-a["']/.test(source),
        `${file} must scope list-panes to its own session (-s -t =<name>), never -a`,
      );
    }
  });
});
