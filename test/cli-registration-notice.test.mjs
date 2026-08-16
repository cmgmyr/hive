import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the CLI registration-notice tests");
after(() => cleanupTmux());

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NOTICE_LINE = /^hive: no registered project matched this session's working directory, so it created project \d+.*$/m;

describe("the CLI half of the registration notice", () => {
  it("hive init on a cwd no project covers prints the notice on stderr, not stdout", async () => {
    const dirs = scratchDirs();
    const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    const { code, stdout, stderr } = await runCli(["init", "--no-profile"], cliOpts);
    assert.equal(code, 0, stderr);

    const match = stderr.match(NOTICE_LINE);
    assert.ok(match, `expected the registration notice on stderr, got: ${stderr}`);
    const notice = match[0];
    assert.match(notice, new RegExp(escapeRegex(dirs.projectDir)), "notice must name the created project's path");
    assert.match(notice, /project_prune|project_select/, "notice must name a remedy");

    assert.doesNotMatch(stdout, /hive: no registered project/, "the notice must not land on stdout");
  });

  it("a later command against the now-registered project prints no notice", async () => {
    const dirs = scratchDirs();
    const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    const init = await runCli(["init", "--no-profile"], cliOpts);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stderr, NOTICE_LINE, "the registering call itself must still notify");

    const { code, stderr } = await runCli(["runbook"], cliOpts);
    assert.equal(code, 0, stderr);

    assert.doesNotMatch(stderr, /hive: no registered project/, "an already-registered cwd must not be announced again");
  });
});
