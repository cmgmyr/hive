import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, leadRow, makeFakeClaude, makeFakeOpen, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("dashboard auto-open via hive lead (todo 356)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const MARKER_KEY = "hive:dashboard_opened";
const fakeOpen = makeFakeOpen(dirs.tmp);

const runnable = process.platform === "darwin" && hasTmux;

describe(
  "hive / hive lead opens the dashboard; --no-dashboard suppresses it",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude("sleep 600");
    const session = sessionName();
    const cliOpts = {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${dirname(claudePath)}:${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
    };
    let project;

    before(async () => {
      writeFileSync(join(dirs.projectDir, "hive.yml"), "dashboard: true\n");
      const dashDir = join(dirs.projectDir, ".claude", "dashboard");
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(join(dashDir, "index.html"), "<html></html>");
      const init = await runCli(["init"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(init.code, 0, init.stderr);
      project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir);
    });

    after(() => cleanup(session));

    it(
      "--no-dashboard suppresses the open on a `hive lead` invocation - scripts/restart-lead.sh's own case",
      { skip: runnable ? false : "darwin-only behaviour" },
      async () => {
        const led = await runCli(["lead", "--no-dashboard"], cliOpts);
        assert.equal(led.code, 0, led.stderr);
        assert.deepEqual(fakeOpen.calls(), [], "--no-dashboard must suppress the open entirely");
        assert.equal(
          db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(project.id, MARKER_KEY),
          undefined,
          "a suppressed open must not leave a marker behind either",
        );
      },
    );

    it(
      "bare `hive lead`, with no flag, opens the dashboard - the trigger the todo actually asked for",
      { skip: runnable ? false : "darwin-only behaviour" },
      async () => {
        const led = await runCli(["lead"], cliOpts);
        assert.equal(led.code, 0, led.stderr);
        const calls = fakeOpen.calls();
        assert.equal(calls.length, 1, `expected exactly one open call, got ${JSON.stringify(calls)}`);
        assert.match(calls[0], /^file:\/\/.*index\.html$/);
        assert.ok(
          db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(project.id, MARKER_KEY),
          "a successful open must leave a marker",
        );
      },
    );

    it(
      "a second `hive lead` right after, marker still live, does not reopen - regardless of the flag",
      { skip: runnable ? false : "darwin-only behaviour" },
      async () => {
        const led = await runCli(["lead"], cliOpts);
        assert.equal(led.code, 0, led.stderr);
        assert.equal(fakeOpen.calls().length, 1, "the marker from the previous case must suppress this open too");
      },
    );
  },
);

describe("bare `hive` (no subcommand) reaches the same dashboard-open path as `hive lead`", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const dirs2 = scratchDirs();
  const fakeClaude = makeFakeClaude(dirs2.tmp);
  const claudePath = fakeClaude("sleep 600");
  const session = sessionName();
  let project2;

  before(async () => {
    writeFileSync(join(dirs2.projectDir, "hive.yml"), "dashboard: true\n");
    const dashDir = join(dirs2.projectDir, ".claude", "dashboard");
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, "index.html"), "<html></html>");
    const init = await runCli(["init"], { cwd: dirs2.projectDir, dataDir: dirs.dataDir, tmp: dirs2.tmp });
    assert.equal(init.code, 0, init.stderr);
    project2 = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs2.projectDir);
  });

  after(() => cleanup(session));

  it(
    "no arguments at all still dispatches to cmdLead and opens the dashboard - this is the literal `args[0] ?? \"lead\"` default this fix relies on",
    { skip: runnable ? false : "darwin-only behaviour" },
    async () => {
      fakeOpen.reset();
      const attached = await runCli([], {
        cwd: dirs2.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs2.tmp,
        env: { PATH: `${dirname(claudePath)}:${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.equal(fakeOpen.calls().length, 1, "bare `hive` with no arguments must open the dashboard exactly once");
      assert.ok(db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(project2.id, MARKER_KEY));
    },
  );
});

describe("--no-dashboard argument-parsing edge cases (todo 356, counselors delta round)", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const dirs3 = scratchDirs();
  const fakeClaude = makeFakeClaude(dirs3.tmp);
  const claudePath = fakeClaude("sleep 600");
  const session = sessionName();
  let project3;

  before(async () => {
    writeFileSync(join(dirs3.projectDir, "hive.yml"), "dashboard: true\n");
    const dashDir = join(dirs3.projectDir, ".claude", "dashboard");
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, "index.html"), "<html></html>");
    const init = await runCli(["init"], { cwd: dirs3.projectDir, dataDir: dirs.dataDir, tmp: dirs3.tmp });
    assert.equal(init.code, 0, init.stderr);
    project3 = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs3.projectDir);
  });

  after(() => cleanup(session));

  it(
    "`hive --no-dashboard` (the flag with no explicit \"lead\" word, the form the usage text documents) reaches cmdLead rather than exiting via usage()",
    { skip: runnable ? false : "darwin-only behaviour" },
    async () => {
      fakeOpen.reset();
      const led = await runCli(["--no-dashboard"], {
        cwd: dirs3.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs3.tmp,
        env: { PATH: `${dirname(claudePath)}:${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(led.code, 0, led.stderr);
      assert.ok(leadRow(db, project3.id), "must have actually started a lead, not exited via usage()");
      assert.deepEqual(fakeOpen.calls(), [], "the flag must still suppress the open once cmdLead is reached");
    },
  );

  it("a misspelled --no-dashboard is REJECTED, not silently ignored", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
    fakeOpen.reset();
    const led = await runCli(["lead", "--no-dashbaord"], {
      cwd: dirs3.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs3.tmp,
      env: { PATH: `${dirname(claudePath)}:${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
    });
    assert.notEqual(led.code, 0, "a misspelled flag must not exit 0");
    assert.match(led.stderr, /unknown flag/);

    assert.deepEqual(fakeOpen.calls(), [], "a rejected invocation must never reach the point of opening anything");
  });

  it("`hive attach --no-dashboard` is rejected with a clear error, not a raw ENOENT from chdir", async () => {
    const attached = await runCli(["attach", "--no-dashboard"], {
      cwd: dirs3.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs3.tmp,
    });
    assert.notEqual(attached.code, 0, "an unknown flag to hive attach must not exit 0");
    assert.match(attached.stderr, /unknown flag/);
    assert.doesNotMatch(attached.stderr, /ENOENT/, "must be a clean rejection, not a raw filesystem error");
  });
});
