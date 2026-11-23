import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync, chmodSync, existsSync, unlinkSync, statSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { CLI, McpClient, baseEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the CLI tests");
after(() => cleanupTmux());

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

  it("says nothing about held wakes when none are held", async () => {
    const { code, stdout } = await runCli(["statusline"], cliOpts);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /held/, "no wake is held yet, so the segment must not appear");
  });

  it("does not count the lead's own row as an agent", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {
      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'lead:902', 'lead', '%4', 'claude', ?, 'lead', 'running')`,
        )
        .run(projectId, dirs.projectDir);
    } finally {
      store.close();
    }

    const { code, stdout } = await runCli(["statusline"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /0 agents/, "a running lead row must not inflate the agent count");
  });

  it("names the count, the oldest hold's age, and its reason in the held-wake segment", async () => {
    const HELD_REASON_UNSUBMITTED_INPUT =
      "the pane's input box has unsubmitted human text; delivering now would paste the wake body onto it " +
      "and submit both as one message";
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {
      store
        .prepare(
          `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at,
             held_at, held_reason, first_held_at)
           VALUES (?, 'agent:1', 'go on', 'delay', 'agent:1', '%1', datetime('now', '-60 seconds'),
             datetime('now', '-54 seconds'), ?, datetime('now', '-3240 seconds'))`,
        )
        .run(projectId, HELD_REASON_UNSUBMITTED_INPUT);
    } finally {
      store.close();
    }

    const { code, stdout } = await runCli(["statusline"], cliOpts);
    assert.equal(code, 0);
    assert.match(stdout, /1 held \(54m, typing\)/, "the count, the oldest hold's age, and its reason word");
  });

  async function freshHeldProject(dirName) {
    const cwd = join(dirs.tmp, dirName);
    mkdirSync(cwd, { recursive: true });
    const mcp = new McpClient({ cwd, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();
    return { cwd, projectId };
  }

  // firstHeldAtExpr is raw SQL (a datetime(...) expression or the literal NULL), interpolated
  // directly: it must be evaluated by SQLite, not bound as text.
  function seedHeldTimer(projectId, { reason, firstHeldAtExpr }) {
    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {
      store
        .prepare(
          `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at,
             held_at, held_reason, first_held_at)
           VALUES (?, 'agent:1', 'go on', 'delay', 'agent:1', '%1', datetime('now', '-60 seconds'),
             datetime('now', '-1 seconds'), ?, ${firstHeldAtExpr})`,
        )
        .run(projectId, reason);
    } finally {
      store.close();
    }
  }

  const HELD_REASON_UNSUBMITTED_INPUT =
    "the pane's input box has unsubmitted human text; delivering now would paste the wake body onto it " +
    "and submit both as one message";
  const HELD_REASON_OTHER = "the lead's pane is not live right now (likely mid-restart)";

  it("does not pluralise 'held': two held wakes read '2 held', not '2 helds'", async () => {
    const { cwd, projectId } = await freshHeldProject("held-plural");
    seedHeldTimer(projectId, { reason: HELD_REASON_UNSUBMITTED_INPUT, firstHeldAtExpr: "datetime('now', '-60 seconds')" });
    seedHeldTimer(projectId, { reason: HELD_REASON_UNSUBMITTED_INPUT, firstHeldAtExpr: "datetime('now', '-120 seconds')" });

    const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd });
    assert.equal(code, 0);
    assert.match(stdout, /2 held \(/, "'held' names a state, not a countable noun");
    assert.doesNotMatch(stdout, /helds/, "must never pluralise 'held'");
  });

  it("does not let a hold with no first_held_at (a pre-409 row) win the age query and hide a real one", async () => {
    const { cwd, projectId } = await freshHeldProject("held-null-first-held-at");
    seedHeldTimer(projectId, { reason: HELD_REASON_OTHER, firstHeldAtExpr: "NULL" });
    seedHeldTimer(projectId, { reason: HELD_REASON_OTHER, firstHeldAtExpr: "datetime('now', '-240 seconds')" });

    const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd });
    assert.equal(code, 0);
    assert.match(
      stdout,
      /2 held \(4m, blocked\)/,
      "the row with a real first_held_at must win the age, not the NULL row sorting first",
    );
  });

  it("shows the typing hold's own reason and age even when an older non-typing hold exists (todo 320)", async () => {
    const { cwd, projectId } = await freshHeldProject("held-typing-priority");
    seedHeldTimer(projectId, { reason: HELD_REASON_OTHER, firstHeldAtExpr: "datetime('now', '-5700 seconds')" });
    seedHeldTimer(projectId, { reason: HELD_REASON_UNSUBMITTED_INPUT, firstHeldAtExpr: "datetime('now', '-240 seconds')" });

    const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd });
    assert.equal(code, 0);
    assert.match(
      stdout,
      /2 held \(4m, typing\)/,
      "a typing hold must win the reason and supply its own age, not the older blocked hold's",
    );
  });

  it("gives a hold that never clears on its own its own reason word, not 'blocked'", async () => {
    const HELD_REASON_LEAD_PANE_DEAD =
      "the lead's pane is not live right now (likely mid-restart); lead-owned wakes are exempt from " +
      "cancellation for this alone, so it is held rather than lost";
    const { cwd, projectId } = await freshHeldProject("held-needs-you");
    seedHeldTimer(projectId, { reason: HELD_REASON_LEAD_PANE_DEAD, firstHeldAtExpr: "datetime('now', '-60 seconds')" });

    const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd });
    assert.equal(code, 0);
    assert.match(
      stdout,
      /1 held \(1m, needs you\)/,
      "a hold nothing clears automatically must read 'needs you', not the generic 'blocked'",
    );
  });

  for (const [kind, reason] of [
    [
      "an unverifiable-ownership hold",
      "pane ownership for this wake's row cannot be verified (no pane pid was recorded for it, its row now " +
        "records a different pane, or the pane is on another tmux socket); held rather than typed into a pane " +
        "that may not be its own - run `hive lead` to start or adopt a lead with a recorded pane and re-point it",
    ],
    [
      "a closed-lead-row hold",
      "the lead's row is closed, so no pane is this wake's to type into; held until `hive lead` starts or adopts a " +
        "lead and re-points it",
    ],
  ]) {
    it(`labels ${kind} 'needs you', since only hive lead or wake_cancel clears it`, async () => {
      const { cwd, projectId } = await freshHeldProject(`held-${kind.split(" ")[1]}`);
      seedHeldTimer(projectId, { reason, firstHeldAtExpr: "datetime('now', '-60 seconds')" });

      const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd });
      assert.equal(code, 0);
      assert.match(stdout, /1 held \(1m, needs you\)/);
    });
  }

  it("gives todo 455's conversation hold its own reason word, not 'blocked'", async () => {
    const HELD_REASON_CONVERSATION =
      "a human talked to this lead more recently than the conversation-hold window; holding so a wake " +
      "does not split an in-progress discussion - it delivers once the window passes or the hold's own " +
      "ceiling is reached, whichever comes first";
    const { cwd, projectId } = await freshHeldProject("held-talking");
    seedHeldTimer(projectId, { reason: HELD_REASON_CONVERSATION, firstHeldAtExpr: "datetime('now', '-120 seconds')" });

    const { code, stdout } = await runCli(["statusline"], { ...cliOpts, cwd });
    assert.equal(code, 0);
    assert.match(
      stdout,
      /1 held \(2m, talking\)/,
      "a hold on a human conversation must read 'talking', not the generic 'blocked'",
    );
  });

  it("statusline stays silent in a registered project with no live state", async () => {

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

  it("pad --export writes the revision-stamped file and opens no editor", async () => {
    const editor = join(dirs.tmp, "editor-must-not-run");
    const sentinel = join(dirs.tmp, "editor-was-run");
    writeFileSync(editor, `#!/bin/sh\ntouch '${sentinel}'\n`);
    chmodSync(editor, 0o700);

    const result = await runCli(["pad", "board", "--export"], { ...cliOpts, env: { HIVE_EDITOR: editor } });
    assert.equal(result.code, 0, result.stderr);
    const file = result.stdout.trim().split("\n")[0];
    assert.match(file, new RegExp(`/hive-pad-\\d+-board\\.r\\d+\\.md$`));
    assert.equal(readFileSync(file, "utf8").includes("BOARD"), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    for (let attempt = 0; attempt < 25 && !existsSync(sentinel); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(sentinel), false, "export must not start HIVE_EDITOR");
    unlinkSync(file);
    unlinkSync(editor);
  });

  it("pad --export refuses when an unsaved export exists", async () => {
    const first = await runCli(["pad", "board", "--export"], cliOpts);
    assert.equal(first.code, 0);
    const file = first.stdout.trim().split("\n")[0];
    const second = await runCli(["pad", "board", "--export"], cliOpts);
    assert.equal(second.code, 1);
    assert.match(second.stdout, /unsaved export already exists/);
    unlinkSync(file);
  });

  it("pad --save --revision guards a file with no marker", async () => {
    const file = join(dirs.tmp, "plain-board.md");
    writeFileSync(file, "BOARD\nplain edit\n");
    const save = await runCli(["pad", "board", "--save", file, "--revision", "1"], cliOpts);
    assert.equal(save.code, 0, save.stdout);
    assert.match(save.stdout, /rev 1 -> 2/);
  });

  it("pad --save --revision overrides the filename marker", async () => {
    const file = join(dirs.tmp, "marked-board.r99.md");
    writeFileSync(file, "BOARD\nexplicit revision edit\n");
    const save = await runCli(["pad", "board", "--save", file, "--revision", "2"], cliOpts);
    assert.equal(save.code, 0, save.stdout);
    assert.match(save.stdout, /rev 2 -> 3/);
  });

  it("pad --save refuses an unmarked file without --revision", async () => {
    const file = join(dirs.tmp, "unmarked board.md");
    writeFileSync(file, "BOARD\nunsaved edit\n");
    const save = await runCli(["pad", "board", "--save", file], cliOpts);
    assert.equal(save.code, 1);
    assert.match(save.stdout, /no revision marker/);
    assert.match(save.stdout, /Current revision is 3/);
    assert.ok(save.stdout.includes(`hive pad "board" --save '${file}' --revision 3`));
    assert.equal(readFileSync(file, "utf8"), "BOARD\nunsaved edit\n");

    const retry = await runCli(["pad", "board", "--save", file, "--revision", "3"], cliOpts);
    assert.equal(retry.code, 0, retry.stdout);
    assert.match(retry.stdout, /rev 3 -> 4/);
    const pad = await runCli(["pad", "board"], cliOpts);
    assert.match(pad.stdout, /unsaved edit/);
  });

  it("pad --save rejects a non-integer --revision before reading the file", async () => {
    const save = await runCli(["pad", "board", "--save", join(dirs.tmp, "missing.md"), "--revision", "1.5"], cliOpts);
    assert.equal(save.code, 1);
    assert.match(save.stdout, /--revision must be a positive integer/);
    assert.doesNotMatch(save.stdout, /ENOENT/);
  });

  it("pad --save --revision stale refuses and keeps the file", async () => {
    const file = join(dirs.tmp, "stale-board.md");
    writeFileSync(file, "BOARD\nstale edit\n");
    const save = await runCli(["pad", "board", "--save", file, "--revision", "1"], cliOpts);
    assert.equal(save.code, 1);
    assert.match(save.stdout, /Revision mismatch/);
    assert.equal(readFileSync(file, "utf8"), "BOARD\nstale edit\n");
    unlinkSync(file);
  });

  it("pad --save keeps a user file it did not export", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    let pad;
    try {
      pad = await mcp.call("pad_read", { name: "board" });
    } finally {
      await mcp.close();
    }

    const file = join(dirs.tmp, "plain.md");
    const content = `${pad.content}\nUSER FILE EDIT\n`;
    writeFileSync(file, content);
    const save = await runCli(["pad", "board", "--save", file, "--revision", String(pad.revision)], cliOpts);
    assert.equal(save.code, 0, save.stdout);
    assert.match(save.stdout, /\(kept /);
    assert.equal(readFileSync(file, "utf8"), content);

    const noChanges = await runCli(["pad", "board", "--save", file, "--revision", String(pad.revision + 1)], cliOpts);
    assert.equal(noChanges.code, 0, noChanges.stdout);
    assert.match(noChanges.stdout, /No changes/);
    assert.match(noChanges.stdout, /\(kept /);
    assert.equal(readFileSync(file, "utf8"), content);
    const updated = await runCli(["pad", "board"], cliOpts);
    assert.match(updated.stdout, /USER FILE EDIT/);
  });

  it("pad --save prints a current revision after an interleaved write", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    let child;
    let writer;
    let fifo;
    try {
      const pad = await mcp.call("pad_read", { name: "board" });
      fifo = join(dirs.tmp, "blocked save.pipe");
      execFileSync("mkfifo", [fifo]);
      child = spawn(process.execPath, [CLI, "pad", "board", "--save", fifo, "--revision", String(pad.revision)], {
        cwd: dirs.projectDir,
        env: { ...baseEnv(), HIVE_DATA_DIR: dirs.dataDir, HIVE_AUTO_ATTACH: "0", HIVE_EDITOR: "true", TMPDIR: dirs.tmp },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const closed = once(child, "close");
      writer = createWriteStream(fifo);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI did not open the save FIFO")), 3000);
        writer.once("open", () => { clearTimeout(timer); resolve(); });
        writer.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      await mcp.call("pad_append", { pad_id: pad.pad_id, content: "concurrent writer", expected_revision: pad.revision });
      writer.end(`${pad.content}\nCLI edit\n`);
      const [code] = await closed;
      assert.equal(code, 1, stderr);
      assert.match(stdout, /Revision mismatch/);
      assert.ok(stdout.includes(`Then merge into the file and save with: hive pad "board" --save '${fifo}' --revision ${pad.revision + 1}`), stdout);
      unlinkSync(fifo);
    } finally {
      writer?.destroy();
      if (child && child.exitCode === null) child.kill("SIGTERM");
      await mcp.close();
    }
  });

  it("pad refuses --export combined with --edit or --save", async () => {
    for (const mode of ["--edit", "--save"]) {
      const result = await runCli(["pad", "board", "--export", mode], cliOpts);
      assert.equal(result.code, 1, mode);
      assert.match(result.stdout, /Choose only one/);
    }
    assert.equal(readdirSync(dirs.tmp).filter((file) => /^hive-pad-\d+-board\.r/.test(file)).length, 0);
  });
});
