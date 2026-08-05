import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, panesIn, runCli, scratchDirs, tmux, windowFor } from "./helpers.mjs";

// Todo 276 (counselors opus #2). cmdLead used to consume window membership as
// a BICONDITIONAL: a lead pane that was not a member of the project's stamped
// window read as "gone", with rowLive never consulted on that path, so a live
// lead pane that had merely MOVED got a second claude split in beside it -
// both under one HIVE_AGENT_ID, both writing hook rows, which is the exact
// damage cmdLead's CAS exists to prevent, arriving through a door the CAS
// cannot see (one process records both panes, so nothing races).
//
// `tmux break-pane` is the reachable way in and needs no upgrade to construct:
// it is how you get the lead full-screen. Its new window carries no ownership
// stamp; the old window keeps one for as long as anything else holds it open.
//
// The direction test/lead-window-ownership.test.mjs pins is the OPPOSITE one
// (a stale target pointing into ANOTHER project's window must still be
// refused), and both must hold at once: liveness is primary now, ownership is
// the exclusion. Neither file makes the other redundant.

const { hasTmux, cleanup } = isolateTmux("the moved-lead-pane test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

// Panes in this session whose start command is the fake claude. The lead is
// the only thing launched that way here, so this counts LEADS - the fact the
// finding is about ("a SECOND claude split in beside it"), which neither the
// agents row nor a pane count can state on its own: the row names one pane by
// definition, and a pane count cannot say what is running in them.
//
// Never assert this is 1 without first asserting the baseline is 1 too. A
// format tmux answered empty for would make every "exactly one" assertion
// here pass by counting nothing at all - test/CLAUDE.md's fifth shape, a test
// that cannot fail.
const leadPanes = (session) =>
  tmux("list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_start_command}")
    .split("\n")
    .map((row) => row.split("\t"))
    .filter(([, command]) => /claude/.test(command ?? ""))
    .map(([pane]) => pane);

describe(
  "cmdLead adopts a live lead pane that moved to another window, instead of splitting a second lead",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const projectDir = mkdtempSync(join(dirs.tmp, "moved-"));
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("moved", projectDir);
    const session = sessionName();
    let firstPane;
    let stampedWindow;

    before(async () => {
      const claude = fakeClaude("sleep 600");
      const first = await runCli(["lead"], {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude)}:${process.env.PATH}` },
      });
      assert.equal(first.code, 0, first.stderr);

      firstPane = leadRow(db, project.id).tmux_target;
      stampedWindow = windowFor(session, project.id);

      // A second pane in the project's window, standing in for the split
      // worker that keeps a window (and its ownership stamp) open after the
      // lead's own pane leaves. Without it, break-pane below would destroy
      // the stamped window along with the stamp, which is a different case:
      // the finding is about a live pane whose OLD window survives.
      tmux("split-window", "-d", "-t", stampedWindow, "-c", projectDir, "sleep 600");
      // -d so the new window does not become current: what is CURRENT must
      // not decide anything here, and a test that leaves it pointing at the
      // moved pane could pass on a code path that only ever asks tmux which
      // window is current.
      tmux("break-pane", "-d", "-s", firstPane);
    });

    after(() => cleanup(session));

    it("moves the lead pane out of the stamped window without killing it (fixture check)", () => {
      assert.equal(leadPanes(session).length, 1, "exactly one lead pane exists before the restart");
      assert.ok(!panesIn(stampedWindow).includes(firstPane), "break-pane moved the lead out of the stamped window");
      assert.equal(
        panesIn(stampedWindow).length,
        1,
        "the stamped window is left holding only the stand-in worker pane",
      );
    });

    it("a restart adopts the moved pane instead of splitting a second lead into the stamped window", async () => {
      const claude2 = fakeClaude("sleep 600");
      const restarted = await runCli(["lead"], {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH: `${dirname(claude2)}:${process.env.PATH}` },
      });
      assert.equal(restarted.code, 0, restarted.stderr);

      const row = leadRow(db, project.id);
      assert.equal(
        row.tmux_target,
        firstPane,
        "the row must still name the live pane it already had, not a freshly split second lead",
      );
      assert.equal(
        leadPanes(session).join(","),
        firstPane,
        "exactly one claude must be running for this project - a second one shares this lead's HIVE_AGENT_ID",
      );
      assert.equal(
        panesIn(stampedWindow).length,
        1,
        "nothing new may be split into the stamped window: the lead is not in it any more",
      );
    });
  },
);
