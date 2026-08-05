import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, scratchDirs, sleep, tmux } from "./helpers.mjs";

// Todo 271 / plan-lane-3-tmux-topology, "VIEW SESSIONS DESIGNED AND SETTLED
// WITH CHRIS". Two clients on ONE shared session fight over its current
// window (pad 71 "SECOND PROJECT, SIDE BY SIDE INSTEAD"), so a second real
// terminal attaches through its own view session instead: same windows,
// independent current window, destroyed the instant its client detaches,
// never touching the base session or any pane in it.
const { hasTmux, cleanup } = isolateTmux("view sessions (todo 271)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { createWindow, ensureSession, findProjectWindow, resolveAttachTarget, sessionName, viewSessionName } =
  await import("../dist/tmux.js");

function hasSession(name) {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function windowsIn(session) {
  return tmux("list-windows", "-t", `=${session}`, "-F", "#{window_name}").split("\n").filter(Boolean);
}

function currentWindow(session) {
  const line = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_active} #{window_name}")
    .split("\n")
    .find((l) => l.startsWith("1 "));
  return line?.slice(2);
}

// A headless client, attached in tmux's own control mode (-C). Measured
// against tmux 3.7b: control mode registers a real client (visible in
// list-clients) over plain pipes, no pty required, which is what lets this
// force a SECOND real client onto a session with nothing more than PATH and
// stdio - the standing way to exercise anything needing an already-attached
// session (dead-ends/2026-08-02-ensureattached-against-the-live-session.md
// solved the opposite problem, forcing a session to have NO client; this
// forces one ON).
function attachClient(target) {
  return spawn("tmux", ["-C", "attach", "-t", target], { stdio: ["pipe", "pipe", "pipe"] });
}

function detach(client) {
  return new Promise((resolve) => {
    client.once("exit", () => resolve());
    client.kill("SIGTERM");
  });
}

describe(
  "resolveAttachTarget (todo 271)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = sessionName();

    before(() => {
      ensureSession(session, dirs.projectDir);
    });

    after(() => cleanup(session));

    // Todo 279 (counselors codex #4) COLLAPSED THE TWO BRANCHES THIS USED TO
    // ASSERT. There was a no-client branch (plain attach onto base) and a
    // has-client branch (a view session), chosen by reading list-clients -
    // a read whose answer is executed later, by a caller that spawns the
    // returned argv, so two terminals attaching at the same instant both
    // read zero clients and both landed on base. Every attach takes a view
    // now, so there is no read to be stale and no branch to choose wrong.
    // The has-client case further down is unchanged and still passes: it
    // was always this shape.
    it("with no client on the base session, STILL routes through a view rather than attaching to base", () => {
      assert.equal(tmux("list-clients", "-t", `=${session}`), "", "nothing attached yet");
      const args = resolveAttachTarget(session, 1, false);
      assert.equal(args[0], "new-session", `no branch may produce a bare attach any more, got: ${args.join(" ")}`);
      assert.ok(!args.includes("attach"), `and no plain attach anywhere in the chain, got: ${args.join(" ")}`);
      assert.ok(!hasSession(viewSessionName()), "and resolving still creates nothing on its own");
    });

    it("carries -CC when control mode is requested", () => {
      const args = resolveAttachTarget(session, 1, true);
      assert.equal(args[0], "-CC", `control mode still leads the argv, got: ${args.join(" ")}`);
      assert.equal(args[1], "new-session");
    });

    it(
      "todo 272/reversal (see resolveAttachTarget's own comment): chains " +
        "select-window into the returned argv instead of performing it as a side effect, " +
        "so the project's own window is selected once that argv actually runs - " +
        "never by calling resolveAttachTarget alone",
      async () => {
        const projectId = 7;
        createWindow(session, "gamma", dirs.projectDir, [], "sleep 600", projectId);
        // delta is created SECOND, so base's current window is delta, not
        // gamma - deliberately different, so a passing test proves the
        // returned argv, once run, actually moves it rather than it already
        // happening to be there.
        createWindow(session, "delta", dirs.projectDir, [], "sleep 600", null);
        assert.equal(currentWindow(session), "delta", "base's current window before this call");

        const view = viewSessionName();
        const args = resolveAttachTarget(session, projectId, false);
        assert.deepEqual(
          args,
          [
            "new-session", "-t", `=${session}`, "-s", view,
            ";", "set-option", "-t", view, "destroy-unattached", "on",
            ";", "select-window", "-t", `${view}:${findProjectWindow(session, projectId).split(":")[1]}`,
          ],
          "the select-window must be CHAINED into the argv, behind the new-session that makes this a client",
        );
        // The property that regressed: calling resolveAttachTarget must not
        // itself mutate anything. Only running the argv it returned should
        // move the window - proven below by actually running it.
        assert.equal(
          currentWindow(session),
          "delta",
          "resolveAttachTarget must perform NO tmux side effects of its own - the window " +
            "must still be whatever it was before this call, not yet selected",
        );

        // Same technique the has-client case below uses: a headless -C
        // client drives the EXACT argv resolveAttachTarget returned, so a
        // passing assertion proves the chain actually works when spawned,
        // not merely that its shape looks plausible.
        const client = spawn("tmux", ["-C", ...args], { stdio: ["pipe", "pipe", "pipe"] });
        try {
          await sleep(400);
          assert.equal(
            currentWindow(viewSessionName()),
            "gamma",
            "running the returned argv must select the project's window, exactly as the " +
              "eager call used to before this reversal - in the view now (todo 279), which " +
              "is where this client is",
          );
          assert.equal(
            currentWindow(session),
            "delta",
            "and base's own current window stays where it was: nothing attaches to base any more",
          );
        } finally {
          client.kill("SIGTERM");
          await sleep(300);
          if (hasSession(viewSessionName())) tmux("kill-session", "-t", `=${viewSessionName()}`);
        }
      },
    );

    it(
      "routes a second attach through its own view session once the base has a client, " +
        "landing on the requested project's window without moving the base's own current window",
      async () => {
        const baseClient = attachClient(`=${session}`);
        try {
          await sleep(300);
          assert.notEqual(
            tmux("list-clients", "-t", `=${session}`),
            "",
            "the base session must show a client before this case means anything",
          );

          const projectId = 42;
          createWindow(session, "alpha", dirs.projectDir, [], "sleep 600", projectId);
          // beta is created SECOND, so tmux's own new-window default (make
          // the new window current) leaves base on beta - deliberately
          // different from alpha, the project's own window, so independence
          // is proven by construction rather than by coincidence.
          createWindow(session, "beta", dirs.projectDir, [], "sleep 600", null);
          assert.equal(currentWindow(session), "beta", "base's own current window before any view exists");

          const view = viewSessionName();
          const args = resolveAttachTarget(session, projectId, false);
          // resolveAttachTarget does not create the view itself - it is
          // created, stamped and navigated as part of THIS returned chain,
          // by whoever actually spawns it (see the function's own comment
          // for why: creating it any earlier races destroy-unattached).
          assert.ok(!hasSession(view), "the view must not exist before its own attach chain has run");
          assert.deepEqual(
            args,
            [
              "new-session", "-t", `=${session}`, "-s", view,
              ";", "set-option", "-t", view, "destroy-unattached", "on",
              ";", "select-window", "-t", `${view}:${findProjectWindow(session, projectId).split(":")[1]}`,
            ],
          );

          try {
            // Spawned with -C prepended, not -CC: this drives the EXACT
            // argv resolveAttachTarget returned, headlessly, over plain
            // pipes. -C needs no real pty for this (measured against tmux
            // 3.7b); -CC additionally calls tcgetattr and fails outright
            // over a pipe ("Operation not supported on socket") - a fact
            // about control mode's OWN two levels, unrelated to what this
            // case is actually proving (the chained command sequence).
            const viewClient = spawn("tmux", ["-C", ...args], { stdio: ["pipe", "pipe", "pipe"] });
            await sleep(400);
            assert.ok(hasSession(view), "the chain must have created and attached the view");
            assert.notEqual(tmux("list-clients", "-t", `=${view}`), "", "the view's client must be recorded");
            assert.equal(currentWindow(view), "alpha", "the view must open on the requested project's window");
            assert.equal(currentWindow(session), "beta", "base's own current window must be untouched by the view");
            // destroy-unattached is a session option; it must never have
            // reached base, which keeps leads running detached (pad 71,
            // "ENDING THINGS"). Bare name, not `=session`: measured, `show-
            // options -t =<name>` fails outright ("no such session") for
            // EITHER side of a grouped pair in tmux 3.7b, while every other
            // command used in this file (list-windows, list-clients,
            // select-window, set-option) resolves the exact-match form fine
            // - a quirk of this one command, not of the session's existence.
            assert.doesNotMatch(
              tmux("show-options", "-t", session, "destroy-unattached"),
              /on/,
              "destroy-unattached must never land on the base session",
            );

            await detach(viewClient);
            await sleep(400);
            assert.ok(!hasSession(view), "destroy-unattached must destroy the view once its own client detaches");
            assert.ok(hasSession(session), "the base session must survive the view's destruction");
            const remaining = windowsIn(session);
            assert.ok(remaining.includes("alpha"), "a view session owns no panes - alpha must still be there");
            assert.ok(remaining.includes("beta"), "a view session owns no panes - beta must still be there");
          } finally {
            if (hasSession(view)) tmux("kill-session", "-t", `=${view}`);
          }
        } finally {
          await detach(baseClient);
        }
      },
    );

    it("still creates and attaches the view even when the requested project has no window yet", async () => {
      const baseClient = attachClient(`=${session}`);
      try {
        await sleep(300);
        const view = viewSessionName();
        const args = resolveAttachTarget(session, 999999, false);
        assert.deepEqual(
          args,
          [
            "new-session", "-t", `=${session}`, "-s", view,
            ";", "set-option", "-t", view, "destroy-unattached", "on",
          ],
          "no window to select for this project, so the chain must skip select-window entirely",
        );
        try {
          const viewClient = spawn("tmux", ["-C", ...args], { stdio: ["pipe", "pipe", "pipe"] });
          await sleep(400);
          assert.ok(hasSession(view), "the chain must still create and attach the view with nothing to select");
          await detach(viewClient);
        } finally {
          if (hasSession(view)) tmux("kill-session", "-t", `=${view}`);
        }
      } finally {
        await detach(baseClient);
      }
    });

    it("survives its own last client detaching (never sets destroy-unattached on the base itself)", async () => {
      const client = attachClient(`=${session}`);
      await sleep(300);
      assert.notEqual(tmux("list-clients", "-t", `=${session}`), "");
      await detach(client);
      await sleep(300);
      assert.ok(hasSession(session), "the base session must outlive its last client - hive never sets this on it");
    });
  },
);

describe("viewSessionName", () => {
  it("is namespaced under the same hive- prefix as sessionName, tagged by pid", () => {
    // Independent derivation, not a second call to the same function
    // (test-hygiene reasoning: dead-ends/2026-08-05-test-hygiene-lane-that-
    // dissolved.md, applied here the same way session-name.test.mjs applies
    // it to sessionName): a wrong pid or a dropped prefix would still pass a
    // test that just called viewSessionName again and compared it to itself.
    // sessionName() carries the scratch store's own tag independently, so
    // reusing it here (rather than hardcoding "hive-") still catches
    // viewSessionName dropping the tag or the prefix on its own.
    const tag = sessionName().replace(/^hive-/, "").replace(/main$/, "");
    assert.equal(viewSessionName(), `hive-${tag}view-${process.pid}`);
  });
});

describe(
  "configureHiveWindow sets window-size smallest (todo 271)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = `${sessionName()}-window-size`;

    after(() => cleanup(session));

    it("stamps a freshly created window with window-size smallest", () => {
      ensureSession(session, dirs.projectDir);
      const { window } = createWindow(session, "sized", dirs.projectDir, [], "sleep 600", 7);
      const value = execFileSync("tmux", ["show-window-options", "-t", window], { encoding: "utf8" });
      assert.match(value, /window-size smallest/, value);
    });
  },
);
