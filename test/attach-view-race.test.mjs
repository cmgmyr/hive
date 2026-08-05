import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, isolateTmux, raceProcesses, scratchDirs, tmux } from "./helpers.mjs";

// Todo 279 (counselors codex #4). resolveAttachTarget used to read
// `list-clients` and branch on it, returning an argv its CALLER executes
// later: two terminals attaching at the same instant both read zero clients,
// both got a plain attach, and both landed on the base session - the
// two-clients-on-one-session fight the view session exists to prevent,
// recreated by the check meant to avoid it.
//
// The read is gone; every outside-tmux attach takes its own view session. The
// race is unreachable rather than narrowed, and this test still races two real
// processes ON PURPOSE: what it guards against is a later lane reintroducing a
// list-clients read, and only a concurrent fixture can see that. It asserts
// over what HAPPENED to the base session while both clients were live - zero
// clients on it, its current window unmoved - not over a sample of the state
// afterwards.
//
// The clients are control-mode (`tmux -C`), which is how this suite attaches
// without a terminal (test/view-session.test.mjs, test/attach-mode.test.mjs).
// Each child observes while its own client and its peer's are both up, then
// reports; observing from the parent afterwards would be reading a state both
// clients had already left.

const { hasTmux, cleanup } = isolateTmux("the concurrent attach test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");
migrate();

const activeWindow = (session) =>
  tmux("list-windows", "-t", `=${session}`, "-F", "#{window_active} #{window_id}")
    .split("\n")
    .find((row) => row.startsWith("1 "))
    ?.slice(2);

describe(
  "two terminals attaching at once never both land on the base session",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const projectDir = mkdtempSync(join(dirs.tmp, "attach-"));
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("attach", projectDir);
    const session = sessionName();
    let results;
    let otherWindow;

    before(async () => {
      ensureSession(session, projectDir);
      createWindow(session, "attach", projectDir, [], "sleep 600", project.id);
      // A second window, left CURRENT. Base's current window is the thing a
      // stray `select-window -t <base>:<window>` moves, so it has to start
      // somewhere other than the project's window for "unmoved" to mean
      // anything at all.
      otherWindow = createWindow(session, "other", projectDir, [], "sleep 600", null).window.split(":")[1];

      const script = `
import { execFileSync, spawn } from "node:child_process";
import { resolveAttachTarget } from ${JSON.stringify(join(DIST, "tmux.js"))};

const [session, projectId] = process.argv.slice(2);
const argv = resolveAttachTarget(session, Number(projectId), false);
// -C, not the product's own -CC: the second C disables echo and needs a
// real terminal, so a headless -CC client dies with "tcgetattr failed" and
// attaches nothing at all - which is a test that passes while proving
// nothing. Control mode here is only the transport that lets a client exist
// without a tty; whether hive passes -CC is controlModeFor's own question and
// test/attach-mode.test.mjs's. Kept alive across the observation below by
// this process staying alive: a client whose stdin pipe closes detaches,
// which would end the very state being observed.
const client = spawn("tmux", ["-C", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
const q = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
// This process's OWN view session, read out of the argv under test rather
// than rebuilt here: what is being checked is what the product asked for.
const myView = argv[argv.indexOf("-s") + 1];
const clientsOn = (target) => {
  try {
    return q("list-clients", "-t", "=" + target, "-F", "#{client_session}");
  } catch {
    return "";
  }
};
// Wait for THIS process's own client, not for the peer's. An earlier version
// waited for both views to exist at once and was flaky under a loaded suite
// for a reason worth keeping written down: each child kills its client when
// it finishes, and destroy-unattached takes its view with it, so "both alive
// at the same instant" is a rendezvous between two processes that have no
// reason to be in step. Each child proving its own attach landed on its own
// view is the same claim without the coupling - the peer's independence is
// then just the two reported names differing, which the parent checks.
for (const deadline = Date.now() + 8000; Date.now() < deadline && clientsOn(myView) === ""; ) {
  await new Promise((r) => setTimeout(r, 50));
}
const observed = {
  argv,
  myView,
  clientsOnMyView: clientsOn(myView),
  clientsOnBase: clientsOn(session),
  currentWindow: q("list-windows", "-t", "=" + session, "-F", "#{window_active} #{window_id}")
    .split("\\n")
    .find((row) => row.startsWith("1 "))
    ?.slice(2),
};
console.log(JSON.stringify(observed));
client.kill("SIGTERM");
`;
      results = await raceProcesses(
        script,
        [
          [session, String(project.id)],
          [session, String(project.id)],
        ],
        { env: { HIVE_DATA_DIR: dirs.dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR } },
      );
    });

    after(() => {
      for (const name of tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean)) {
        if (/view-\d+$/.test(name)) cleanup(name);
      }
      cleanup(session);
    });

    it("puts no client on the base session at all, from either process", () => {
      for (const [i, observed] of results.entries()) {
        assert.equal(
          observed.clientsOnBase,
          "",
          `process ${i} saw a client on the base session while both attaches were live; ` +
            `its own argv was: tmux ${observed.argv.join(" ")}`,
        );
      }
    });

    it("leaves the base session's current window exactly where it was", () => {
      for (const [i, observed] of results.entries()) {
        assert.equal(
          observed.currentWindow,
          otherWindow,
          `process ${i} saw base's current window moved to ${observed.currentWindow}; a view session exists so ` +
            "that a second terminal's navigation cannot move the first terminal's window",
        );
      }
      assert.equal(activeWindow(session), otherWindow, "and it is still there once both clients are gone");
    });

    it("gives each process its OWN view session, with its own client on it", () => {
      for (const [i, observed] of results.entries()) {
        assert.match(
          observed.myView ?? "",
          /view-\d+$/,
          `process ${i} must have asked for a view session of its own; argv was: tmux ${observed.argv.join(" ")}`,
        );
        assert.equal(
          observed.clientsOnMyView,
          observed.myView,
          `process ${i}'s own client must be attached to its own view, not somewhere else`,
        );
      }
      assert.notEqual(results[0].myView, results[1].myView, "the two views must be distinct sessions");
    });

    it("sets destroy-unattached on the view it creates, and never on the base session", () => {
      for (const observed of results) {
        const chain = observed.argv.join(" ");
        assert.match(chain, /set-option -t \S*view-\d+ destroy-unattached on/, chain);
        assert.doesNotMatch(chain, new RegExp(`set-option -t =?${session} destroy-unattached`), chain);
      }
      // The base session outlived both clients detaching, which is the whole
      // reason that option must never be set on it: leads run detached, and a
      // destroy-unattached on the base would take the session and every lead
      // in it the moment the last client left. has-session EXITS NONZERO when
      // the session is gone, so this fails by throwing rather than by
      // comparing two strings that cannot disagree.
      assert.doesNotThrow(
        () => tmux("has-session", "-t", `=${session}`),
        "the base session must survive both clients leaving",
      );
    });
  },
);
