import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, makeFakeOpen, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("dashboard auto-open (todo 356)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const MARKER_KEY = "hive:dashboard_opened";
const fakeOpen = makeFakeOpen(dirs.tmp);

function writeYml(dir, body) {
  writeFileSync(join(dir, "hive.yml"), body);
}

function marker(projectId) {
  return db.prepare("SELECT value, expires_at FROM kv WHERE project_id = ? AND key = ?").get(projectId, MARKER_KEY);
}

const runnable = process.platform === "darwin" && hasTmux;

describe(
  "cmdAttach opens the dashboard (todo 356)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = sessionName();
    let project;

    before(async () => {
      writeYml(dirs.projectDir, "dashboard: true\n");
      const init = await runCli(["init"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(init.code, 0, init.stderr);
      project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir);
    });

    after(() => cleanup(session));

    it("refuses quietly when the dashboard file does not exist yet", async () => {
      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.deepEqual(fakeOpen.calls(), [], "no dashboard file on a cold project must not call open");
      assert.equal(marker(project.id), undefined, "no marker should be written when nothing was opened");
    });

    it("does not open a checked-in dashboard reached through a symlink escaping the project root", { skip: runnable ? false : "darwin-only behaviour" }, async () => {

      const outside = join(dirs.tmp, "outside-project");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "dashboard.html"), "<html>not the real dashboard</html>");
      symlinkSync(outside, join(dirs.projectDir, ".hive"));

      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.deepEqual(fakeOpen.calls(), [], "a dashboard dir symlinked outside the project root must never be opened");
      assert.equal(marker(project.id), undefined, "a refused open must not leave a marker behind");

      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(dirs.projectDir, ".hive"));
    });

    it("does not open a checked-in dashboard.html that is ITSELF a symlink escaping the project root, inside an otherwise-real, contained .hive", { skip: runnable ? false : "darwin-only behaviour" }, async () => {

      const outsideFile = join(dirs.tmp, "outside-secret.html");
      writeFileSync(outsideFile, "<html>not the real dashboard</html>");
      const dashDir = join(dirs.projectDir, ".hive");
      mkdirSync(dashDir, { recursive: true });
      symlinkSync(outsideFile, join(dashDir, "dashboard.html"));

      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.deepEqual(
        fakeOpen.calls(),
        [],
        "a dashboard.html symlinked outside the project root must never be opened, even inside a real, contained .hive",
      );
      assert.equal(marker(project.id), undefined, "a refused open must not leave a marker behind");

      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(dashDir, "dashboard.html"));
    });

    it("opens the dashboard exactly once the file exists, and marks it with a real TTL", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
      const dashDir = join(dirs.projectDir, ".hive");
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(join(dashDir, "dashboard.html"), "<html></html>");

      const before = Date.now();
      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      const calls = fakeOpen.calls();
      assert.equal(calls.length, 1, `expected exactly one open call, got ${JSON.stringify(calls)}`);
      assert.match(calls[0], /^file:\/\/.*\.hive\/dashboard\.html$/, "must open the dashboard's own file:// URL");

      const row = marker(project.id);
      assert.ok(row, "a marker row must exist once the dashboard has been opened");
      assert.ok(row.expires_at, "the marker must carry a TTL, not persist forever");

      const expiresAt = new Date(row.expires_at.replace(" ", "T") + "Z").getTime();
      const hoursFromNow = (expiresAt - before) / (1000 * 60 * 60);
      assert.ok(
        hoursFromNow > 7.9 && hoursFromNow < 8.1,
        `expected the marker to expire ~8h out, got ${hoursFromNow.toFixed(2)}h`,
      );
    });

    it("a second hive attach in the same window does not reopen it", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.equal(fakeOpen.calls().length, 1, "the marker from the previous case must suppress a second open");
    });

    it("an expired marker lets the next hive attach open it again", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
      db.prepare("UPDATE kv SET expires_at = datetime('now', '-1 seconds') WHERE project_id = ? AND key = ?").run(
        project.id,
        MARKER_KEY,
      );
      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.equal(fakeOpen.calls().length, 2, "an expired marker must not suppress the next open");
    });

    it("a failed open leaves no marker, so the next attach retries rather than staying poisoned for 8h", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
      db.prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(project.id, MARKER_KEY);
      fakeOpen.reset();

      const failed = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,

        env: { PATH: `${fakeOpen.failBin}:${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(failed.code, 0, failed.stderr, "a failed open must not crash hive attach");
      assert.equal(marker(project.id), undefined, "a failed open must not leave a marker behind");

      const retried = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(retried.code, 0, retried.stderr);
      assert.equal(fakeOpen.calls().length, 1, "the next attach, with a working open, must retry rather than staying suppressed");
      assert.ok(marker(project.id), "the retried, successful open must leave a marker this time");
    });
  },
);

describe("cmdAttach and dashboard: false (todo 356)", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const dirs2 = scratchDirs();
  const session = sessionName();
  let project2;

  before(async () => {
    writeYml(dirs2.projectDir, "dashboard: false\n");
      const dashDir = join(dirs2.projectDir, ".hive");
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, "dashboard.html"), "<html></html>");
    const init = await runCli(["init"], { cwd: dirs2.projectDir, dataDir: dirs.dataDir, tmp: dirs2.tmp });
    assert.equal(init.code, 0, init.stderr);
    project2 = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs2.projectDir);
  });

  after(() => cleanup(session));

  it("never opens the dashboard when hive.yml does not gate it, even with the file already present - and does once flipped to true (positive control)", async () => {
    fakeOpen.reset();
    const attached = await runCli(["attach"], {
      cwd: dirs2.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs2.tmp,
      env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
    });
    assert.equal(attached.code, 0, attached.stderr);
    assert.deepEqual(fakeOpen.calls(), [], "dashboard: false must never call open");
    assert.equal(marker(project2.id), undefined);

    if (runnable) {
      writeYml(dirs2.projectDir, "dashboard: true\n");
      const reattached = await runCli(["attach"], {
        cwd: dirs2.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs2.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(reattached.code, 0, reattached.stderr);
      assert.equal(
        fakeOpen.calls().length,
        1,
        "flipping dashboard: true on the same project, same file, must now open - proving the earlier zero was the gate, not an accident",
      );
    }
  });
});
