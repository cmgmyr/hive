import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, makeFakeOpen, runCli, scratchDirs } from "./helpers.mjs";

// Todo 356. `hive attach` (cmdAttach, src/cli.ts) opens a project's dashboard
// in a browser the FIRST time it is run in a rolling ~8h window, gated on
// hive.yml's `dashboard: true` with no new config value (Chris's own call,
// todo 356 body). Idempotence comes from a kv TTL marker rather than from
// `open` itself: comments 815/816 measured `open` on this file:// URL to
// duplicate a browser window on every call, deterministically, never
// focusing an existing one.
//
// `open` is faked on PATH via makeFakeOpen (test/helpers.mjs), the same
// shape test/auto-attach-scope.test.mjs uses for osascript: a real `open`
// would pop a real browser window on whatever machine runs this suite, which
// is both undesirable in CI and the very interruption a human "hive at the
// keyboard" measurement (not an automated probe) already covered.
//
// KNOWN GAPS, not covered here and said out loud rather than left implicit:
// the concurrent-double-attach race the atomic conditional UPSERT in
// maybeOpenDashboard closes has no test - reproducing two real processes
// racing the same millisecond is disproportionate to this lane, and the fix
// mirrors an idiom (CLAUDE.md's own Invariants: "wake-up claims are atomic
// conditional updates") already exercised elsewhere rather than inventing new
// logic that would need its own proof. And per the accepted-residual comment
// at the call site, nothing here forces a real pty to exercise the
// headless-invocation gap, on the same grounds
// test/attach-caller-session.test.mjs already declined to for callerSession().
//
// The `hive lead` / bare `hive` trigger - the one the todo actually asked
// for - and the `--no-dashboard` flag live in test/dashboard-open-lead.test.mjs
// instead of here; this file owns the underlying gates
// (darwin/hive.yml/file-existence/containment/kv-marker/TTL) via cmdAttach,
// which both entry points share.
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

// The positive cases actually call macOS `open` (faked on PATH); on a
// non-darwin box the platform gate returns before any of that, so those
// cases would fail on CORRECT code rather than broken code (counselors,
// codex). Matches test/auto-attach-scope.test.mjs's own `runnable` gate for
// the identical reason - ensureAttached is darwin-only too.
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
      // Same shape maybeGenerateDashboard's own resolveDashboardDir test
      // guards on the write side (scheduler.test.mjs's "counselors P1"
      // block) - the open path now reuses that exact function, so this pins
      // the reuse rather than re-deriving the attack.
      const outside = join(dirs.tmp, "outside-project");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "index.html"), "<html>not the real dashboard</html>");
      const claudeDir = join(dirs.projectDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      symlinkSync(outside, join(claudeDir, "dashboard"));

      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${fakeOpen.bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      assert.deepEqual(fakeOpen.calls(), [], "a dashboard dir symlinked outside the project root must never be opened");
      assert.equal(marker(project.id), undefined, "a refused open must not leave a marker behind");

      // Clean up before the next case, which needs an ordinary directory at
      // this same path.
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(claudeDir, "dashboard"));
    });

    it("does not open a checked-in index.html that is ITSELF a symlink escaping the project root, inside an otherwise-real, contained .claude/dashboard", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
      // Counselors, round 3 (posted four times before it was read - see
      // todo 356's record). Different from the case above: here
      // .claude/dashboard is a REAL, contained directory - resolveDashboardDir
      // returns it immediately and never inspects what is inside - so the
      // escape has to be closed one level deeper, at the file itself.
      const outsideFile = join(dirs.tmp, "outside-secret.html");
      writeFileSync(outsideFile, "<html>not the real dashboard</html>");
      const dashDir = join(dirs.projectDir, ".claude", "dashboard");
      mkdirSync(dashDir, { recursive: true });
      symlinkSync(outsideFile, join(dashDir, "index.html"));

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
        "an index.html symlinked outside the project root must never be opened, even inside a real, contained .claude/dashboard",
      );
      assert.equal(marker(project.id), undefined, "a refused open must not leave a marker behind");

      // Clean up before the next case, which needs an ordinary index.html at
      // this same path.
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(dashDir, "index.html"));
    });

    it("opens the dashboard exactly once the file exists, and marks it with a real TTL", { skip: runnable ? false : "darwin-only behaviour" }, async () => {
      const dashDir = join(dirs.projectDir, ".claude", "dashboard");
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(join(dashDir, "index.html"), "<html></html>");

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
      assert.match(calls[0], /^file:\/\/.*index\.html$/, "must open the dashboard's own file:// URL");

      const row = marker(project.id);
      assert.ok(row, "a marker row must exist once the dashboard has been opened");
      assert.ok(row.expires_at, "the marker must carry a TTL, not persist forever");
      // Pins the ~8h TTL itself, not just "some TTL was set" (counselors,
      // codex): a marker that expired in 5 minutes or 80 hours would pass a
      // bare truthiness check.
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
        // failBin first: this "open" exits 1 and never logs, so a call that
        // reaches it is indistinguishable from a call that reaches nothing -
        // exactly the browser-launch failure this case exists to simulate.
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
    const dashDir = join(dirs2.projectDir, ".claude", "dashboard");
    mkdirSync(dashDir, { recursive: true });
    writeFileSync(join(dashDir, "index.html"), "<html></html>");
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

    // Positive control (counselors, claude-opus-5, F2): without this, "no
    // open call" is equally true if the dashboard:false gate fired, or if
    // dirs2's project resolved wrong, or for any other reason attach bailed
    // early. Flipping the SAME project to dashboard: true and re-running
    // proves the earlier zero was this gate specifically, not an accident.
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
