import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, panesIn, runCli, scratchDirs, tmux, windowFor } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the moved-lead-pane test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

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

      tmux("split-window", "-d", "-t", stampedWindow, "-c", projectDir, "sleep 600");

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
