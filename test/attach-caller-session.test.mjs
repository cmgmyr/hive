import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the in-tmux attach caller test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");
migrate();

const currentWindow = (session) =>
  tmux("list-windows", "-t", `=${session}`, "-F", "#{window_active} #{window_id}")
    .split("\n")
    .find((row) => row.startsWith("1 "))
    ?.slice(2);

describe(
  "hive <project> from inside tmux moves the CALLER's session, never the base session",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const projectDir = mkdtempSync(join(dirs.tmp, "caller-"));
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("caller", projectDir);
    const session = sessionName();
    const view = `${session}-view-4242`;
    let projectWindow;
    let elsewhere;
    let paneEnv;

    before(() => {
      ensureSession(session, projectDir, { bare: true });
      projectWindow = createWindow(session, "caller", projectDir, [], "sleep 600", project.id).window.split(":")[1];
      elsewhere = createWindow(session, "elsewhere", projectDir, [], "sleep 600", null).window.split(":")[1];

      tmux("new-session", "-d", "-t", `=${session}`, "-s", view);
      tmux("select-window", "-t", `${session}:${elsewhere}`);
      tmux("select-window", "-t", `${view}:${elsewhere}`);

      const socket = tmux("display-message", "-p", "#{socket_path}");
      const pid = tmux("display-message", "-p", "#{pid}");

      const viewId = tmux("list-sessions", "-F", "#{session_name} #{session_id}")
        .split("\n")
        .find((row) => row.startsWith(`${view} `))
        ?.split(" ")[1]
        .replace("$", "");
      assert.ok(viewId, "the view session must have an id for this fixture to fake a pane's TMUX");
      paneEnv = { TMUX: `${socket},${pid},${viewId}` };
    });

    after(() => {

      for (const name of tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean)) {
        if (/view-\d+$/.test(name)) cleanup(name);
      }
      cleanup(session);
    });

    it("parks both sessions on the other window first (fixture check)", () => {
      assert.equal(currentWindow(session), elsewhere, "base starts away from the project's window");
      assert.equal(currentWindow(view), elsewhere, "and so does the view");
    });

    it("selects the project's window in the caller's own session", async () => {
      const result = await runCli(["attach"], {
        cwd: projectDir,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: paneEnv,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        currentWindow(view),
        projectWindow,
        "the caller's own session must be the one that moved to the project's window",
      );
    });

    it("leaves the base session's current window where the other terminal left it", () => {
      assert.equal(
        currentWindow(session),
        elsewhere,
        "the base session is another terminal's; moving its current window is the yank this fix removes",
      );
    });
  },
);
