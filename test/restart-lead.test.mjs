import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, REPO, runCli, scratchDirs, until } from "./helpers.mjs";

// Todo 186 / plan-restart-lead-in-tree step 3. Only refusal 2 is exercised
// here (whether the running-agents count includes the lead's own row): the
// respawn half of the fix kills a real pane and launches a fresh claude,
// which is exactly the live action this lane may never trigger (the plan
// pad's "THE LINE YOU DO NOT CROSS"). Every invocation below is --dry-run,
// which touches nothing.
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

// A real, executable `hive` on PATH: restart-lead.sh calls it as a bare
// command (`command -v hive`, `hive status`), not through dist/cli.js
// directly. Written through dispatcherScript() rather than by hand so this
// cannot silently drift from the exec-line format readDispatcher parses
// elsewhere (test/CLAUDE.md).
const binDir = join(dirs.tmp, "bin");
mkdirSync(binDir, { recursive: true });
const hiveShim = join(binDir, "hive");
writeFileSync(hiveShim, dispatcherScript(process.execPath, cliPath()));
chmodSync(hiveShim, 0o755);

// The fake claude replays a real captured idle screen (test/fixtures/panes/
// ready-idle.txt) rather than doing nothing: refusal 1 (claude chrome on
// screen) and refusal 3 (input box present, no choice dialog) both have to
// pass before refusal 2 - the one under test - is ever reached. See
// test/CLAUDE.md and test/typing-guards.test.mjs's own replayFixture for the
// same technique.
const fakeClaude = makeFakeClaude(dirs.tmp);
const claudePath = fakeClaude(`cat '${FIXTURE}'; sleep 600`);
const PATH = `${binDir}:${dirname(claudePath)}:${process.env.PATH}`;

const projectDir = dirs.projectDir;
const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id, name")
  .get("restart-lead-test", projectDir);
const session = sessionName();
const restartLog = join(dirs.tmp, "restart-lead.log");

// execFileSync throws on a non-zero exit rather than returning it, and
// scenario B below expects exit 1, so this wrapper reads status/stdout/stderr
// uniformly whether the script exited 0 or refused.
//
// HIVE_REPO is the scratch PROJECT dir, not REPO (the real hive checkout this
// suite runs from): the script now resolves its project FROM THE STORE by
// matching REPO against a registered project's path (fix round 1, todo 189),
// and the project seeded below is registered at projectDir, not at REPO. This
// still exercises every refusal here - HIVE_SESSION already overrides the
// derived value regardless - but a mismatched HIVE_REPO would
// make resolve_project fail before any of them are reached. Todo 193 covers
// the derivation itself, with HIVE_REPO unset.
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

// Shared by every describe block below todo 189's own (fix round 1, todo 193).
// Each gets its OWN project/session so scenarios cannot see each other's
// state - the file's first describe block already leaves a permanent
// kind='agent' worker row behind (its second test, above), which would
// silently break any later "running agents: 0" expectation that reused its
// project.
function insertProject(name, path) {
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id, name, path").get(name, path);
}

// Runs a REAL `hive lead` (not through restart-lead.sh) to give a scenario a
// real fake-claude pane to work with, and waits for the fixture to actually
// render - see the comment on the first describe block's own test for why
// that wait matters (a receipt is not proof the pane has content yet).
async function startRealLead(proj, cwd) {
  const lead = await runCli(["lead"], { cwd, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { PATH } });
  assert.equal(lead.code, 0, lead.stderr);
  const pane = leadRow(db, proj.id).tmux_target;
  const rendered = await until(() =>
    execFileSync("tmux", ["capture-pane", "-p", "-t", pane]).toString().includes("shift+tab to cycle"),
  );
  assert.ok(rendered, "the fixture must render into the lead's pane before the script can see it");
  return pane;
}

// `log` is a caller-chosen path so each scenario reads back only its OWN
// run's log lines, rather than grepping a file every earlier test in this
// suite has also appended to.
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

      // `hive lead` returns once the pane is split/created, not once `cat`
      // has actually rendered the fixture into it - capture-pane against an
      // empty pane is refusal 1's own false negative, not the fix under test.
      const pane = leadRow(db, project.id).tmux_target;
      const rendered = await until(() =>
        execFileSync("tmux", ["capture-pane", "-p", "-t", pane]).toString().includes("shift+tab to cycle"),
      );
      assert.ok(rendered, "the fixture must render into the lead's pane before the script can see it");

      const result = runDryRun();
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);

      // say() only echoes to stdout under a tty; execFileSync's pipe is not
      // one, so the log file - always written, tty or not - is the only
      // place "running agents: N" can be read back from a captured run.
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

// Fix round 1, todo 193 items 2-3 (opus finding 2, codex P1 1 / P2 5). Both
// still --dry-run only; neither needs a real kill to discriminate.
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

      // A dev server started by hive.yml's `processes:` block, not a worker -
      // this must never block a lead restart. If the allowlist regresses from
      // `kind = 'agent'` to `kind != 'lead'`, this row starts counting and the
      // assertion below goes red (a refusal, not a clean dry run).
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

      // project_id = projB.id, deliberately NOT projA - this row must not
      // count against projA's restart. Pre-189, refusal 2's query had no
      // project_id filter at all, so this would have counted and refused; if
      // that filter regresses, this goes red the same way.
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

// Fix round 1, todo 193 item 4 (codex's test finding: HIVE_REPO was always
// set in every scenario above, which overrides derivation entirely and would
// stay green even against a hardcoded, broken REPO). HIVE_REPO is
// deliberately absent from this scenario's env.
describe(
  "restart-lead.sh derives REPO from its own on-disk location when HIVE_REPO is unset",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("resolves the project registered at REPO's own path with no override", async () => {
      // Registered at REPO - the real checkout this suite runs from - but
      // only as a path STRING in this SCRATCH store; nothing here opens or
      // touches the live ~/.hive database, which has its own, unrelated
      // project row at the same path.
      const proj = insertProject("restart-lead-repo-derivation", REPO);
      const projSession = sessionName();
      await startRealLead(proj, REPO);
      after(() => cleanup(projSession));

      // REPO's real hive.yml (this checkout's own) does define a `lead:`
      // command, so REFUSAL 4 (todo 190) applies to THIS scratch project too
      // once PROJECT_PATH resolves to REPO - trust it here the same way
      // seedTrustedYml does for processes, or this test would hit that
      // refusal instead of the property it means to check.
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
      // No HIVE_REPO key at all - SCRIPT_DIR resolution is what has to find
      // its way back to REPO. A hardcoded or broken derivation (e.g. codex's
      // suggested REPO=/nonexistent mutation) makes resolve_project fail to
      // match ANY registered project, which refuses outright rather than
      // reaching this log line - that is the red this test goes to.
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

// Fix round 2, todo 195 (counselors round 2: opus finding 3, codex P1 4).
// Every test above sets HIVE_SESSION explicitly, which is exactly why the
// prior bash reimplementation of hive's session naming (data_dir_tag/
// session_name_for/canon_dir - deleted in this commit) went unnoticed: it
// hashed a trailing newline pwd's pipeline output carries, could never
// equal src/dataDir.ts's own tagFor(), and made every non-default
// HIVE_DATA_DIR run derive a session that did not exist. This suite's
// scratch store IS a non-default HIVE_DATA_DIR from hive's own
// perspective (dataDirTag() hashes it to a real, non-empty tag), so
// `sessionName()` here is already a hash-tagged name like
// "hive-<8hex>-main", not the bare "hive-main" the everyday default-store
// path would give - exactly the shape the deleted code could never
// reproduce, verified directly against it before deleting it.
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
        // No HIVE_SESSION key at all - tmux display-message on the store's
        // own pane is what has to find its way back to this exact session.
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);

        // Both occurrences (pre-kill resolution and post-restart
        // re-resolution) must name THIS real session. A still-broken
        // derivation refuses outright (no such session exists to scope
        // list-panes against); a derivation that fell back to some OTHER
        // live session would not match this exact, hash-tagged name.
        const marker = `session: ${projSession};`;
        const count = contents.split(marker).length - 1;
        assert.equal(count, 2, `expected "${marker}" twice (pre- and post-restart); log:\n${contents}`);

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane derived with no HIVE_SESSION override");
      },
      { timeout: 30000 },
    );
  },
);

// Todo 273 (topology-3c). `display-message -p -t <pane-id>` is AMBIGUOUS the
// instant the pane's window is linked into a second, grouped session - a real
// view session (viewSessionName(), src/tmux.ts) is exactly that. Measured
// against tmux 3.7b: it favors the MORE RECENTLY CREATED session of the
// group, which is the view here, not the base - and a view session can
// vanish (destroy-unattached) at any moment, so naming it as SESSION risks a
// false refusal or a false "no live pane" read later in the same run. This
// pins that resolve_lead_pane's fix (list-panes -a, filtered by the
// view-session suffix) survives exactly the condition that broke the old
// display-message-based derivation.
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

        // Grouped with the base (`new-session -t <base>`), the same
        // relationship a real view session has - created AFTER the base, so
        // it is the one tmux favors if the ambiguity this test exists for
        // still exists.
        const view = viewSessionName();
        execFileSync("tmux", ["new-session", "-d", "-t", `=${projSession}`, "-s", view]);
        after(() => {
          try {
            execFileSync("tmux", ["kill-session", "-t", `=${view}`]);
          } catch {
            // Already gone.
          }
        });

        const log = join(dirs.tmp, "restart-lead-view-ambiguity.log");
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);

        // Both occurrences (pre-kill resolution and post-restart
        // re-resolution) must name the BASE session, never the view.
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
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane despite the grouped view session");
      },
      { timeout: 30000 },
    );
  },
);

// Fix round 1, todo 193 item 1 (opus finding 1, codex P1 3 - the central
// defect this whole fix round exists for) plus item 1's session-survival and
// store-match requirements (opus findings 3 and 6, codex P1 2 and 4). Every
// scenario below runs the REAL script, no --dry-run, inside the isolated
// tmux server + scratch store this file already sets up - per test/CLAUDE.md
// and the plan pad's "THE LINE YOU DO NOT CROSS", the LIVE machine is never
// touched by any of this.
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

        // The decoy: split -b INTO THE SAME WINDOW as the lead, which puts it
        // AHEAD of the lead's pane in list-panes order - verified against a
        // throwaway tmux server before writing this test (split-window -b
        // reindexes the new pane to a lower pane_index than the pane it split
        // from). This is exactly counselors' scenario: a second pane in the
        // lead's own window, sorted first. The OLD resolve_lead_pane (first
        // window-name match wins) would have picked THIS pane and killed it;
        // that is the red this test goes to against the pre-189 script.
        const decoyPath = fakeClaude("sleep 600");
        const decoyPane = execFileSync("tmux", [
          "split-window", "-b", "-P", "-F", "#{pane_id}", "-t", leadPane, decoyPath,
        ]).toString().trim();

        // Split into lines and compare real indices, not substring position:
        // pane ids are not fixed-width ("%1" is a substring of "%10"), so
        // order.indexOf(decoyPane) < order.indexOf(leadPane) on the raw text
        // can pass or fail for the wrong reason once pane ids reach two
        // digits on a longer-lived server. Round 2, opus's "lower" section.
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
        // Both occurrences - pre-kill resolution AND post-restart
        // re-resolution - must have used the store, not just the first one.
        // Round 2, opus's "lower" section: a plain assert.match only proves
        // the substring appears somewhere, so a regression that broke ONLY
        // the second resolution (post `hive lead`) would still pass this.
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
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
        );
        assert.ok(gotHandoff, "the handoff prompt must land in the new lead pane");
        const decoyScreen = execFileSync("tmux", ["capture-pane", "-p", "-t", decoyPane]).toString();
        assert.doesNotMatch(decoyScreen, /Follow the standing process/, "the handoff must never land in the decoy's pane");
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

        // This repo's own ordinary shape: hive.yml's `processes:` block is
        // empty, so the lead's pane really is the only pane in the only
        // window of a fresh session - the one case where kill-pane, with no
        // placeholder, takes the window and the session down with it.
        const panesBefore = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_id}"]).toString().trim().split("\n");
        assert.equal(panesBefore.length, 1, `setup bug: expected exactly one pane, got: ${panesBefore.join(",")}`);
        const windowsBefore = execFileSync("tmux", ["list-windows", "-t", `=${projSession}`, "-F", "#{window_id}"]).toString().trim().split("\n");
        assert.equal(windowsBefore.length, 1, `setup bug: expected exactly one window, got: ${windowsBefore.join(",")}`);

        // A custom SESSION option, not a window or a pane, so it cannot
        // trivially survive by riding along on some OTHER window the way an
        // extra witness window would - and it would NOT be preserved by a
        // same-named session tmux creates fresh, the way `#{session_id}`
        // turned out not to discriminate either (verified against a
        // throwaway tmux server: with only ever one session on a server,
        // destroying it and creating a new one of the same name reuses id
        // $0, and `#{session_created}`'s one-second resolution can
        // coincidentally match a kill-then-recreate that happens inside the
        // same wall-clock second). A session option set before the restart
        // and read back after is the one thing here that positively proves
        // "same session object", not merely "a session by this name exists
        // again": a fresh `new-session` never carries a prior session's
        // custom options, verified directly (not just reasoned about)
        // against a throwaway server before writing this assertion.
        // No `=` prefix here, unlike every other -t in this file: verified
        // directly against a throwaway tmux server that set-option/
        // show-options refuse an exact-match session target ("no such
        // session: =name") even when the plain name resolves fine on the
        // identical server - unlike list-panes/list-windows/capture-pane,
        // which all accept it. A tmux quirk, not a copy-paste inconsistency.
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

        // IMMUNE to the placeholder window's own generated data: the script
        // names it "restart-lead-placeholder-$$" (its own shell pid,
        // scripts/restart-lead.sh), a value this test never controls or
        // predicts. The pattern is deliberately unanchored to that suffix -
        // it only asks whether the fixed "restart-lead-placeholder" prefix
        // is gone - so the pid cannot cause a false pass here either way. A
        // future caller matching the FULL name (prefix plus pid) would have
        // to thread the pid through, which is exactly the trap this avoids.
        const windowsAfter = execFileSync("tmux", ["list-windows", "-t", `=${projSession}`, "-F", "#{window_name}"]).toString();
        assert.doesNotMatch(windowsAfter, /restart-lead-placeholder/, "the placeholder must be removed once a live lead pane is confirmed, on the success path");

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane even in the single-pane/single-window case");
      },
      { timeout: 30000 },
    );
  },
);

// Fix round 2, todo 198. Covers: the skip-the-kill path (194), the
// UNTRUSTED lead: direction (197), two running kind='lead' rows (194's
// LIMIT 1), and the session surviving when claude never becomes ready
// (196 item 2-3). The production detached-re-exec path is covered
// separately below - it needs TMUX_PANE set, which every test above
// deliberately avoids (isolateTmux() clears it).
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

        // No `hive lead` run at all here - no agents row, no tmux session.
        // If the code under test were reverted to always requiring a pane
        // to kill, this would refuse instead of proceeding.
        const log = join(dirs.tmp, "restart-lead-no-row.log");
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir, HIVE_SESSION: projSession }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);
        assert.match(contents, /nothing to kill; will just run hive lead/, "must recognize there is no row to resolve");
        assert.doesNotMatch(contents, /\bkilling %/, "must never call kill-pane when there is no live pane");

        const newPane = leadRow(db, proj.id).tmux_target;
        assert.ok(newPane, "hive lead must have produced a live lead row");
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
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

        // Kill the pane OUTSIDE the script, leaving the row stale (status
        // still 'running', tmux_target still naming the now-dead pane) -
        // the canonical trigger this whole path exists for: the lead died
        // without cmdLead ever recording its replacement.
        execFileSync("tmux", ["kill-pane", "-t", deadPane]);

        const log = join(dirs.tmp, "restart-lead-dead-row.log");
        const result = runScript(["--delay", "0"], { HIVE_REPO: dir, HIVE_SESSION: projSession }, log);
        const contents = readFileSync(log, "utf8");
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}\nlog:\n${contents}`);
        assert.match(contents, /nothing to kill; will just run hive lead/, "must recognize the row's pane is dead");
        assert.doesNotMatch(contents, /\bkilling %/, "must never call kill-pane against a pane that is already dead");

        const newPane = leadRow(db, proj.id).tmux_target;
        // NOT asserting newPane !== deadPane: if this was the only session
        // on the shared scratch tmux server at the moment it died, the
        // server itself restarts and pane ids resume from %0 - a
        // coincidental match here is possible and does not indicate
        // anything was actually reused. Liveness and the handoff below are
        // the real assertions.
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
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
      // startRealLead below runs BEFORE this file exists, so the initial
      // lead pane is an ordinary claude (untouched by hive.yml at all) -
      // this test is about the SCRIPT's own preflight, not what `hive lead`
      // itself does with an untrusted command.
      const proj = insertProject("restart-lead-untrusted", dir);
      const projSession = sessionName();
      await startRealLead(proj, dir);
      after(() => cleanup(projSession));

      writeFileSync(join(dir, "hive.yml"), "lead: claude --model opus\n");
      // Deliberately NOT seeding command_trust - this is the untrusted case.

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

      // A second, stray kind='lead' row for the SAME project - src/cli.ts
      // documents this can happen after an older server's rename-repair
      // path leaves two (the real row keeps name='lead'; idx_agents_running_
      // name is unique on (project_id, name) for running rows, so the stray
      // one - as it would be in practice - carries a DIFFERENT name). Its
      // pane id is not a real pane, so without LIMIT 1 the two-row-wide
      // $row would never exact-match anything in list-panes at all (a
      // two-line string cannot equal any single pane_id line), and
      // resolution would report "nothing to kill" even though the real
      // lead pane is right there and live.
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

        // A claude that starts but never renders the input-box marker - the
        // production shape of "a bad trusted lead: command, a missing
        // binary in the tmux server's own env, or a crash right after
        // launch" (todo 196's own framing). Written to hive.yml as an
        // ABSOLUTE PATH and trusted explicitly, so the SERVER spawns
        // exactly this binary regardless of PATH - the initial lead pane
        // above was already launched before this file existed, so refusal
        // 1 (which only inspects that pane's already-rendered screen) is
        // unaffected by any of this.
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

        // The session must still exist, and the placeholder must NOT have
        // been removed on this failure path (todo 196 item 3) - it is the
        // only anchor keeping a single-pane/single-window session alive
        // once the new (never-ready) lead pane is the only other occupant
        // of its window and something later needs it gone too.
        const sessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"]).toString();
        assert.ok(sessions.includes(projSession), `session ${projSession} must survive; sessions:\n${sessions}`);
        const windows = execFileSync("tmux", ["list-windows", "-t", `=${projSession}`, "-F", "#{window_name}"]).toString();
        assert.match(windows, /restart-lead-placeholder/, "the placeholder must survive a failure past the kill, as a deliberate signal");
      },
      { timeout: 30000 },
    );
  },
);

// Fix round 2, todo 198's own framing of "the biggest gap": every test above
// runs with TMUX_PANE cleared (isolateTmux() does this at module load), so
// every one of them takes the INLINE branch. The detached re-exec under
// nohup - re-exec, exit, and a background child that outlives the parent -
// is how this script actually runs in every real invocation, and nothing
// above ever enters it. Codex round 2's own framing is the one to hold onto:
// make that branch return without spawning a child, and every real restart
// becomes a silent no-op while every other test in this file stays green.
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
        // TMUX_PANE set to the exact pane the script will resolve as the
        // lead - simulating "this script is running inside the pane it is
        // about to kill", the ordinary case per the script's own header
        // comment, not an edge case.
        const result = runScript(
          ["--delay", "0"],
          { HIVE_SESSION: projSession, HIVE_REPO: dir, TMUX_PANE: leadPane },
          log,
        );
        // The FOREGROUND parent must return quickly, having only re-exec'd
        // a detached child - not have carried out the restart itself. If
        // the detached-branch guard broke and returned without spawning a
        // child at all (codex round 2's own framing), this call would
        // still exit 0 having done nothing, and nothing checked below would
        // ever become true.
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

        // The detached child runs independently of the parent that already
        // returned; poll the log for it to finish rather than assuming any
        // fixed delay (the log is the natural witness here, since the
        // parent's own stdout/stderr told us nothing about the child).
        const completed = await until(
          () => readFileSync(log, "utf8").includes("prompt sent; restart complete"),
          10000,
        );
        assert.ok(completed, `detached child never completed the restart; log:\n${readFileSync(log, "utf8")}`);

        const panesAfter = execFileSync("tmux", ["list-panes", "-t", `=${projSession}`, "-F", "#{pane_id}"]).toString();
        assert.ok(!panesAfter.includes(leadPane), "the old lead pane must be gone - the detached child actually killed it");

        const newPane = leadRow(db, proj.id).tmux_target;
        const gotHandoff = await until(() =>
          execFileSync("tmux", ["capture-pane", "-p", "-t", newPane]).toString().includes("Follow the standing process"),
        );
        assert.ok(gotHandoff, "the handoff must land in the new lead pane, delivered by the detached child");
      },
      { timeout: 30000 },
    );
  },
);

// Fix round 1, todo 193 item 5 (both counselors' test sections). No tmux or
// store needed - this is a pure text comparison between the two copies.
describe("restart-lead.sh's dialog/input-box markers stay in sync with src/tmux.ts", () => {
  it("CHOICE_DIALOG and INPUT_BOX copy src/tmux.ts's own regex source exactly", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const tmuxSource = readFileSync(join(REPO, "src", "tmux.ts"), "utf8");

    const scriptChoice = script.match(/^CHOICE_DIALOG='(.*)'$/m)?.[1];
    const scriptInputBox = script.match(/^INPUT_BOX='(.*)'$/m)?.[1];
    const tsChoice = tmuxSource.match(/const CHOICE_DIALOG = \/(.*)\/;/)?.[1];
    const tsInputBox = tmuxSource.match(/const INPUT_BOX_PRESENT = \/(.*)\/;/)?.[1];

    // If any extraction comes back undefined, the regex above is stale
    // against a reformatted source line, not evidence the markers agree -
    // fail loudly rather than let two undefineds compare equal.
    assert.ok(
      scriptChoice && scriptInputBox && tsChoice && tsInputBox,
      `could not extract one of the four markers: script=[${scriptChoice}/${scriptInputBox}] ts=[${tsChoice}/${tsInputBox}]`,
    );
    assert.equal(scriptChoice, tsChoice, "CHOICE_DIALOG has drifted from src/tmux.ts's own regex");
    assert.equal(
      scriptInputBox,
      tsInputBox,
      "INPUT_BOX has drifted from src/tmux.ts's own INPUT_BOX_PRESENT - issue #30 is this exact drift, discovered after the pane was already dead",
    );
  });
});

// Todo 392 round 1, F2. CLAUDE_PANE_CMD has no src/tmux.ts counterpart - it
// is a process-identity signal this script alone needs, since hive's own TS
// code never has to guess a pane's identity from scratch (it always starts
// from the pane a STORE row already names). What is worth pinning is its own
// SHAPE: a real claude reports its version as pane_current_command for its
// entire life - idle, busy, and sitting on a real dialog, all measured live
// against claude 2.1.231 - and that must match, while an ordinary shell or
// tool name must not. bash's own grep -qE interprets this, not a JS regex
// reinterpretation of it, for the same reason the view-session test below
// does: the two dialects can silently disagree on what "looks like a match"
// means.
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

// Todo 392 round 1, F2. Refusal 1 used to OR CHOICE_DIALOG in unguarded, as
// proof a pane is claude: "Esc to cancel" alone was implausible in a bare
// shell's scrollback, but D3 (todo 392) widened CHOICE_DIALOG with "Would
// you like to proceed" for the plan-approval dialog, and that IS ordinary
// installer/CLI prompt text.
//
// This does NOT reproduce the exact scroll-depth exploit: refusal 1 reads
// -S -30, refusal 3's awaiting_choice reads -S -18 (matching src/tmux.ts's
// own tailCaptureLines()), so a real kill needed the matching text to sit
// PAST refusal 3's narrower window while staying inside refusal 1's wider
// one - refusal 3 would have caught this exact fixture too, since the text
// is close to the bottom on both reads, and the two windows are not
// reproduced far enough apart here to tell them apart. What this DOES prove,
// and has to prove regardless of that depth: refusal 1 must be correct ON
// ITS OWN, not merely lucky that refusal 3 happens to also fire on the same
// condition it does - the assertion on WHICH message comes back is what
// makes that the actual claim, not just "the script refused eventually".
describe(
  "restart-lead.sh's refusal 1 no longer trusts CHOICE_DIALOG text as proof of claude identity (todo 392 round 1, F2)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("refuses a bare shell whose scrollback happens to carry ordinary installer prompt text", async () => {
      const dir = mkdtempSync(join(dirs.tmp, "proj-not-claude-"));
      const proj = insertProject("restart-lead-not-claude", dir);
      const projSession = sessionName();
      after(() => cleanup(projSession));

      // A REAL pane, but genuinely not claude: a plain `sh` printing text an
      // ordinary installer might. pane_current_command for this pane is "sh"
      // - it never matches CLAUDE_PANE_CMD - and INPUT_BOX has nothing to
      // match either. This text was a real CHOICE_DIALOG alternative when
      // this test was written (round 1's D3 widening); round 2's M2 swapped
      // that alternative for "ctrl+g to edit in", so it is ordinary,
      // non-matching prose now - which still proves the point, since
      // refusal 1 stopped consulting CHOICE_DIALOG at all in round 1 (F2)
      // and this asserts identity is refused on SCREEN CONTENT generally,
      // not on this one string surviving in the regex.
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

// Todo 273. The two copies cannot be compared as TEXT the way CHOICE_DIALOG/
// INPUT_BOX are above: bash's ERE ('view-[0-9]+$', via grep -vE) and the TS
// regex source (isViewSessionName, src/tmux.ts) are two different dialects
// for the identical shape, so a literal string match would fail even with no
// drift at all. Compare BEHAVIOUR instead, across a shared fixture set - the
// same guarantee CHOICE_DIALOG/INPUT_BOX give, reached the only way available
// once the two sides cannot share source text.
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
      // Issue #117 counselors: freeViewSessionName bumps past a live
      // collision with a numeric suffix, so a bumped view still has to read
      // as a view here - the EXCLUDE direction is the dangerous one, since
      // this filter's whole job is telling a view apart from the durable
      // base session it is trying to isolate.
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
