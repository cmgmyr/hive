import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("CLI unknown flag tests");
after(() => cleanupTmux());

const unknown = "--hive-unknown-test-flag";
const commands = [
  ["lead", "lead"],
  ["queen", "queen"],
  ["init", "init"],
  ["attach", "attach"],
  ["start", "start", "server"],
  ["stop", "stop", "server"],
  ["lead pane-exited hook", "lead-pane-exited", "%999"],
  ["lead-handoff", "lead-handoff"],
  ["lead-handoff-grace hook", "lead-handoff-grace"],
  ["lead-handoff-start hook", "lead-handoff-start"],
  ["show", "show", "server"],
  ["hide", "hide", "server"],
  ["status", "status"],
  ["portfolio", "portfolio"],
  ["crew", "crew"],
  ["queen-audit", "queen-audit"],
  ["next", "next"],
  ["setup", "setup"],
  ["upgrade", "upgrade"],
  ["doctor", "doctor"],
  ["pads", "pads"],
  ["pad", "pad", "missing"],
  ["todos", "todos"],
  ["todo", "todo", "1"],
  ["questions", "questions"],
  ["answer", "answer", "1", "yes"],
  ["backups", "backups"],
  ["restore", "restore", "missing"],
  ["project", "project", "rm", "1"],
  ["runbook", "runbook"],
  ["posture", "posture"],
  ["profile list", "profile", "list"],
  ["profile path", "profile", "path", "missing"],
  ["profile fork", "profile", "fork", "missing"],
  ["profile create", "profile", "create", "missing"],
  ["profile read", "profile", "read", "posture.md"],
  ["kickoff", "kickoff"],
  ["statusline", "statusline"],
  ["version", "--version"],
];

describe("hive CLI unknown flags", () => {
  for (const [label, ...args] of commands) {
    it(`${label} refuses an undeclared flag before producing command output`, async () => {
      const dirs = scratchDirs();
      const { code, stdout, stderr } = await runCli([...args, unknown], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
      });
      assert.equal(code, 1);
      assert.match(stderr, new RegExp(`unknown argument "${unknown}"`));
      assert.equal(stdout, "");
    });
  }

  it("todos keeps a dash-prefixed value after --tag as the tag value", async () => {
    const dirs = scratchDirs();
    const init = await runCli(["init"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
    });
    assert.equal(init.code, 0, init.stderr);
    const { code, stderr } = await runCli(["todos", "--tag", "-urgent"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
    });
    assert.equal(code, 0, stderr);
  });
  it("doctor refuses an unexpected positional argument", async () => {
    const dirs = scratchDirs();
    const { code, stdout, stderr } = await runCli(["doctor", "unexpected"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
    });
    assert.equal(code, 1);
    assert.match(stderr, /hive doctor: unknown argument "unexpected"/);
    assert.equal(stdout, "");
  });
  it("todos rejects an unknown single-dash flag with the shared refusal", async () => {
    const dirs = scratchDirs();
    const { code, stdout, stderr } = await runCli(["todos", "-x"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
    });
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "-x"\. Flags are --all, --status <status>, --tag <tag>\./);
    assert.equal(stdout, "");
  });

  it("lead-handoff names its declared flags in the shared refusal", async () => {
    const dirs = scratchDirs();
    const { code, stdout, stderr } = await runCli(["lead-handoff", unknown], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
    });
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--hive-unknown-test-flag"\. Flags are --request <id>, --pad <id>, --revision <n>\./);
    assert.equal(stdout, "");
  });

  it("lead-handoff reports a missing declared value as unexpected input", async () => {
    const dirs = scratchDirs();
    const { code, stdout, stderr } = await runCli(["lead-handoff", "--request"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
    });
    assert.equal(code, 1);
    assert.match(stderr, /unexpected argument "--request"/);
    assert.doesNotMatch(stderr, /unknown argument/);
    assert.equal(stdout, "");
  });
});
