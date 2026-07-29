import assert from "node:assert/strict";
import { readdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
const { cleanup: cleanupTmux } = isolateTmux("the CLI tests");
after(() => cleanupTmux());

// End to end through the built CLI: init seeds the runbook pad, then the
// pads/pad commands cover print, edit export, save, and conflict handling.
// HIVE_EDITOR=true (set in runCli) keeps any real editor from opening.
const dirs = scratchDirs();
const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

function exportPath() {
  const files = readdirSync(dirs.tmp).filter((f) => f.startsWith("hive-pad-"));
  assert.equal(files.length, 1, `expected one export, found: ${files.join(", ")}`);
  return join(dirs.tmp, files[0]);
}

describe("hive CLI pads", () => {
  before(async () => {
    const init = await runCli(["init"], cliOpts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("lists the seeded runbook and board", async () => {
    const { code, stdout } = await runCli(["pads"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /runbook\s+rev\s+1/);
    assert.match(stdout, /board\s+rev\s+1/);
  });

  it("prints pad content", async () => {
    const { code, stdout } = await runCli(["pad", "runbook"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /RUNBOOK/);
  });

  it("exports on --edit and refuses a second export", async () => {
    const edit = await runCli(["pad", "runbook", "--edit"], cliOpts);
    assert.equal(edit.code, 0, edit.stderr);
    const file = exportPath();
    assert.match(file, /\.r1\.md$/);
    assert.match(readFileSync(file, "utf8"), /RUNBOOK/);

    const second = await runCli(["pad", "runbook", "--edit"], cliOpts);
    assert.equal(second.code, 1);
    assert.match(second.stdout, /unsaved export already exists/);
  });

  it("saves edits back with a revision bump", async () => {
    appendFileSync(exportPath(), "\nEDITED BY TEST\n");
    const save = await runCli(["pad", "runbook", "--save"], cliOpts);
    assert.equal(save.code, 0, save.stdout);
    assert.match(save.stdout, /rev 1 -> 2/);

    const { stdout } = await runCli(["pad", "runbook"], cliOpts);
    assert.match(stdout, /EDITED BY TEST/);
    assert.equal(readdirSync(dirs.tmp).length, 0, "export should be cleaned up");
  });

  it("statusline reports counts inside a project and stays silent outside", async () => {
    const inside = await runCli(["statusline"], cliOpts);
    assert.equal(inside.code, 0);
    assert.match(inside.stdout, /hive:/);
    assert.match(inside.stdout, /2 pads/);

    const outside = await runCli(["statusline"], { ...cliOpts, cwd: dirs.tmp });
    assert.equal(outside.code, 0);
    assert.equal(outside.stdout, "");
  });

  it("statusline stays silent in a registered project with no live state", async () => {
    // A single tool call is enough to register a directory as a project.
    const emptyDir = dirs.tmp;
    const mcp = new McpClient({ cwd: emptyDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      const who = await mcp.call("whoami");
      assert.equal(who.project.path, emptyDir);
    } finally {
      await mcp.close();
    }

    const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd: emptyDir });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  });

  it("fails cleanly when the pad changed since the export", async () => {
    const edit = await runCli(["pad", "runbook", "--edit"], cliOpts);
    assert.equal(edit.code, 0);
    const file = exportPath();

    // A concurrent session bumps the pad while the human edits.
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      const pad = await mcp.call("pad_read", { name: "runbook" });
      await mcp.call("pad_append", {
        pad_id: pad.pad_id,
        content: "concurrent change",
        expected_revision: pad.revision,
      });
    } finally {
      await mcp.close();
    }

    appendFileSync(file, "\nhuman edit\n");
    const save = await runCli(["pad", "runbook", "--save"], cliOpts);
    assert.equal(save.code, 1);
    assert.match(save.stdout, /Revision mismatch/);
    assert.match(readFileSync(file, "utf8"), /human edit/, "edits must survive a failed save");
  });
});
