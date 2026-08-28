import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, scratchDirs, sleep, tmux } from "./helpers.mjs";

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
      ensureSession(session, dirs.projectDir, { bare: true });
    });

    after(() => cleanup(session));

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

        assert.equal(
          currentWindow(session),
          "delta",
          "resolveAttachTarget must perform NO tmux side effects of its own - the window " +
            "must still be whatever it was before this call, not yet selected",
        );

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

          createWindow(session, "beta", dirs.projectDir, [], "sleep 600", null);
          assert.equal(currentWindow(session), "beta", "base's own current window before any view exists");

          const view = viewSessionName();
          const args = resolveAttachTarget(session, projectId, false);

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

            const viewClient = spawn("tmux", ["-C", ...args], { stdio: ["pipe", "pipe", "pipe"] });
            await sleep(400);
            assert.ok(hasSession(view), "the chain must have created and attached the view");
            assert.notEqual(tmux("list-clients", "-t", `=${view}`), "", "the view's client must be recorded");
            assert.equal(currentWindow(view), "alpha", "the view must open on the requested project's window");
            assert.equal(currentWindow(session), "beta", "base's own current window must be untouched by the view");

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
      ensureSession(session, dirs.projectDir, { bare: true });
      const { window } = createWindow(session, "sized", dirs.projectDir, [], "sleep 600", 7);
      const value = execFileSync("tmux", ["show-window-options", "-t", window], { encoding: "utf8" });
      assert.match(value, /window-size smallest/, value);
    });
  },
);
