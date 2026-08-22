import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead restart-gap characterisation tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName, isPaneTarget, tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

function newProjectDir() {
  return realpathSync(mkdtempSync(join(dirname(dirs.projectDir), "project-")));
}

function windowIdOf(target) {
  return Number(
    execFileSync("tmux", ["display-message", "-p", "-t", target, "#{window_id}"])
      .toString()
      .trim()
      .replace("@", ""),
  );
}

function windowTargetOf(pane) {
  return execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{session_name}:#{window_id}"])
    .toString()
    .trim();
}

function sessionPanes(session) {
  return execFileSync("tmux", [
    "list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}\t#{window_id}\t#{pane_current_command}",
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function windowsIn(session) {
  return execFileSync("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

function panesIn(windowTarget) {
  return execFileSync("tmux", ["list-panes", "-t", windowTarget, "-F", "#{pane_id}"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

function paneAlive(pane) {
  try {
    execFileSync("tmux", ["list-panes", "-t", pane], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function dumpBehaviour1Diagnostics(session, pane, fakeClaude) {
  const tmuxOrError = (label, args) => {
    console.error(`[BEHAVIOUR 1 diagnostics] ${label}:`);
    try {
      console.error(execFileSync("tmux", args, { encoding: "utf8" }));
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
  };
  tmuxOrError("tmux show-environment -g PATH", ["show-environment", "-g", "PATH"]);
  tmuxOrError(`tmux show-environment -t =${session} PATH`, ["show-environment", "-t", `=${session}`, "PATH"]);
  tmuxOrError(`pane_start_command / pane_pid / pane_current_command for ${pane}`, [
    "display-message",
    "-p",
    "-t",
    pane,
    "start=[#{pane_start_command}] pid=[#{pane_pid}] cmd=[#{pane_current_command}]",
  ]);
  tmuxOrError(`capture-pane -p -t ${pane}`, ["capture-pane", "-p", "-t", pane]);
  console.error(`[BEHAVIOUR 1 diagnostics] ls -l ${dirname(fakeClaude)}:`);
  try {
    console.error(execFileSync("ls", ["-l", dirname(fakeClaude)], { encoding: "utf8" }));
    console.error(`[BEHAVIOUR 1 diagnostics] first line of ${fakeClaude}:`);
    console.error(readFileSync(fakeClaude, "utf8").split("\n")[0]);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
  }
}

async function bootSinglePaneLead(name) {
  const fakeClaude = makeFakeClaude(dirs.tmp);
  const claudePath = fakeClaude("sleep 600");
  const projectDir = newProjectDir();
  const cliOpts = {
    cwd: projectDir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
  };
  const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, projectDir);
  const session = sessionName();
  const first = await runCli(["lead"], cliOpts);
  assert.equal(first.code, 0, first.stderr);
  const before = leadRow(db, project.id);
  return {
    cliOpts,
    project,
    session,
    before,
    pane: before.tmux_target,
    windowTarget: windowTargetOf(before.tmux_target),
  };
}

describe("cmdLead's restart path - the audit's gaps", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it(
    "BEHAVIOUR 1 (half): a fresh session claims tmux's own initial window, not a second one, and no idle shell survives",
    async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);

      const launchMarker = join(dirs.tmp, "behaviour-1-launch-marker");
      const claudePath = fakeClaude(`echo launched > "${launchMarker}" 2>/dev/null || true; exec sleep 600`);
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-fresh-window-test", projectDir);
      const session = sessionName();

      const keepaliveSession = `${session}-keepalive`;
      execFileSync("tmux", ["new-session", "-d", "-s", keepaliveSession], {
        stdio: "ignore",
        env: { ...process.env, PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      });

      const probeSession = `${session}-probe`;
      try {

        execFileSync("tmux", ["new-session", "-d", "-s", probeSession], { stdio: "ignore" });

        const probeWindowId = windowIdOf(`=${probeSession}:`);
        execFileSync("tmux", ["kill-session", "-t", `=${probeSession}`], { stdio: "ignore" });

        const result = await runCli(["lead"], cliOpts);
        assert.equal(result.code, 0, result.stderr);

        const row = leadRow(db, project.id);
        const leadWindowId = windowIdOf(row.tmux_target);

        assert.equal(
          leadWindowId,
          probeWindowId + 1,
          "the lead's window must be the very next window id after the probe - " +
            "the session's OWN initial window, not a second one made after it",
        );

        const windows = windowsIn(session);
        assert.equal(windows.length, 1, `expected exactly one window in the session, found: ${windows.join(", ")}`);
        assert.equal(windows[0], `@${leadWindowId}`);

        const panesNow = sessionPanes(session);
        assert.equal(panesNow.length, 1, `expected exactly one pane in the session, found: ${JSON.stringify(panesNow)}`);

        const launched = await until(
          () => existsSync(launchMarker) && readFileSync(launchMarker, "utf8").trim() !== "",
          10000,
        );
        if (!launched) dumpBehaviour1Diagnostics(session, row.tmux_target, claudePath);
        assert.ok(
          launched,
          `expected the fake claude to have run and written its launch marker within 10s, not sit idle; ` +
            `marker exists: ${existsSync(launchMarker)}; leadCommand: ${JSON.stringify(row.command)}` +
            (launched ? "" : " - see [BEHAVIOUR 1 diagnostics] lines on stderr above"),
        );
      } finally {

        cleanup(session, keepaliveSession, probeSession);
      }
    },
  );

  it(
    "BEHAVIOUR 2: a restart with the lead's own pane still alive reuses that SAME pane, and creates no second one",
    async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);

      const launchLog = join(dirs.tmp, "behaviour-2-launches.log");
      const claudePath = fakeClaude(`echo launched >> "${launchLog}" && exec sleep 600`);
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-idempotent-restart-test", projectDir);
      const session = sessionName();
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);

        const before = leadRow(db, project.id);
        const pane = before.tmux_target;
        const windowTarget = windowTargetOf(pane);
        const panesBefore = panesIn(windowTarget);
        assert.deepEqual(panesBefore, [pane], "sanity check: exactly one pane exists before the restart");

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr);

        const after = leadRow(db, project.id);
        assert.equal(after.id, before.id, "the same agents row must be reused");
        assert.equal(after.actor_id, before.actor_id);
        assert.equal(after.status, "running");

        assert.equal(after.tmux_target, pane, "the SAME pane must be recorded, not a fresh one");

        const panesAfter = panesIn(windowTarget);
        assert.deepEqual(panesAfter, panesBefore, "no second pane may be created in the window");

        assert.ok(
          isPaneTarget(after.tmux_target),
          `expected a pane id (%N) after the restart, got ${after.tmux_target}`,
        );

        const settled = await until(
          () => sessionPanes(session).some(([id, , cmd]) => id === after.tmux_target && cmd === "sleep"),
          10000,
        );
        assert.ok(settled, `expected ${after.tmux_target} to be running leadCommand before reading the launch log`);

        const launches = readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean);
        assert.equal(
          launches.length,
          1,
          `expected exactly one claude launch across both restarts, got ${launches.length}: ${JSON.stringify(launches)}`,
        );
      } finally {
        cleanup(session);
      }
    },
  );

  it(
    "BEHAVIOUR 7 (todo 507): adopting a pane does NOT relabel its command, and does not clear a hold that depends on that command",
    async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("exec sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-adopt-command-test", projectDir);
      const session = sessionName();
      const UNCLASSIFIABLE = "the pane's harness is not one hive can classify; ";
      try {
        assert.equal((await runCli(["lead"], cliOpts)).code, 0);
        const before = leadRow(db, project.id);

        // The pane is now running something hive cannot classify, exactly as `lead: codex` leaves it.
        db.prepare("UPDATE agents SET command = ? WHERE id = ?").run("codex --sandbox read-only", before.id);
        const timerId = db
          .prepare(
            `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
               due_at, held_at, held_reason)
             VALUES (?, ?, 'body', 'delay', '[]', ?, ?, datetime('now', '-1 seconds'), datetime('now'), ?)
             RETURNING id`,
          )
          .get(project.id, before.actor_id, before.actor_id, before.tmux_target, `${UNCLASSIFIABLE}, and more`).id;

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr);

        const after = leadRow(db, project.id);
        assert.equal(after.tmux_target, before.tmux_target, "sanity: this must be the ADOPT path, not a fresh pane");
        assert.equal(
          after.command,
          "codex --sandbox read-only",
          "hive did not start this pane and must not claim it runs the configured command",
        );

        const held = db.prepare("SELECT held_at, held_reason FROM timers WHERE id = ?").get(timerId);
        assert.ok(held.held_at, "an unclassifiable hold must survive an adopt - nothing about the pane changed");
        assert.match(held.held_reason ?? "", /not one hive can classify/);

        assert.match(
          second.stdout,
          /adopted the existing lead pane/,
          "a silent no-op is not good enough: the mismatch has to be stated",
        );
        assert.match(second.stdout, /codex --sandbox read-only/, "the notice must name what the pane actually runs");

        // Control: when hive DOES create the pane, it owns the command and the hold really clears.
        execFileSync("tmux", ["kill-pane", "-t", after.tmux_target]);
        await until(() => !paneAlive(after.tmux_target), 10000);
        const third = await runCli(["lead"], cliOpts);
        assert.equal(third.code, 0, third.stderr);

        const fresh = leadRow(db, project.id);
        assert.notEqual(
          fresh.pane_pid,
          before.pane_pid,
          "sanity: this must be a FRESH pane - its id can repeat, since killing the last pane takes the session with it",
        );
        assert.match(fresh.command, /claude/, "a pane hive created carries the command hive launched into it");
        const clearedTimer = db.prepare("SELECT held_at, held_reason FROM timers WHERE id = ?").get(timerId);
        assert.equal(clearedTimer.held_at, null, "a re-created pane clears the hold, or the gate is just 'never clear'");
        assert.equal(clearedTimer.held_reason, null);
      } finally {
        cleanup(session);
      }
    },
  );

  it(
    "BEHAVIOUR 4: unknown liveness (a foreign tmux_socket on the row) is treated as not-still-there, so hive lead proceeds with a fresh pane",
    async () => {
      const { cliOpts, project, session, before, pane: originalPane, windowTarget } =
        await bootSinglePaneLead("lead-unknown-liveness-test");
      try {

        db.prepare("UPDATE agents SET tmux_socket = ? WHERE id = ?").run(
          "/nonexistent/foreign/tmux/tmux-501/default",
          before.id,
        );

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr, "unknown liveness must not refuse the restart");

        const after = leadRow(db, project.id);

        assert.notEqual(after.tmux_target, originalPane, "a fresh pane must be recorded, not the foreign-socket one");
        assert.ok(isPaneTarget(after.tmux_target), `expected a pane id (%N), got ${after.tmux_target}`);

        assert.ok(paneAlive(originalPane), "the original, genuinely-alive pane must survive untouched");
        const panesAfter = panesIn(windowTarget);
        assert.deepEqual(
          panesAfter.sort(),
          [originalPane, after.tmux_target].sort(),
          "both the orphaned original pane and the fresh one must be present in the window",
        );

        assert.equal(after.tmux_socket, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR));
      } finally {
        cleanup(session);
      }
    },
  );

  it(
    "BEHAVIOUR 5 (issue #157): a live pane whose recorded pid disagrees with tmux's own reads as reissued, so hive lead does not adopt it",
    async () => {
      const { cliOpts, project, session, before, pane: originalPane, windowTarget } =
        await bootSinglePaneLead("lead-pid-mismatch-test");
      try {

        const mismatchedPid = String(Number(before.pane_pid) + 1);
        db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run(mismatchedPid, before.id);

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr, "a pid mismatch must not refuse the restart outright");

        const after = leadRow(db, project.id);

        assert.notEqual(after.tmux_target, originalPane, "a fresh pane must be recorded, not the pid-mismatched one");
        assert.ok(isPaneTarget(after.tmux_target), `expected a pane id (%N), got ${after.tmux_target}`);

        assert.ok(paneAlive(originalPane), "the original pane must survive untouched, not be killed");
        const panesAfter = panesIn(windowTarget);
        assert.deepEqual(
          panesAfter.sort(),
          [originalPane, after.tmux_target].sort(),
          "both the stranger's pane and the fresh lead pane must be present in the SAME window - " +
            "the window stamp matched, so this must not open a second window",
        );

        assert.notEqual(after.pane_pid, mismatchedPid);
        assert.notEqual(after.pane_pid, "");
      } finally {
        cleanup(session);
      }
    },
  );

  it(
    "BEHAVIOUR 6 (issue #157): a recorded pane_pid of '' (no fact recorded) still adopts exactly as today",
    async () => {
      const { cliOpts, project, session, before, pane, windowTarget } =
        await bootSinglePaneLead("lead-nullpid-adopt-test");
      try {

        db.prepare("UPDATE agents SET pane_pid = ? WHERE id = ?").run("", before.id);

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr);

        const after = leadRow(db, project.id);
        assert.equal(after.tmux_target, pane, "an absent recorded pid must still adopt the SAME pane, exactly as today");

        const panesAfter = panesIn(windowTarget);
        assert.deepEqual(panesAfter, [pane], "no second pane may be created - this is the adopt path, not the fresh-pane path");
        assert.notEqual(after.pane_pid, "", "the CAS must record a real pid now that the pane is confirmed live");
      } finally {
        cleanup(session);
      }
    },
  );
});
