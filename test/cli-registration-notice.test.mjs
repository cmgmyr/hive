import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// Todo 255. run()'s notice (src/result.ts, pinned by
// test/project-registration-notice.test.mjs) only covers the MCP tool layer.
// resolveProjectAndNotify (src/cli.ts) is the CLI's own equivalent - added in
// the same lane, but with no test behind it. The lead found the gap by
// mutation on the rebased head: deleting
// `if (notice) console.log(registrationNoticeText(notice));` left the suite
// fully green. This file is that missing test, driving the real built `hive`
// CLI (runCli, the same harness every other CLI test file uses - see
// test/profiles.test.mjs's `hive init`/`hive runbook` calls) rather than a
// helper, for the same reason test/project-registration-notice.test.mjs gives
// for the MCP half.

const { cleanup: cleanupTmux } = isolateTmux("the CLI registration-notice tests");
after(() => cleanupTmux());

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Anchored so the capture stops at end-of-line rather than swallowing later
// output, and scoped to a single captured line rather than testing the whole
// stream: `hive init` also prints "Project: name (path)" unconditionally
// (src/cli.ts's cmdInit), which already contains the project's path and
// would satisfy a path assertion made against the whole stream whether or
// not the notice exists at all. Matching only inside the notice's own
// captured line is what actually pins the notice, the same reasoning
// test/project-registration-notice.test.mjs applies by reading content[1]
// specifically instead of the whole content array.
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

    // The property this move exists for: `hive pad ... > out.md` from an
    // unregistered directory must not put the notice into the redirected
    // file. stdout still carries cmdInit's own "Project: ..." line, so this
    // checks specifically for the notice's own text, not stdout in general.
    assert.doesNotMatch(stdout, /hive: no registered project/, "the notice must not land on stdout");
  });

  it("a later command against the now-registered project prints no notice", async () => {
    const dirs = scratchDirs();
    const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    const init = await runCli(["init", "--no-profile"], cliOpts);
    assert.equal(init.code, 0, init.stderr);
    assert.match(init.stderr, NOTICE_LINE, "the registering call itself must still notify");

    // A fresh process, the way a real second CLI invocation would be -
    // resolveProjectAndNotify's flag is process-local, so this is the only
    // way to prove the SECOND call does not repeat it.
    const { code, stderr } = await runCli(["runbook"], cliOpts);
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /hive: no registered project/, "an already-registered cwd must not be announced again");
  });
});
