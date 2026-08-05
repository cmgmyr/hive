import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, until } from "./helpers.mjs";

// Lane A step 2 (plan-lane-a-cmdlead-characterisation, pad 73). The audit
// posted on todo 258 found three gaps in the existing suite's coverage of
// cmdLead's restart path (src/cli.ts):
//   - behaviour 1's "claims the session's own INITIAL window, no stray
//     shell window left over" half (the pane-id-recorded half is already
//     pinned by test/lead-pane-target.test.mjs and test/lead-identity.test.mjs);
//   - behaviour 2 in full: a restart with the lead's own pane still
//     genuinely alive reuses that SAME pane rather than creating a second;
//   - behaviour 4 in full: unknown liveness (a foreign tmux_socket on the
//     row) is treated as "not still there", so `hive lead` proceeds with a
//     fresh pane rather than refusing or - the actual defect this pins
//     against - silently reusing a pane on a server this process cannot see.
// Behaviours 3, 5 and 6 are already pinned elsewhere (test/lead-pane-target
// .test.mjs and test/lead-identity.test.mjs STEP 1c/1b) and are out of scope.

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

// -s, not -a: test/CLAUDE.md forbids list-panes -a (it ignores -t and reads
// the whole server). -s -t =<session> is the scoped way to see every pane
// across every window of ONE session.
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

// Fires ONLY when BEHAVIOUR 1's wait for the launch marker times out -
// costs nothing on the passing path, and this test has already burned two
// ubuntu CI round-trips (~4 minutes each) on the same failure guessed at
// twice. Every item here is something the failing run could not otherwise
// answer: whether the fake dir actually reached the tmux SERVER's PATH
// (not just this test process's own), what tmux was ASKED to run versus
// what it reports running now, the pane's own rendered output (a lookup
// failure puts "command not found" right there), and the fake claude
// script's permissions and shebang - a Node writeFileSync mode and Linux's
// exec bit are not the same question as macOS's.
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

describe("cmdLead's restart path - the audit's gaps", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it(
    "BEHAVIOUR 1 (half): a fresh session claims tmux's own initial window, not a second one, and no idle shell survives",
    async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      // A launch marker, not `pane_current_command`, proves the lead
      // command actually ran. `pane_current_command` is a SAMPLE of what
      // tmux reports as the pane's foreground process right now, derived
      // differently on macOS and Linux - and the fake claude here runs
      // `sleep 600` as a CHILD of the wrapper's own `sh -c`, not via `exec`
      // (see makeFakeClaude, test/helpers.mjs), so the two platforms can
      // legitimately disagree about which process in that chain counts as
      // "current". This project already has a rule for exactly this shape
      // (test/CLAUDE.md, "assert against a RECORD, never a SAMPLE") -
      // matches test/lead-data-dir.test.mjs's own marker-file arrangement
      // rather than inventing a new one. Do NOT "fix" this by adding `exec`
      // to the fake claude to make `pane_current_command` read "sleep" -
      // that only makes the fixture conform to a platform-dependent probe,
      // leaving the same trap for the next reader; `exec` here (below) is
      // used for its own reason (no zombie shell), independent of any probe.
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
      const session = sessionName(project.id);
      // A tmux SERVER with no sessions left exits, and the next one to start
      // renumbers windows from @0 - measured directly: an earlier version of
      // this test killed only the probe session, got window id 0 back for
      // both the probe and the lead, and the assertion below could not tell
      // "claimed the initial window" from "got a fresh server". A second,
      // unrelated session kept alive for the probe's duration keeps the
      // server (and its window-id counter) alive across the probe's own
      // kill-session, the same way STEP 1c's own comments describe.
      // The keepalive is the first tmux command in this test, so it is what
      // STARTS the server - and tmux copies its own process environment into
      // the server's global environment at that moment, once, for the
      // server's whole lifetime. A later session (this test's real one,
      // opened from the CLI child below) only overrides the specific
      // variables `update-environment` names, which excludes PATH by
      // default; PATH for every session on this server, including the CLI
      // child's own, is answered from THIS call's env, not the creating
      // client's. Measured on ubuntu CI (run 31013486469): without this, the
      // lead's respawn-pane runs a `claude` neither the server nor the fake
      // dir on this test process's own PATH can resolve, so
      // BEHAVIOUR 1 timed out waiting for a pane that never ran it - passed
      // on macOS only because of a platform default this project does not
      // control, exactly the shape F1 exists to remove. Setting PATH here
      // fixes it BY CONSTRUCTION rather than by inheritance: it does not
      // depend on whichever process happens to create the server first,
      // since this call always is.
      const keepaliveSession = `${session}-keepalive`;
      execFileSync("tmux", ["new-session", "-d", "-s", keepaliveSession], {
        stdio: "ignore",
        env: { ...process.env, PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      });
      // Declared here, not inside the try, so the finally below can clean it
      // up even if it is never assigned - a throw between this line and the
      // probe's own kill-session (windowIdOf, line ~159, is real tmux I/O
      // and can throw) must not leave the probe session orphaned.
      const probeSession = `${session}-probe`;
      try {
        // Window ids (@N) are allocated once, monotonically, per tmux
        // SERVER - never reused, never per-session (measured against a
        // throwaway tmux server before writing this: killing a window and
        // making a new one in the same session skips straight to the next
        // global id, and a second session on the same server continues the
        // same counter). Probing with a throwaway session pins "the next id
        // this server will ever hand out" BEFORE `hive lead` runs, which is
        // the only way to know what "the session's own initial window"
        // should be without a session already existing to inspect it - a
        // fresh session not existing yet is the whole premise of this case.
        execFileSync("tmux", ["new-session", "-d", "-s", probeSession], { stdio: "ignore" });
        // ":" suffix, not a bare "=<session>": measured directly against a
        // throwaway tmux server that display-message -p's own format
        // substitution comes back EMPTY (exit 0, not an error) for an
        // exact-match session target with no window/pane part - list-panes,
        // list-windows and capture-pane all accept the bare form fine, but
        // this one format-printing path does not. A trailing colon keeps
        // the exact-match semantics and gets a real answer back.
        const probeWindowId = windowIdOf(`=${probeSession}:`);
        execFileSync("tmux", ["kill-session", "-t", `=${probeSession}`], { stdio: "ignore" });

        const result = await runCli(["lead"], cliOpts);
        assert.equal(result.code, 0, result.stderr);

        const row = leadRow(db, project.id);
        const leadWindowId = windowIdOf(row.tmux_target);

        // THE MUTATION THIS FAILS AGAINST: dropping claimInitialWindow's
        // window claim so the fresh-session branch creates its own
        // new-window instead of respawning into the session's own initial
        // one (pad 73's mutation 1). `new-session` always allocates one
        // window id for the session's default shell before hive gets a say;
        // a second `new-window` call consumes a SECOND id. A plain
        // window-count check cannot tell "claimed the initial window" apart
        // from "made a second window and killed the first", because both
        // end up with exactly one window in the end - the id, allocated in
        // creation order and never reused, is the one thing that still
        // tells them apart afterwards.
        assert.equal(
          leadWindowId,
          probeWindowId + 1,
          "the lead's window must be the very next window id after the probe - " +
            "the session's OWN initial window, not a second one made after it",
        );

        // The behaviour's other half, asserted directly rather than only
        // inferred from the id: exactly one window in the session, exactly
        // one pane in it, and that pane actually ran leadCommand rather
        // than sitting idle as an unclaimed default shell.
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
        // probeSession is normally already killed above (line ~160); listed
        // again here so a throw before that kill-session runs (e.g.
        // windowIdOf) does not leave it orphaned. cleanup() no-ops on an
        // already-gone session.
        cleanup(session, keepaliveSession, probeSession);
      }
    },
  );

  it(
    "BEHAVIOUR 2: a restart with the lead's own pane still alive reuses that SAME pane, and creates no second one",
    async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      // A RECORD of every launch, not a final-state sample: the row and the
      // pane list after both runs only show what tmux/the DB look like NOW,
      // and a rewrite that split a fresh pane, launched a second claude,
      // then noticed the original was still alive and killed its own split
      // would leave both looking identical to "reused the same pane" -
      // passing this test's other assertions while still violating "creates
      // no second one". Each claude launch appends its own line here, so a
      // create-then-kill still leaves the evidence a final snapshot cannot.
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
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);

        const before = leadRow(db, project.id);
        const pane = before.tmux_target;
        const windowTarget = windowTargetOf(pane);
        const panesBefore = panesIn(windowTarget);
        assert.deepEqual(panesBefore, [pane], "sanity check: exactly one pane exists before the restart");

        // Nothing is killed or altered in between - the plain idempotent
        // case, which nothing in the existing suite drives twice in a row
        // without perturbing the row or the pane first.
        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr);

        const after = leadRow(db, project.id);
        assert.equal(after.id, before.id, "the same agents row must be reused");
        assert.equal(after.actor_id, before.actor_id);
        assert.equal(after.status, "running");
        // THE ASSERTION THIS BEHAVIOUR IS: what did NOT happen. Same pane
        // id, not merely "a live pane exists".
        assert.equal(after.tmux_target, pane, "the SAME pane must be recorded, not a fresh one");

        const panesAfter = panesIn(windowTarget);
        assert.deepEqual(panesAfter, panesBefore, "no second pane may be created in the window");

        // THE MUTATION THIS FAILS AGAINST: forcing the found-window branch
        // to always split a fresh pane, skipping the `if (stillThere)` reuse
        // entirely (not one of pad 73's five - those target behaviours
        // 1/3/4/5, and none of them changes what happens when the pane is
        // genuinely alive: mutation 2 only matters for a DEAD previousTarget,
        // and mutation 3 only matters for UNKNOWN liveness). Skipping the
        // reuse branch outright makes `after.tmux_target` differ from `pane`
        // and leaves two panes in the window - both assertions above go red.
        assert.ok(
          isPaneTarget(after.tmux_target),
          `expected a pane id (%N) after the restart, got ${after.tmux_target}`,
        );

        // runCli resolves once the CLI CHILD exits, not once the pane it
        // told tmux to respawn/split has actually run its shell - `hive
        // lead` hands tmux a command and returns; the fake claude's `echo
        // ... && exec sleep 600` runs asynchronously in the pane afterward.
        // Reading the log immediately races that write. Waiting for the
        // recorded pane to actually reach "sleep" (the same signal BEHAVIOUR
        // 1 waits on) means its `echo` already ran, since `exec` replacing
        // the shell with sleep cannot happen before the `&&` before it does.
        const settled = await until(
          () => sessionPanes(session).some(([id, , cmd]) => id === after.tmux_target && cmd === "sleep"),
          10000,
        );
        assert.ok(settled, `expected ${after.tmux_target} to be running leadCommand before reading the launch log`);

        // THE ASSERTION THE FINAL-STATE CHECKS ABOVE CANNOT MAKE: exactly
        // one claude process was ever launched across both `hive lead`
        // calls, not merely that exactly one is running now. THE MUTATION
        // THIS FAILS AGAINST: mutation 6 (skip the `if (stillThere)` reuse,
        // always split fresh) now also fails HERE even in a hypothetical
        // rewrite that cleaned up its own extra pane afterward - the launch
        // log has two lines the moment a second `hive lead` call ever starts
        // a second claude, regardless of what the row or pane list look
        // like by the time this test reads them.
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
    "BEHAVIOUR 4: unknown liveness (a foreign tmux_socket on the row) is treated as not-still-there, so hive lead proceeds with a fresh pane",
    async () => {
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const claudePath = fakeClaude("sleep 600");
      const projectDir = newProjectDir();
      const cliOpts = {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      };
      const project = db
        .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
        .get("lead-unknown-liveness-test", projectDir);
      const session = sessionName(project.id);
      try {
        const first = await runCli(["lead"], cliOpts);
        assert.equal(first.code, 0, first.stderr);

        const before = leadRow(db, project.id);
        const originalPane = before.tmux_target;
        const windowTarget = windowTargetOf(originalPane);

        // Manufacture the unknown case by writing a foreign recorded socket
        // onto the row - previousSocket's own source (ensureLeadRow's
        // `existing.tmux_socket`), read straight off the row rather than
        // derived - NOT by tearing down tmux. The pane stays genuinely
        // alive, on this same real isolated server; only the DATABASE'S
        // claim about which socket it lives on is now wrong.
        // foreignSocket() (src/tmux.ts) treats any non-empty, non-matching
        // value as "this row's last-known pane belongs to a server this
        // process cannot honestly judge", and rowLive() folds that into
        // null rather than true or false.
        db.prepare("UPDATE agents SET tmux_socket = ? WHERE id = ?").run(
          "/nonexistent/foreign/tmux/tmux-501/default",
          before.id,
        );

        const second = await runCli(["lead"], cliOpts);
        assert.equal(second.code, 0, second.stderr, "unknown liveness must not refuse the restart");

        const after = leadRow(db, project.id);
        // THE MUTATION THIS FAILS AGAINST: dropping the
        // `rowLive(previousSocket, previousTarget) === true` conjunct from
        // stillThere's expression ENTIRELY (pad 73's mutation 3 - "ignore
        // rowLive"), not just the `=== true` comparison. Verified directly:
        // trimming only the `=== true` and leaving bare
        // `rowLive(previousSocket, previousTarget)` in the && chain is a
        // NO-OP, because Liveness is `boolean | null` and both `null` and
        // `false` already coerce falsy in a boolean context, exactly like
        // `true`/`false` do against `=== true`. So `=== true` is
        // documentation of the deliberate "unknown reads as not still
        // there" bias, not what enforces it - falsiness does the actual
        // work, and enforces it just as well for a `Liveness` return of
        // `boolean | null` as it would with the comparison removed. Worth
        // knowing before lane 3 touches this: a future `rowLive` returning
        // some OTHER falsy-looking value that is not `false`/`null` (a
        // string, an object) would flip the bias silently with `=== true`
        // still sitting there looking like a guard. Dropping the whole
        // conjunct is the mutation that actually removes the check: without
        // it, stillThere only asks whether previousTarget is a pane id
        // still listed in the found window, which is true here (the pane
        // is genuinely alive) - so the mutated code would wrongly REUSE the
        // original pane despite the foreign socket, exactly the "hive
        // types into a stranger's pane" class of bug this behaviour's own
        // deliberate bias exists to avoid.
        assert.notEqual(after.tmux_target, originalPane, "a fresh pane must be recorded, not the foreign-socket one");
        assert.ok(isPaneTarget(after.tmux_target), `expected a pane id (%N), got ${after.tmux_target}`);

        // Proceeding, not refusing, is the documented bias: the original
        // pane is left alive and untouched rather than killed or reclaimed.
        assert.ok(paneAlive(originalPane), "the original, genuinely-alive pane must survive untouched");
        const panesAfter = panesIn(windowTarget);
        assert.deepEqual(
          panesAfter.sort(),
          [originalPane, after.tmux_target].sort(),
          "both the orphaned original pane and the fresh one must be present in the window",
        );

        // The CAS heals tmux_socket back to this process's own real socket,
        // not left naming the foreign one this test seeded.
        assert.equal(after.tmux_socket, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR));
      } finally {
        cleanup(session);
      }
    },
  );
});
