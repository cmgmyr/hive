import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { describeOpenCalls, installFakeOpen, openCallsFailed, readOpenCalls } from "../scripts/open-guard.mjs";
import { isolateTmux, REPO, runNode } from "./helpers.mjs";

const { hasTmux } = isolateTmux("todo 419: open-call guard tests");

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

    { skip: process.platform === "darwin" && hasTmux ? false : "darwin-only behaviour, needs tmux", timeout: 60_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "hive-open-guard-e2e-"));
      made.push(dir);
      const target = join(dir, "reproduces-the-escape.test.mjs");

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

      assert.doesNotMatch(out, /tmux leak check FAILED/, out);
    },
  );
});
