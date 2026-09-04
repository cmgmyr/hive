import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, REPO, runCli, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the restart-lead refusal tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName, viewSessionName } = await import("../dist/tmux.js");
const { dispatcherScript, cliPath } = await import("../dist/dispatcher.js");
migrate();

const SCRIPT = join(REPO, "scripts", "restart-lead.sh");
const FIXTURE = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");

const binDir = join(dirs.tmp, "bin");
mkdirSync(binDir, { recursive: true });
const hiveShim = join(binDir, "hive");
writeFileSync(hiveShim, dispatcherScript(process.execPath, cliPath()));
chmodSync(hiveShim, 0o755);

const fakeClaude = makeFakeClaude(dirs.tmp);
const claudePath = fakeClaude(`cat '${FIXTURE}'; sleep 600`);
const PATH = `${binDir}:${dirname(claudePath)}:${process.env.PATH}`;

const projectDir = dirs.projectDir;
const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id, name")
  .get("restart-lead-test", projectDir);
const session = sessionName();
const restartLog = join(dirs.tmp, "restart-lead.log");

function runDryRun() {
  const env = {
    ...process.env,
    PATH,
    HIVE_DATA_DIR: dirs.dataDir,
    HIVE_SESSION: session,
    HIVE_REPO: projectDir,
    HIVE_RESTART_LOG: restartLog,
  };
  try {
    const stdout = execFileSync(SCRIPT, ["--dry-run"], { env, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function insertProject(name, path) {
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id, name, path").get(name, path);
}

async function startRealLead(proj, cwd, extraArgs = []) {
  const lead = await runCli(["lead", ...extraArgs], { cwd, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { PATH } });
  assert.equal(lead.code, 0, lead.stderr);
  const pane = leadRow(db, proj.id).tmux_target;
  const rendered = await until(() =>
    execFileSync("tmux", ["capture-pane", "-p", "-t", pane]).toString().includes("shift+tab to cycle"),
  );
  assert.ok(rendered, "the fixture must render into the lead's pane before the script can see it");
  return pane;
}

function runScript(args, envOverrides, log) {
  const env = { ...process.env, PATH, HIVE_DATA_DIR: dirs.dataDir, HIVE_RESTART_LOG: log, ...envOverrides };
  try {
    const stdout = execFileSync(SCRIPT, args, { env, encoding: "utf8", timeout: 20000 });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe(
  "restart-lead.sh refusal 2 counts live workers, not the lead's own row",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    after(() => cleanup(session));

    it("exits 0 with only the lead's own kind='lead' row running - zero workers", async () => {
      const lead = await runCli(["lead"], { cwd: projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { PATH } });
      assert.equal(lead.code, 0, lead.stderr);

      const pane = leadRow(db, project.id).tmux_target;
      const rendered = await until(() =>
        execFileSync("tmux", ["capture-pane", "-p", "-t", pane]).toString().includes("shift+tab to cycle"),
      );
      assert.ok(rendered, "the fixture must render into the lead's pane before the script can see it");

      const result = runDryRun();
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);

      const log = readFileSync(restartLog, "utf8");
      assert.match(log, /running agents: 0/, "the lead's own row must not be counted");
      assert.match(log, /dry run: would kill/, "must have reached the dry-run line, not refused earlier");
    });

    it("still exits 1 when a real kind='agent' worker is running - the refusal must not be blanket-disabled", () => {
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'agent:restart-lead-test-worker', 'restart-lead-test-worker', '%not-a-real-pane', 'claude', ?, 'agent', 'running')`,
      ).run(project.id, projectDir);

      const result = runDryRun();
      assert.notEqual(result.status, 0, `expected a refusal, got: ${result.stdout}`);
      assert.match(result.stderr, /REFUSED: 1 agent\(s\) still running/);

      const log = readFileSync(restartLog, "utf8");
      assert.match(log, /running agents: 1/, "the seeded worker must be counted");
    });
  },
);

describe(
  "restart-lead.sh's refusal 2: the kind='agent' allowlist and the project_id scope",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("does not count a kind='command' row (a hive.yml process) as a blocking agent", async () => {
      const dir = mkdtempSync(join(dirs.tmp, "proj-allowlist-"));
      const proj = insertProject("restart-lead-allowlist", dir);
      const projSession = sessionName();
      await startRealLead(proj, dir);
      after(() => cleanup(projSession));

      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'command:dev', 'dev', '%not-a-real-pane', 'npm run dev', ?, 'command', 'running')`,
      ).run(proj.id, dir);

      const log = join(dirs.tmp, "restart-lead-allowlist.log");
      const result = runScript(
        ["--dry-run"],
        { HIVE_SESSION: projSession, HIVE_REPO: dir },
        log,
      );
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(readFileSync(log, "utf8"), /running agents: 0/, "a kind='command' row must not be counted");
    });

    it("does not count a running worker in a DIFFERENT project", async () => {
      const dirA = mkdtempSync(join(dirs.tmp, "proj-scope-a-"));
      const dirB = mkdtempSync(join(dirs.tmp, "proj-scope-b-"));
      const projA = insertProject("restart-lead-scope-a", dirA);
      const projB = insertProject("restart-lead-scope-b", dirB);
      const sessionA = sessionName();
      await startRealLead(projA, dirA);
      after(() => cleanup(sessionA));

      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'agent:other-project-worker', 'other-project-worker', '%not-a-real-pane', 'claude', ?, 'agent', 'running')`,
      ).run(projB.id, dirB);

      const log = join(dirs.tmp, "restart-lead-scope.log");
      const result = runScript(
        ["--dry-run"],
        { HIVE_SESSION: sessionA, HIVE_REPO: dirA },
        log,
      );
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(readFileSync(log, "utf8"), /running agents: 0/, "project B's worker must not count against project A");
    });
  },
);

describe(
  "restart-lead.sh derives REPO from its own on-disk location when HIVE_REPO is unset",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("resolves the project registered at REPO's own path with no override", async () => {

      const proj = insertProject("restart-lead-repo-derivation", REPO);
      const projSession = sessionName();

      await startRealLead(proj, REPO, ["--no-dashboard"]);
      after(() => cleanup(projSession));

      const { loadProjectYml, configHash } = await import("../dist/projectYml.js");
      const { config } = loadProjectYml(REPO);
      if (config?.lead) {
        db.prepare("INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)").run(
          proj.id,
          "lead",
          configHash("lead", config.lead, null, {}),
        );
      }

      const log = join(dirs.tmp, "restart-lead-repo-derivation.log");

      const result = runScript(
        ["--dry-run"],
        { HIVE_SESSION: projSession },
        log,
      );
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.ok(
        readFileSync(log, "utf8").includes(`resolved project: restart-lead-repo-derivation (id ${proj.id}, ${REPO})`),
        "REPO must derive to this checkout's own on-disk path with no override",
      );
    });
  },
);

describe(
  "restart-lead.sh derives SESSION from the live pane via tmux when HIVE_SESSION is unset",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "performs a real restart against a hash-tagged, non-default-store session with no override",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-session-derivation-"));
        const proj = insertProject("restart-lead-session-derivation", dir);
        const projSession = sessionName();
        await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        const log = join(dirs.tmp, "restart-lead-session-derivation.log");

        const result = runScript(["--delay", "0"], { HIVE_REPO: dir }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);

        const marker = `session: ${projSession};`;
        const count = contents.split(marker).length - 1;
        assert.equal(count, 2, `expected "${marker}" twice (pre- and post-restart); log:\n${contents}`);

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane derived with no HIVE_SESSION override");
      },
      { timeout: 30000 },
    );
  },
);

describe(
  "restart-lead.sh resolves the BASE session even when a view session is grouped with it",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "a clientless view session grouped with the base must not divert SESSION away from it",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-view-ambiguity-"));
        const proj = insertProject("restart-lead-view-ambiguity", dir);
        const projSession = sessionName();
        await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        const view = viewSessionName();
        execFileSync("tmux", ["new-session", "-d", "-t", `=${projSession}`, "-s", view]);
        after(() => {
          try {
            execFileSync("tmux", ["kill-session", "-t", `=${view}`]);
          } catch {

          }
        });

        const log = join(dirs.tmp, "restart-lead-view-ambiguity.log");
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);

        const marker = `session: ${projSession};`;
        const count = contents.split(marker).length - 1;
        assert.equal(
          count,
          2,
          `expected "${marker}" (the base session) twice; the view must never be named; log:\n${contents}`,
        );
        assert.doesNotMatch(
          contents,
          new RegExp(`session: ${view};`),
          `must never resolve SESSION to the view session; log:\n${contents}`,
        );

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane despite the grouped view session");
      },
      { timeout: 30000 },
    );
  },
);

describe(
  "restart-lead.sh performs a REAL restart correctly, isolated",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "kills the pane the STORE names, not the first pane in the window - a decoy sorted first must survive untouched",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-decoy-"));
        const proj = insertProject("restart-lead-decoy", dir);
        const projSession = sessionName();
        const leadPane = await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        const decoyPath = fakeClaude("sleep 600");
        const decoyPane = execFileSync("tmux", [
          "split-window", "-b", "-P", "-F", "#{pane_id}", "-t", leadPane, decoyPath,
        ]).toString().trim();

        const orderLines = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_index}\t#{pane_id}"])
          .toString()
          .trim()
          .split("\n");
        const decoyIndex = orderLines.findIndex((line) => line.split("\t")[1] === decoyPane);
        const leadIndex = orderLines.findIndex((line) => line.split("\t")[1] === leadPane);
        assert.ok(
          decoyIndex >= 0 && leadIndex >= 0 && decoyIndex < leadIndex,
          `setup bug: the decoy must sort before the lead pane for this test to discriminate anything; order:\n${orderLines.join("\n")}`,
        );

        const log = join(dirs.tmp, "restart-lead-decoy.log");
        const result = runScript(
          ["--delay", "0"],
          { HIVE_SESSION: projSession, HIVE_REPO: dir },
          log,
        );
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);

        const storeMentions = contents.split("resolved via: store,").length - 1;
        assert.equal(storeMentions, 2, `expected both pre- and post-restart resolution to say "resolved via: store"; log:\n${contents}`);
        assert.match(contents, /restart complete/, "a clean run with a live store match must report complete, not DEGRADED");

        const panesAfter = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_id}"]).toString();
        assert.ok(panesAfter.includes(decoyPane), "the decoy pane must survive untouched");
        assert.ok(!panesAfter.includes(leadPane), "the OLD lead pane must be gone - the restart did happen");

        const newPane = leadRow(db, proj.id).tmux_target;
        assert.notEqual(newPane, decoyPane, "the store's lead row must never end up naming the decoy's pane");
        assert.ok(panesAfter.includes(newPane), "the store's lead row must name a pane that is actually live");

        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff prompt must land in the new lead pane");
        const decoyScreen = execFileSync("tmux", ["capture-pane", "-p", "-t", decoyPane]).toString();
        assert.doesNotMatch(decoyScreen, /read the board pad in full/, "the handoff must never land in the decoy's pane");
      },
      { timeout: 30000 },
    );

    it(
      "the session survives the kill when the lead's pane is the only pane in the only window",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-singlepane-"));
        const proj = insertProject("restart-lead-singlepane", dir);
        const projSession = sessionName();
        await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        const panesBefore = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_id}"]).toString().trim().split("\n");
        assert.equal(panesBefore.length, 1, `setup bug: expected exactly one pane, got: ${panesBefore.join(",")}`);
        const windowsBefore = execFileSync("tmux", ["list-windows", "-t", `=${projSession}`, "-F", "#{window_id}"]).toString().trim().split("\n");
        assert.equal(windowsBefore.length, 1, `setup bug: expected exactly one window, got: ${windowsBefore.join(",")}`);

        execFileSync("tmux", ["set-option", "-t", projSession, "@restart-lead-test-witness", "still-here"]);

        const log = join(dirs.tmp, "restart-lead-singlepane.log");
        const result = runScript(
          ["--delay", "0"],
          { HIVE_SESSION: projSession, HIVE_REPO: dir },
          log,
        );
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);

        let witness;
        try {
          witness = execFileSync("tmux", ["show-options", "-t", projSession, "-v", "@restart-lead-test-witness"], {
            encoding: "utf8",
          }).trim();
        } catch {
          witness = null;
        }
        assert.equal(
          witness,
          "still-here",
          "the session must be the SAME session object across the kill, not a same-named replacement - " +
            "with no placeholder, tmux destroys the session when its only pane is killed, and `hive lead` " +
            "then creates a brand-new one that carries none of this session's prior state, including this option",
        );

        const windowsAfter = execFileSync("tmux", ["list-windows", "-t", `=${projSession}`, "-F", "#{window_name}"]).toString();
        assert.doesNotMatch(windowsAfter, /restart-lead-placeholder/, "the placeholder must be removed once a live lead pane is confirmed, on the success path");

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane even in the single-pane/single-window case");
      },
      { timeout: 30000 },
    );
  },
);

describe(
  "restart-lead.sh skips the kill when there is nothing live to kill",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "no running kind='lead' row at all: hive lead alone still produces a live lead",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-norow-"));
        const proj = insertProject("restart-lead-no-row", dir);
        const projSession = sessionName();
        after(() => cleanup(projSession));

        const log = join(dirs.tmp, "restart-lead-no-row.log");
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir, HIVE_SESSION: projSession }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);
        assert.match(contents, /nothing to kill; will just run hive lead/, "must recognize there is no row to resolve");
        assert.doesNotMatch(contents, /\bkilling %/, "must never call kill-pane when there is no live pane");

        const newPane = leadRow(db, proj.id).tmux_target;
        assert.ok(newPane, "hive lead must have produced a live lead row");
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff must land in the freshly-created lead pane");
      },
      { timeout: 30000 },
    );

    it(
      "a running kind='lead' row naming a DEAD pane: hive lead alone still produces a live lead",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-deadrow-"));
        const proj = insertProject("restart-lead-dead-row", dir);
        const projSession = sessionName();
        const deadPane = await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        execFileSync("tmux", ["kill-pane", "-t", deadPane]);

        const log = join(dirs.tmp, "restart-lead-dead-row.log");
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir, HIVE_SESSION: projSession }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);
        assert.match(contents, /nothing to kill; will just run hive lead/, "must recognize the row's pane is dead");
        assert.doesNotMatch(contents, /\bkilling %/, "must never call kill-pane against a pane that is already dead");

        const newPane = leadRow(db, proj.id).tmux_target;

        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff must land in the freshly-created lead pane");
      },
      { timeout: 30000 },
    );
  },
);

describe(
  "restart-lead.sh refuses when hive.yml's lead: command is not trusted",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("refuses before the dry-run line when the lead: command has never been approved", async () => {
      const dir = mkdtempSync(join(dirs.tmp, "proj-untrusted-"));

      const proj = insertProject("restart-lead-untrusted", dir);
      const projSession = sessionName();
      await startRealLead(proj, dir);
      after(() => cleanup(projSession));

      writeFileSync(join(dir, "hive.yml"), "lead: claude --model opus\n");

      const log = join(dirs.tmp, "restart-lead-untrusted.log");
      const result = runScript(["--dry-run"], { HIVE_SESSION: projSession, HIVE_REPO: dir }, log);
      assert.notEqual(result.status, 0, `expected a refusal, got: ${result.stdout}`);
      assert.match(result.stderr, /lead: command is not trusted for its current config/);
      const contents = readFileSync(log, "utf8");
      assert.doesNotMatch(contents, /dry run: would kill/, "must refuse before reaching the dry-run line");
    });
  },
);

describe(
  "restart-lead.sh picks ONE lead row deterministically when two are running",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("LIMIT 1 resolves cleanly rather than degrading when a second, stray kind='lead' row exists", async () => {
      const dir = mkdtempSync(join(dirs.tmp, "proj-tworows-"));
      const proj = insertProject("restart-lead-two-rows", dir);
      const projSession = sessionName();
      const realPane = await startRealLead(proj, dir);
      after(() => cleanup(projSession));

      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'lead:stray', 'lead-stray', '%stray-not-a-real-pane', 'claude', ?, 'lead', 'running')`,
      ).run(proj.id, dir);

      const log = join(dirs.tmp, "restart-lead-two-rows.log");
      const result = runScript(["--dry-run"], { HIVE_SESSION: projSession, HIVE_REPO: dir }, log);
      const contents = readFileSync(log, "utf8");
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);
      assert.ok(
        contents.includes(`lead pane: ${realPane} `),
        `expected resolution to name the real, live pane (${realPane}) despite the stray row; log:\n${contents}`,
      );
    });
  },
);

describe(
  "restart-lead.sh keeps the session alive when claude never becomes ready",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "READY != 1 is a hard failure (gone()), and the placeholder survives to keep the session alive",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-neverready-"));
        const proj = insertProject("restart-lead-never-ready", dir);
        const projSession = sessionName();
        await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        const neverReadyPath = fakeClaude("sleep 600");
        writeFileSync(join(dir, "hive.yml"), `lead: ${neverReadyPath}\n`);
        const { configHash } = await import("../dist/projectYml.js");
        db.prepare("INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)").run(
          proj.id,
          "lead",
          configHash("lead", neverReadyPath, null, {}),
        );

        const log = join(dirs.tmp, "restart-lead-never-ready.log");
        const result = runScript(
          ["--delay", "0"],
          { HIVE_SESSION: projSession, HIVE_REPO: dir, HIVE_RESTART_READY_TIMEOUT: "2" },
          log,
        );
        const contents = readFileSync(log, "utf8");
        assert.notEqual(result.status, 0, `expected a failure, got: ${result.stdout}`);
        assert.match(result.stderr, /RESTART FAILED PAST THE KILL:.*never became ready/, `log:\n${contents}`);

        const sessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"]).toString();
        assert.ok(sessions.includes(projSession), `session ${projSession} must survive; sessions:\n${sessions}`);
        const windows = execFileSync("tmux", ["list-windows", "-t", `=${projSession}`, "-F", "#{window_name}"]).toString();
        assert.match(windows, /restart-lead-placeholder/, "the placeholder must survive a failure past the kill, as a deliberate signal");
      },
      { timeout: 30000 },
    );
  },
);

describe(
  "restart-lead.sh's production path: detached re-exec from inside the pane it kills",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "re-execs detached when TMUX_PANE matches the resolved lead pane, and the child completes the restart",
      async () => {
        const dir = mkdtempSync(join(dirs.tmp, "proj-detached-"));
        const proj = insertProject("restart-lead-detached", dir);
        const projSession = sessionName();
        const leadPane = await startRealLead(proj, dir);
        after(() => cleanup(projSession));

        const log = join(dirs.tmp, "restart-lead-detached.log");

        const result = runScript(
          ["--delay", "0"],
          { HIVE_SESSION: projSession, HIVE_REPO: dir, TMUX_PANE: leadPane },
          log,
        );

        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
        const parentLog = readFileSync(log, "utf8");
        assert.match(
          parentLog,
          /launched from the target pane; re-execing detached/,
          "the parent must recognize it is running inside the pane it would kill",
        );
        assert.doesNotMatch(
          parentLog,
          /killing %/,
          "the FOREGROUND parent must never itself kill the pane - only the detached child may",
        );

        const completed = await until(
          () => readFileSync(log, "utf8").includes("prompt sent; restart complete"),
          10000,
        );
        assert.ok(completed, `detached child never completed the restart; log:\n${readFileSync(log, "utf8")}`);

        const panesAfter = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_id}"]).toString();
        assert.ok(!panesAfter.includes(leadPane), "the old lead pane must be gone - the detached child actually killed it");

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("read the board pad in full"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane, delivered by the detached child");
      },
      { timeout: 30000 },
    );
  },
);

describe("restart-lead.sh does not keep its own copy of the dialog predicate (todo 399)", () => {

  const stripComments = (src) => src.replace(/^\s*#.*$/gm, "");

  it("calls hive's own predicate through dist/ instead of transcribing it", () => {
    const script = stripComments(readFileSync(SCRIPT, "utf8"));

    assert.match(
      script,
      /paneAwaitingChoice/,
      "scripts/restart-lead.sh must reach hive's own dialog predicate, not re-derive one",
    );
    assert.match(
      script,
      /paneHasInputBox/,
      "scripts/restart-lead.sh must reach hive's own input-box predicate, not re-derive one",
    );
    assert.match(
      script,
      /DIST_TMUX=/,
      "the predicate must come from THIS checkout's dist/, the same way DIST_PROJECTYML does",
    );
  });

  for (const [label, pattern] of [
    ["the retired footer regex", /for shortcuts/],
    ["an INPUT_BOX assignment", /^INPUT_BOX=/m],
    ["a CHOICE_DIALOG assignment", /^CHOICE_DIALOG=/m],
  ]) {
    it(`has not grown ${label} back`, () => {
      const script = stripComments(readFileSync(SCRIPT, "utf8"));
      assert.doesNotMatch(
        script,
        pattern,
        `OPEN scripts/restart-lead.sh: it has grown its own copy of hive's dialog predicate again (${label}). ` +
          "That copy shipped todo 392's bug and then todo 399's, on the script that repaints the LEAD's pane. " +
          "Call paneAwaitingChoice/paneHasInputBox through dist/tmux.js instead - see src/tmux.ts's own comment " +
          "on those two exports for why they exist at all.",
      );
    });
  }
});

describe("restart-lead.sh's CLAUDE_PANE_CMD identifies claude by process, not by screen content (todo 392 round 1, F2)", () => {
  it("matches a claude version string and the literal 'claude', never an ordinary shell or tool", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const pattern = script.match(/^CLAUDE_PANE_CMD='(.*)'$/m)?.[1];
    assert.ok(pattern, "could not extract CLAUDE_PANE_CMD from restart-lead.sh");

    const matches = (name) => {
      try {
        execFileSync("bash", ["-c", 'printf \'%s\' "$2" | grep -qE "$1"', "_", pattern, name]);
        return true;
      } catch {
        return false;
      }
    };

    for (const claude of ["2.1.220", "2.1.231", "3.0.0", "claude"]) {
      assert.ok(matches(claude), `must match a real claude pane_current_command: ${claude}`);
    }
    for (const other of ["bash", "sh", "zsh", "node", "cat", "vim", "python3", ""]) {
      assert.ok(!matches(other), `must not match an ordinary shell/tool command: ${JSON.stringify(other)}`);
    }
  });
});

describe(
  "restart-lead.sh's refusal 1 no longer trusts CHOICE_DIALOG text as proof of claude identity (todo 392 round 1, F2)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("refuses a bare shell whose scrollback happens to carry ordinary installer prompt text", async () => {
      const dir = mkdtempSync(join(dirs.tmp, "proj-not-claude-"));
      const proj = insertProject("restart-lead-not-claude", dir);
      const projSession = sessionName();
      after(() => cleanup(projSession));

      const pane = execFileSync("tmux", [
        "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", projSession, "-x", "220", "-y", "50",
        "sh", "-c", "printf 'brew upgrade\\nWould you like to proceed with the upgrade? [Y/n]\\n'; sleep 600",
      ]).toString().trim();

      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'lead:not-claude-test', 'not-claude-lead', ?, 'sh', ?, 'lead', 'running')`,
      ).run(proj.id, pane, dir);

      const rendered = await until(() =>
        execFileSync("tmux", ["capture-pane", "-p", "-t", pane]).toString().includes("Would you like to proceed"),
      );
      assert.ok(rendered, "the fixture text must render before the script can see it");

      const log = join(dirs.tmp, "restart-lead-not-claude.log");
      const result = runScript(["--dry-run"], { HIVE_SESSION: projSession, HIVE_REPO: dir }, log);

      assert.notEqual(result.status, 0, `expected a refusal, got: ${result.stdout}`);
      assert.match(
        result.stderr,
        /does not look like claude/,
        `refusal 1 must be the one that catches this - a "waiting on a choice" message here would mean refusal 3 is doing refusal 1's own job: ${result.stderr}`,
      );

      const panesAfter = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_id}"]).toString();
      assert.ok(panesAfter.includes(pane), "the pane must survive - a real kill here is the exact defect this closes");
    });
  },
);

describe("restart-lead.sh's view-session filter agrees with src/tmux.ts's isViewSessionName", () => {
  it("the pattern extracted from restart-lead.sh classifies the same names isViewSessionName does", async () => {
    const script = readFileSync(SCRIPT, "utf8");
    const scriptPattern = script.match(/grep -vE '([^']*)'/)?.[1];
    assert.ok(scriptPattern, "could not extract the view-session filter pattern from restart-lead.sh");

    const { isViewSessionName } = await import("../dist/tmux.js");
    const samples = [
      "hive-main",
      "hive-abc123view-4821",
      "hive-view-99",
      "hive-abc123-notview-4821",
      "hive-abc123view-",
      "hive-abc123view-12x",

      "hive-abc123view-4821-2",
      "hive-view-99-14",
    ];
    for (const name of samples) {
      let bashSays;
      try {
        execFileSync("bash", ["-c", 'printf \'%s\' "$2" | grep -qE "$1"', "_", scriptPattern, name]);
        bashSays = true;
      } catch {
        bashSays = false;
      }
      assert.equal(
        bashSays,
        isViewSessionName(name),
        `restart-lead.sh's filter and isViewSessionName disagree on ${JSON.stringify(name)}`,
      );
    }
  });
});
