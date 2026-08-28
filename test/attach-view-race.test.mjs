import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, isolateTmux, raceProcesses, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the concurrent attach test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { createWindow, ensureSession, isViewSessionName, sessionName } = await import("../dist/tmux.js");
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
      ensureSession(session, projectDir, { bare: true });
      createWindow(session, "attach", projectDir, [], "sleep 600", project.id);

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
  } catch (e) {
    // Distinguish "no clients" (a real answer) from "the query failed" (no
    // answer at all) - swallowing every error here made a broken probe read
    // as the PASSING value for the base-session assertion below.
    const msg = String(e.stderr ?? e.message ?? e);
    if (/can't find session|no such session/i.test(msg)) return "";
    throw e;
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
// Issue #117 counselors, F4. A mutation that drops the '-t =<base>' from
// the created session (making it a standalone session rather than a view
// GROUPED with base) passed every assertion in this file before these two
// reads existed: every check here was a regex over the emitted string or a
// client-location probe, neither of which can tell a grouped view from an
// ungrouped one that merely happens to be named the same shape. list-windows
// on the view itself is the only way to prove grouping means anything, and
// show-options reads whether destroy-unattached TOOK EFFECT on the live
// session rather than merely that the string asking for it was built.
const baseWindows = q("list-windows", "-t", "=" + session, "-F", "#{window_id}");
const viewWindows = myView ? q("list-windows", "-t", "=" + myView, "-F", "#{window_id}") : "";
// show-options' -t does not accept the "=" exact-match form other tmux
// commands here take (measured: throws "no such session" against a real,
// live, client-attached view where has-session/list-clients/list-windows
// all succeed) - bare here, deliberately inconsistent with the rest of this
// file's targets.
const destroyUnattachedValue = myView ? q("show-options", "-t", myView, "-v", "destroy-unattached") : "";
const observed = {
  argv,
  myView,
  clientsOnMyView: clientsOn(myView),
  clientsOnBase: clientsOn(session),
  baseWindows,
  viewWindows,
  destroyUnattachedValue,
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
        if (isViewSessionName(name)) cleanup(name);
      }
      cleanup(session);
    });

    it("puts no client on the base session at all, from either process", () => {
      for (const [i, observed] of results.entries()) {
        assert.equal(
          observed.clientsOnBase,
          "",
          `process ${i} saw a client on the base session after its own attach landed (no rendezvous with its peer is claimed here - see the comment above); ` +
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

        assert.ok(
          isViewSessionName(observed.myView ?? ""),
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

        assert.match(chain, new RegExp(`set-option -t ${observed.myView} destroy-unattached on`), chain);
        assert.doesNotMatch(chain, new RegExp(`set-option -t =?${session} destroy-unattached`), chain);

        assert.equal(
          observed.destroyUnattachedValue,
          "on",
          `process saw destroy-unattached read back as ${JSON.stringify(observed.destroyUnattachedValue)}, not "on"; argv was: tmux ${observed.argv.join(" ")}`,
        );
      }

      assert.doesNotThrow(
        () => tmux("has-session", "-t", `=${session}`),
        "the base session must survive both clients leaving",
      );
    });

    it("groups the view with base, so the view shows base's own windows", () => {

      for (const [i, observed] of results.entries()) {
        assert.ok(observed.viewWindows, `process ${i} never recorded its view's windows`);
        assert.equal(
          observed.viewWindows,
          observed.baseWindows,
          `process ${i}'s view (windows: ${observed.viewWindows}) does not show base's own windows ` +
            `(${observed.baseWindows}) - it is not grouped with base`,
        );
      }
    });
  },
);
