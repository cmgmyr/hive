import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs, tmux } from "./helpers.mjs";

// Todo 279 (counselors codex #3 and opus #1 independently, so certain).
//
// `hive <project>` from inside tmux ran `select-window -t <window>`, where the
// window came from findProjectWindow already qualified with the BASE session's
// name. select-window on a session-qualified target moves THAT SESSION's
// current window, so from a pane being viewed through a VIEW session it moved
// BASE's current window - yanking the other terminal to a window nobody there
// asked for - while the caller did not move at all. Both halves are wrong at
// once, which is why this file asserts both.
//
// NO CLIENT IS ATTACHED HERE, deliberately, and that is what makes the test
// deterministic. A session's current window exists whether or not anyone is
// looking at it, so the yank is observable without a terminal; and with no
// client, callerSession() falls through to $TMUX's own session id, which a
// test can set exactly. The client_session read that sits AHEAD of that
// fallback is measured rather than tested (its measurement is in
// callerSession's own comment: attaching a real client needs a pty, which
// differs between the macOS and ubuntu CI legs).

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
      ensureSession(session, projectDir);
      projectWindow = createWindow(session, "caller", projectDir, [], "sleep 600", project.id).window.split(":")[1];
      elsewhere = createWindow(session, "elsewhere", projectDir, [], "sleep 600", null).window.split(":")[1];

      // Both sessions parked on the OTHER window, so "moved" and "unmoved"
      // are distinguishable in both directions.
      tmux("new-session", "-d", "-t", `=${session}`, "-s", view);
      tmux("select-window", "-t", `${session}:${elsewhere}`);
      tmux("select-window", "-t", `${view}:${elsewhere}`);

      // What a pane's environment looks like: <socket>,<server pid>,<session
      // id>. Built from the real server rather than a literal, since the
      // first field is what hive's own foreign-socket guard reads.
      const socket = tmux("display-message", "-p", "#{socket_path}");
      const pid = tmux("display-message", "-p", "#{pid}");
      // list-sessions, not `display-message -t =<name>`: measured here, that
      // form answers EMPTY for #{session_id} while the bare name answers
      // `$1`. Same trap .claude/rules/tmux-and-panes.md already records for
      // display-message, in its quieter direction - no error, just nothing.
      const viewId = tmux("list-sessions", "-F", "#{session_name} #{session_id}")
        .split("\n")
        .find((row) => row.startsWith(`${view} `))
        ?.split(" ")[1]
        .replace("$", "");
      assert.ok(viewId, "the view session must have an id for this fixture to fake a pane's TMUX");
      paneEnv = { TMUX: `${socket},${pid},${viewId}` };
    });

    after(() => {
      // Any view session this run left behind, not just the fixture's own:
      // the fallback branch under test creates one named for the CLI's pid.
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
