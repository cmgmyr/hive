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
import { renderAttachCommand, resolveAttachTarget } from ${JSON.stringify(join(DIST, "tmux.js"))};

const [session, projectId] = process.argv.slice(2);
const argv = resolveAttachTarget(session, Number(projectId), false);
// An ordinary client on a pty from script(1). Never -C or -CC: control-mode clients receive
// %sessions-changed, which segfaults tmux 3.4/3.5a. The client lives as long as script does.
const client = spawn(
  "script",
  process.platform === "darwin"
    ? ["-q", "/dev/null", "tmux", ...argv]
    : ["-qfec", "tmux " + renderAttachCommand(argv), "/dev/null"],
  { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, TERM: "xterm-256color" } },
);
process.on("exit", () => client.kill("SIGTERM"));
const q = (...args) => execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Read out of the argv under test, never rebuilt here: check what the product asked for.
const myView = argv[argv.indexOf("-s") + 1];
const clientsOn = (target) => {
  try {
    return q("list-clients", "-t", "=" + target, "-F", "#{client_session}");
  } catch (e) {
    // "no clients" and "the query failed" must stay distinct: swallowing errors here made a
    // broken probe read as the PASSING value below.
    const msg = String(e.stderr ?? e.message ?? e);
    if (/can't find session|no such session/i.test(msg)) return "";
    throw e;
  }
};
// THIS process's own client, never the peer's: waiting for both at once is a rendezvous
// between processes with no reason to be in step, and it flaked.
for (const deadline = Date.now() + 8000; Date.now() < deadline && clientsOn(myView) === ""; ) {
  await new Promise((r) => setTimeout(r, 50));
}
// These two reads are the only ones that can fail on an UNGROUPED view; every other assertion
// in this file passes against one. Do not drop them for a string check.
const baseWindows = q("list-windows", "-t", "=" + session, "-F", "#{window_id}");
const viewWindows = myView ? q("list-windows", "-t", "=" + myView, "-F", "#{window_id}") : "";
// Bare target on purpose: show-options -t rejects the "=" form the rest of this file uses.
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
if (client.exitCode === null && client.signalCode === null) {
  await new Promise((resolve) => {
    client.once("exit", resolve);
    client.kill("SIGTERM");
    setTimeout(resolve, 3000).unref();
  });
}
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
