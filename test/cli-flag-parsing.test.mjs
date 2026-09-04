import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("CLI flag parsing tests");
after(() => cleanupTmux());

function opts() {
  const dirs = scratchDirs();
  return { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
}

describe("hive CLI shared flag parser", () => {
  it("hive setup rejects a mistyped flag naming it and setup's real flags", async () => {
    const { code, stdout, stderr } = await runCli(["setup", "--forc"], opts());
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--forc"\. Flags are --dir, --attach, --auto-attach, --force\./);
    assert.equal(stdout, "", "a refused run must not print a report a script could read as a result");
  });

  it("hive init rejects a mistyped flag instead of silently dropping it", async () => {
    const { code, stdout, stderr } = await runCli(["init", "--profil", "orchestration"], opts());
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--profil"\. Flags are --profile <name> and --no-profile\./);
    assert.equal(stdout, "", "a refused run must not create hive.yml or pads");
  });

  it("hive restore rejects a mistyped flag instead of silently ignoring it", async () => {
    const { code, stdout, stderr } = await runCli(["restore", "some-snapshot", "--forec"], opts());
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--forec"\. Flags are --yes\/-y and --force\./);
    assert.equal(stdout, "", "a refused run must not preview or perform a restore");
  });

  it("hive start rejects a flag instead of silently treating it as a path", async () => {
    const { code, stdout, stderr } = await runCli(["start", "web", "--foo"], opts());
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--foo"\. Flags are none\./);
    assert.equal(stdout, "", "a refused run must not try to resolve --foo as a project path");
  });

  it("hive pad rejects a mistyped flag instead of printing the pad by falling through", async () => {
    const dirs = scratchDirs();
    const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init"], cliOpts);
    assert.equal(init.code, 0, init.stderr);

    const { code, stdout, stderr } = await runCli(["pad", "runbook", "--edti"], cliOpts);
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--edti"\. Flags are --edit and --save\./);
    assert.equal(stdout, "", "a refused run must not fall through to printing the pad's content");
  });

  it("hive profile read rejects a mistyped flag instead of silently ignoring it", async () => {
    const { code, stdout, stderr } = await runCli(
      ["profile", "read", "posture.md", "--profil", "orchestration"],
      opts(),
    );
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--profil"\. Flags are --profile <name>\./);
    assert.equal(stdout, "", "a refused run must not render a profile file");
  });

  it("hive setup refuses to let --dir silently swallow --force as its value", async () => {
    const dirs = scratchDirs();
    const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const { code, stdout, stderr } = await runCli(["setup", "--dir", "--force"], cliOpts);
    assert.equal(code, 1);
    assert.match(stderr, /--dir requires a value \(got --force\)/);
    assert.equal(stdout, "", "a refused run must not write a dispatcher anywhere");
    assert.ok(
      !existsSync(join(dirs.projectDir, "--force")),
      "must not have silently created a literal --force directory by treating it as --dir's value",
    );
  });

  it("hive pad -- runbook treats -- as an end-of-flags separator, not an unknown flag", async () => {
    const dirs = scratchDirs();
    const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init"], cliOpts);
    assert.equal(init.code, 0, init.stderr);

    const { code, stdout } = await runCli(["pad", "--", "runbook"], cliOpts);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /RUNBOOK/);
  });
});
