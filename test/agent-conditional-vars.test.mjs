import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { failureCount, isolateTmux, runCli, scratchDirs, warningCount } from "./helpers.mjs";

const { cleanup } = isolateTmux("the agent-conditional-vars tests");
after(() => cleanup());

function writeProfile(dataDir, name, files) {
  const dir = join(dataDir, "profiles", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
}

const CONDITIONAL = "before\n<!--if:agents_codex-->\ncodex-only\n<!--end-->\nafter\n";

describe("todo 597: agents_* conditional vars render through the real profile render path", () => {
  it("renders the codex-only block when agents: allows codex", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": CONDITIONAL,
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\nagents:\n  - claude\n  - codex\n");

    const out = await runCli(["runbook"], opts);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /codex-only/);
  });

  it("strips the codex-only block when hive.yml has no agents: key", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": CONDITIONAL,
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\n");

    const out = await runCli(["runbook"], opts);
    assert.equal(out.code, 0, out.stdout);
    assert.doesNotMatch(out.stdout, /codex-only/);
  });

  it("renders through hive posture too", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": CONDITIONAL,
      "runbook.md": "runbook\n",
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\nagents:\n  - codex\n");

    const out = await runCli(["posture"], opts);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /codex-only/);
  });

  it("renders through `hive profile read` on a fork-local extra file", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": "runbook\n",
      "extra.md": CONDITIONAL,
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\nagents:\n  - codex\n");

    const out = await runCli(["profile", "read", "extra.md"], opts);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /codex-only/);
  });
});

describe("todo 597: hive doctor stays quiet about derived agents_* vars", () => {
  it("says nothing about agents_codex when it renders", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": CONDITIONAL,
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\nagents:\n  - claude\n  - codex\n");
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);
    assert.doesNotMatch(out.stdout, /agents_codex/);
    assert.doesNotMatch(out.stdout, /agents_claude/);
  });

  it("says nothing about agents_codex when it strips, with no agents: key", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": CONDITIONAL,
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\n");
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const baseline = await runCli(["doctor"], opts);

    const out = await runCli(["doctor"], opts);
    assert.doesNotMatch(out.stdout, /agents_codex/);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
    assert.equal(warningCount(out.stdout), warningCount(baseline.stdout));
  });
});

describe("todo 597: hive doctor warns when a hive.yml var collides with a derived one", () => {
  it("warns that a hive.yml vars: entry named agents_codex is overridden by the derived value", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": "runbook\n",
    });
    writeFileSync(
      join(dirs.projectDir, "hive.yml"),
      "profile: agents-repro\nvars:\n  agents_codex: lying\n",
    );
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);
    assert.match(out.stdout, /warn {2}profile vars:.*agents_codex/);
    assert.ok(warningCount(out.stdout) >= 1, `expected at least one warning: ${out.stdout}`);
  });

  it("does not warn when no hive.yml var shares a name with a derived one", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeProfile(dirs.dataDir, "agents-repro", {
      "posture.md": "posture\n",
      "runbook.md": "runbook\n",
    });
    writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: agents-repro\nvars:\n  foo: bar\n");
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);

    const out = await runCli(["doctor"], opts);
    assert.doesNotMatch(out.stdout, /agents_codex/);
    assert.doesNotMatch(out.stdout, /agents_claude/);
  });
});
