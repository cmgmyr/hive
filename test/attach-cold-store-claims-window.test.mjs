import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, panesIn, runCli, scratchDirs, tmux, windowOwners } from "./helpers.mjs";

// Pad 79, T5(b). `hive attach` on a cold store calls ensureSession and used
// to never claim the window it just created: no @hive-project-id stamp, no
// rename. That window was invisible to findProjectWindow forever after, and
// a later `hive lead` for the same project - the only other place that ever
// claims a fresh session's initial window - always finds started.created ===
// false by then (the session already exists) and falls to its OWN
// read-then-create, stamping a SECOND window and leaving the attach's window
// an orphan. A state bug, not a crash: nothing throws, the store and tmux
// just accumulate an unstamped window per cold `hive attach`.

const { hasTmux, cleanup } = isolateTmux("hive attach claims the window it creates on a cold store (T5b)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { findProjectWindow, sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "cmdAttach claims the window ensureSession creates on a cold store",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const session = sessionName();
    let project;

    before(async () => {
      const init = await runCli(["init"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(init.code, 0, init.stderr);
      project = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir);
    });

    after(() => cleanup(session));

    it("stamps the window it creates with the project's ownership, rather than leaving a bare shell", async () => {
      const attached = await runCli(["attach"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);
      const window = findProjectWindow(session, project.id);
      assert.ok(window, "the window hive attach created must carry the project's @hive-project-id stamp");
    });

    it("a later hive lead adopts that same window instead of creating a second one", async () => {
      const claimedByAttach = findProjectWindow(session, project.id);
      assert.ok(claimedByAttach, "fixture check: the previous case must have left a stamped window to adopt");

      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);

      const owners = windowOwners(session).filter(([, id]) => Number(id) === project.id);
      assert.equal(
        owners.length,
        1,
        `exactly one window may carry this project's stamp - a second one is the orphan accumulating, got: ${JSON.stringify(owners)}`,
      );
      assert.equal(
        owners[0][0],
        claimedByAttach.split(":")[1],
        "hive lead must land in the SAME window hive attach already claimed, not a fresh second one",
      );

      const row = leadRow(db, project.id);
      assert.ok(
        panesIn(claimedByAttach).includes(row.tmux_target),
        "the lead's own pane must be in the window hive attach claimed",
      );
    });
  },
);

// PR gate finding on the first version of the fix above. That version only
// handled a TRULY cold store (ensureSession creates the session, so
// started.created is true and its first window is the one to claim). It
// missed the OTHER way cmdAttach can reach a project with no window: the
// session already exists, carrying only OTHER projects' windows, because
// their `hive lead` ran first and this one never has. Gated on
// started.created alone, that case fell straight through: in tmux,
// resolveInTmuxTarget got `window: undefined`, its `!windowId` returned
// null, and attach() did nothing at all - no tmux command, no output, exit
// 0. Outside tmux, resolveAttachTarget's conditional select-window spread
// just dropped, landing the human on a view showing whatever base's CURRENT
// window happened to be - plausibly another project's, the exact
// pop-into-a-stranger's-tab failure this whole design exists to prevent.
describe(
  "hive attach also claims a window when the store is WARM but this project has none (PR gate finding)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const session = sessionName();
    const otherDir = mkdtempSync(join(dirs.tmp, "attach-warm-other-"));
    const missingDir = mkdtempSync(join(dirs.tmp, "attach-warm-missing-"));
    const thirdDir = mkdtempSync(join(dirs.tmp, "attach-warm-third-"));
    let otherProject;
    let missingProject;
    let thirdProject;
    let otherWindowBefore;

    before(async () => {
      const initOther = await runCli(["init"], { cwd: otherDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(initOther.code, 0, initOther.stderr);
      otherProject = db.prepare("SELECT id FROM projects WHERE path = ?").get(otherDir);

      // Warms the session with a DIFFERENT project's lead, so by the time
      // this describe's own cases attach, the session exists and already
      // carries a window - just not one stamped for the project under test.
      const claude = fakeClaude("sleep 600");
      const led = await runCli(["lead"], {
        cwd: otherDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(led.code, 0, led.stderr);
      otherWindowBefore = findProjectWindow(session, otherProject.id);
      assert.ok(otherWindowBefore, "fixture check: the other project must already have a window before these cases run");

      const initMissing = await runCli(["init"], { cwd: missingDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(initMissing.code, 0, initMissing.stderr);
      missingProject = db.prepare("SELECT id FROM projects WHERE path = ?").get(missingDir);

      const initThird = await runCli(["init"], { cwd: thirdDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(initThird.code, 0, initThird.stderr);
      thirdProject = db.prepare("SELECT id FROM projects WHERE path = ?").get(thirdDir);
    });

    after(() => cleanup(session));

    it("fixture check: the session already exists and carries no window for either project under test", () => {
      assert.equal(findProjectWindow(session, missingProject.id), undefined, "must start with no window to claim");
      assert.equal(findProjectWindow(session, thirdProject.id), undefined, "must start with no window to claim");
    });

    it("outside tmux: creates and stamps its OWN window, leaves the other project's untouched, and the printed hint selects the NEW window", async () => {
      const attached = await runCli(["attach"], {
        cwd: missingDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { TERM_PROGRAM: "" },
      });
      assert.equal(attached.code, 0, attached.stderr);

      const window = findProjectWindow(session, missingProject.id);
      assert.ok(window, "hive attach must create and stamp a window for a project the warm session has none for");

      assert.equal(
        findProjectWindow(session, otherProject.id),
        otherWindowBefore,
        "the other project's own window must be untouched by this project's attach",
      );

      assert.match(
        attached.stdout,
        new RegExp(`select-window -t \\S*:${window.split(":")[1]}\\b`),
        `the printed hint must select the NEW window - not silently drop select-window, and not point at another project's; stdout:\n${attached.stdout}`,
      );
    });

    it("in tmux: actually moves the caller's own session rather than silently doing nothing (the gate's exact finding)", async () => {
      // Fakes a pane's TMUX the same way test/attach-caller-session.test.mjs
      // does: a real view session grouped with base, with the caller's TMUX
      // env pointed at it, so a genuine tmux command's effect (the view's
      // current window moving) is observable with no real client attached.
      const view = `${session}-warm-view`;
      tmux("new-session", "-d", "-t", `=${session}`, "-s", view);
      const socket = tmux("display-message", "-p", "#{socket_path}");
      const pid = tmux("display-message", "-p", "#{pid}");
      const viewId = tmux("list-sessions", "-F", "#{session_name} #{session_id}")
        .split("\n")
        .find((row) => row.startsWith(`${view} `))
        ?.split(" ")[1]
        .replace("$", "");
      assert.ok(viewId, "the view session must have an id for this fixture to fake a pane's TMUX");

      try {
        const attached = await runCli(["attach"], {
          cwd: thirdDir,
          dataDir: dirs.dataDir,
          tmp: dirs.tmp,
          env: { TMUX: `${socket},${pid},${viewId}` },
        });
        assert.equal(attached.code, 0, attached.stderr);

        const window = findProjectWindow(session, thirdProject.id);
        assert.ok(window, "hive attach must create and stamp a window for this project even reached from inside tmux");

        const current = tmux("list-windows", "-t", `=${view}`, "-F", "#{window_active} #{window_id}")
          .split("\n")
          .find((row) => row.startsWith("1 "))
          ?.slice(2);
        assert.equal(
          current,
          window.split(":")[1],
          "a real tmux command must have moved the caller's own session to the new window - " +
            "the old bug returned having done nothing at all, silently, exit 0",
        );
      } finally {
        cleanup(view);
      }
    });
  },
);
