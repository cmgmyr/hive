import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { describeOpenCalls, installFakeOpen, openCallsFailed, readOpenCalls } from "../scripts/open-guard.mjs";
import { isolateTmux, REPO, runNode } from "./helpers.mjs";

// isolateTmux() ABOVE the explanatory comment below, deliberately: this
// suite's own isolation scan (test/suite-isolation.test.mjs) fails a file
// where any earlier LINE - comment or not - matches a spawn pattern, and this
// file's own comment two paragraphs down has to describe the very call it
// mentions.
const { hasTmux } = isolateTmux("todo 419: open-call guard tests");

// Todo 419. This is the whole lane, not a nice-to-have alongside it: without
// a test that reproduces the actual escape, the next worktree run goes green
// for the wrong reason - exactly what happened here (todo 419 comment 1106
// recorded zero calls on the same code that produced three real windows in
// the main checkout, because a fresh worktree had neither precondition the
// escape needs).
//
// TWO PRECONDITIONS, PROVEN TOGETHER. scripts/open-guard.mjs's own header
// names them: a dashboard FILE already at the resolved project path, and a
// scratch kv store carrying no `hive:dashboard_opened` marker (true by
// construction for a fresh scratch store). Building both directly below,
// rather than relying on either checkout's ambient state, is what makes this
// reproducible on any machine - a worktree, the main checkout, or CI.
//
// isolateTmux() above is needed even though this file's own process never
// touches tmux directly: the e2e case below spawns the wrapper through
// runNode, and the same suite-isolation scan treats every runCli/runNode
// occurrence as tmux-reaching regardless of what the spawned process
// actually does - including the ones embedded inside this file's own
// template-string fixture. Matches the identical pattern in
// test/tmux-leak-check.test.mjs, whose target-script strings have the same
// property.

describe("scripts/open-guard.mjs: parsing", () => {
  it("reads zero calls from an empty log", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-open-guard-test-"));
    const log = join(dir, "calls.log");
    writeFileSync(log, "");
    assert.deepEqual(readOpenCalls(log), []);
    assert.equal(openCallsFailed(readOpenCalls(log)), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a call's multi-line ancestry attached to it, and counts calls by their '---' terminator, not by ARGS lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-open-guard-test-"));
    const log = join(dir, "calls.log");
    writeFileSync(
      log,
      "ARGS: file:///a/index.html\n" +
        "CWD: /a\n" +
        "ANCESTOR[0] pid=1 cmd=node test/one.test.mjs\n" +
        "---\n" +
        "ARGS: file:///b/index.html\n" +
        "CWD: /b\n" +
        "ANCESTOR[0] pid=2 cmd=node test/two.test.mjs\n" +
        "---\n",
    );
    const calls = readOpenCalls(log);
    assert.equal(calls.length, 2, "two '---'-terminated blocks must read as two calls");
    assert.match(calls[0], /file:\/\/\/a\/index\.html/);
    assert.match(calls[0], /test\/one\.test\.mjs/);
    assert.match(calls[1], /file:\/\/\/b\/index\.html/);
    assert.match(calls[1], /test\/two\.test\.mjs/);
    assert.equal(openCallsFailed(calls), true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("describeOpenCalls names the count and attributes it to todo 419, only when calls exist", () => {
    assert.deepEqual(describeOpenCalls([]), ["no `open` calls reached the suite-wide fake"]);
    const lines = describeOpenCalls(["ARGS: file:///x/index.html\nCWD: /x"]);
    assert.match(lines[0], /1 `open` call\(s\).*todo 419/);
    assert.ok(lines.some((l) => l.includes("ARGS: file:///x/index.html")));
  });

  it("installFakeOpen's own generated bin writes a log readOpenCalls can parse - the round trip between the two halves of this module", () => {
    const fakeOpen = installFakeOpen();
    try {
      execFileSync(join(fakeOpen.bin, "open"), ["file:///round-trip/index.html"], { stdio: "ignore" });
      const calls = readOpenCalls(fakeOpen.log);
      assert.equal(calls.length, 1, `expected exactly one recorded call, got: ${JSON.stringify(calls)}`);
      assert.match(calls[0], /ARGS: file:\/\/\/round-trip\/index\.html/);
      assert.match(calls[0], /^CWD: /m);
      assert.match(calls[0], /^ANCESTOR\[0\]/m, "the ancestry walk must have recorded at least its own parent");
    } finally {
      fakeOpen.reap();
    }
  });
});

describe("the run-level open-call check", () => {
  const made = [];
  after(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "fails a real `npm test` run when a dashboard-enabled project with an existing dashboard file and a fresh scratch store reaches `hive lead` with no local fake and no --no-dashboard",
    // it-level skip, not describe-level: a skipped describe's nested tests
    // are invisible to node --test's own summary tally (measured - a
    // describe-level skip wrapping this one test reported `skipped 0`,
    // where an it-level skip on the identical test reports `skipped 1`),
    // and .github/workflows/ci.yml's skip-budget gate parses exactly that
    // summary line. A skip nobody can see counted is worse than the wrong
    // count - it defeats the gate rather than tripping it.
    { skip: process.platform === "darwin" && hasTmux ? false : "darwin-only behaviour, needs tmux", timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "hive-open-guard-e2e-"));
      made.push(dir);
      const target = join(dir, "reproduces-the-escape.test.mjs");
      // Deliberately the SAME shape as test/dashboard-open-lead.test.mjs's
      // own fixture setup, minus that file's local fake-open bin on PATH:
      // exactly what test/restart-lead.test.mjs's REPO-registered lead
      // spawn looked like before it was fixed with --no-dashboard (todo
      // 419). PATH is left ambient on purpose - under the wrapper this
      // test spawns below, that PATH already carries the WRAPPER's own
      // suite-wide fake, which is precisely the mechanism under test.
      writeFileSync(
        target,
        `import { mkdirSync, writeFileSync } from "node:fs";\n` +
          `import { dirname, join } from "node:path";\n` +
          `import { test } from "node:test";\n` +
          `import { assertScratchStore, isolateTmux, makeFakeClaude, runCli, scratchDirs } from ${JSON.stringify(join(REPO, "test", "helpers.mjs"))};\n` +
          `isolateTmux("todo 419 e2e reproduction");\n` +
          `const dirs = scratchDirs();\n` +
          `process.env.HIVE_DATA_DIR = dirs.dataDir;\n` +
          `await assertScratchStore();\n` +
          `const claudePath = makeFakeClaude(dirs.tmp)("sleep 600");\n` +
          `test("reproduces todo 419's two preconditions and reaches real hive lead", async () => {\n` +
          `  writeFileSync(join(dirs.projectDir, "hive.yml"), "dashboard: true\\n");\n` +
          `  const dashDir = join(dirs.projectDir, ".claude", "dashboard");\n` +
          `  mkdirSync(dashDir, { recursive: true });\n` +
          `  writeFileSync(join(dashDir, "index.html"), "<html>todo 419 e2e fixture</html>");\n` +
          `  const init = await runCli(["init"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });\n` +
          `  if (init.code !== 0) throw new Error("init failed: " + init.stderr);\n` +
          `  const led = await runCli(["lead"], {\n` +
          `    cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp,\n` +
          `    env: { PATH: dirname(claudePath) + ":" + process.env.PATH, TERM_PROGRAM: "" },\n` +
          `  });\n` +
          `  if (led.code !== 0) throw new Error("hive lead failed: " + led.stderr);\n` +
          `});\n`,
      );

      const wrapper = await runNode(join(REPO, "scripts", "run-tests.mjs"), [target], {
        cwd: REPO,
        env: { NODE_TEST_CONTEXT: undefined },
      });
      const out = wrapper.stdout + wrapper.stderr;
      assert.notEqual(wrapper.code, 0, `a reproduced escape must fail the run:\n${out}`);
      assert.match(out, /open-call check FAILED/, out);
      assert.match(
        out,
        /ARGS: file:\/\/.*\.claude\/dashboard\/index\.html/,
        `must name the real resolved dashboard file, not a placeholder:\n${out}`,
      );
      // The tmux leak check must not be the thing that failed this run - a
      // false attribution here would say the open-call guard works when it
      // was actually the sibling check doing the failing.
      assert.doesNotMatch(out, /tmux leak check FAILED/, out);
    },
  );
});
