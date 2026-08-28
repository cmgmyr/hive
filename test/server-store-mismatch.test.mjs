import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs, withEnv } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the server/store mismatch tests");
const { dataDir, projectDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { janitor } = await import("../dist/scheduler.js");
const {
  defaultTmuxSocketPath,
  ensureSession,
  liveTargets,
  privateTmuxSocket,
  scratchStoreOnSharedSocket,
  sessionName,
  targetLive,
  tmux,
  tmuxSocketPath,
  untrustedTmuxServer,
} = await import("../dist/tmux.js");
const { launchAgent } = await import("../dist/spawn.js");
migrate();

const fallbackSession = `hive-fallback-${process.pid}`;
after(() => cleanup(fallbackSession));

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("mismatch-test", projectDir).id;

function agentRow(name, target) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status,
         agent_state, created_at)
       VALUES (?, ?, ?, ?, 'claude', '/tmp', 'running', 'working', datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, `agent:${name}`, name, target).id;
}

const agentStatus = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;

function reset() {
  db.exec("DELETE FROM timers; DELETE FROM agents;");
}

const asDefaultStore = (fn) => withEnv({ HIVE_DATA_DIR: undefined }, fn);
const withTmuxTmpDir = (dir, fn) => withEnv({ TMUX_TMPDIR: dir }, fn);

const paneOn = (socket) => `${socket},12936,0`;
const SPIKE_SOCKET = "/private/tmp/tmux-501/hivespike";

describe("privateTmuxSocket asks which socket tmux will actually use", () => {

  it("treats no tmux env at all as the shared server", () => {
    assert.equal(privateTmuxSocket(undefined, undefined), false);
    assert.equal(privateTmuxSocket(undefined, ""), false);
  });

  it("treats tmux's own default TMUX_TMPDIR as the shared server", () => {
    assert.equal(privateTmuxSocket(undefined, "/tmp"), false);
  });

  it("sees through the macOS /tmp symlink", () => {

    assert.equal(privateTmuxSocket(undefined, "/private/tmp"), false);
  });

  it("calls a reachable private TMUX_TMPDIR private", () => {
    const scratch = mkdtempSync(join(tmpdir(), "hive-socketcheck-"));
    try {
      assert.equal(privateTmuxSocket(undefined, scratch), true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("treats a TMUX_TMPDIR that does not exist as the shared server, because tmux does", () => {

    assert.equal(privateTmuxSocket(undefined, "/nonexistent/hive/socket/dir"), false);
  });

  it("still calls an existing directory private after one has been removed", () => {

    const scratch = mkdtempSync(join(tmpdir(), "hive-socketgone-"));
    assert.equal(privateTmuxSocket(undefined, scratch), true);

    rmSync(scratch, { recursive: true, force: true });

    assert.equal(privateTmuxSocket(undefined, scratch), false, "the same path, once gone, is shared");
  });

  it("takes an inherited TMUX over TMUX_TMPDIR, in both directions", () => {

    assert.equal(
      privateTmuxSocket(paneOn(SPIKE_SOCKET), undefined),
      true,
      "a -L server is private even with TMUX_TMPDIR unset",
    );

    assert.equal(
      privateTmuxSocket(paneOn(defaultTmuxSocketPath()), "/tmp/some-private-dir"),
      false,
      "TMUX wins, so a stray TMUX_TMPDIR must not trigger a refusal",
    );
  });

  it("resolves the socket path itself, not just a yes or no", () => {
    assert.equal(tmuxSocketPath(paneOn(SPIKE_SOCKET), undefined), SPIKE_SOCKET);
    assert.equal(tmuxSocketPath(undefined, undefined), defaultTmuxSocketPath());
    assert.match(defaultTmuxSocketPath(), /^\/(private\/)?tmp\/tmux-\d+\/default$/);
  });

  it("ignores a malformed TMUX rather than trusting an empty socket", () => {
    assert.equal(privateTmuxSocket("", undefined), false);
    assert.equal(privateTmuxSocket(",123,0", undefined), false);
  });
});

describe("the tmux behaviour privateTmuxSocket depends on", { skip: hasTmux ? false : "tmux is not installed" }, () => {

  const session = fallbackSession;
  const missing = join(tmpdir(), `hive-no-such-socket-dir-${process.pid}`);

  before(() => {
    if (!hasTmux) return;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  });

  it("does not create TMUX_TMPDIR, and falls back to the shared socket when it is missing", () => {

    assert.equal(existsSync(missing), false, "precondition: the directory is not there");

    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      env: { ...process.env, TMUX_TMPDIR: missing },
    });

    const defaultSocket = /\/(private\/)?tmp\/tmux-\d+\//;
    if (result.status === 0) {
      assert.ok(
        !result.stdout.split("\n").includes(session),
        "a missing TMUX_TMPDIR must not resolve to the private server it names",
      );
    } else {
      assert.match(
        result.stderr,
        defaultSocket,
        `tmux must have tried the shared socket, not ${missing}; got: ${result.stderr}`,
      );
      assert.doesNotMatch(result.stderr, new RegExp(missing), "and not the directory that is gone");
    }
    assert.equal(existsSync(missing), false, "and tmux must not have created the directory");
  });

  it("does use TMUX_TMPDIR when the directory is really there", () => {

    const listed = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
    });

    assert.ok(listed.split("\n").includes(session), "the private socket must still resolve normally");
  });
});

describe("hive refuses to read liveness off a tmux server its store does not live on", () => {
  beforeEach(reset);

  it("refuses when a private tmux server is paired with the default store", () => {

    assert.equal(asDefaultStore(() => untrustedTmuxServer()), true);
  });

  it("allows the suite's own configuration: private tmux AND a scratch store", () => {

    assert.equal(untrustedTmuxServer(), false);
    assert.notEqual(liveTargets(), null, "the suite must still get real liveness answers");
  });

  it("allows the everyday case: the shared tmux server and the default store", () => {

    withTmuxTmpDir(undefined, () => {
      assert.equal(asDefaultStore(() => untrustedTmuxServer()), false);
    });
    withTmuxTmpDir("/tmp", () => {
      assert.equal(asDefaultStore(() => untrustedTmuxServer()), false);
    });
  });

  it("refuses inside a pane on a private server, with TMUX_TMPDIR unset", () => {

    withEnv({ TMUX: paneOn(SPIKE_SOCKET), TMUX_TMPDIR: undefined }, () => {
      assert.equal(
        asDefaultStore(() => untrustedTmuxServer()),
        true,
        "a -L server plus the default store is the bad pair, whatever TMUX_TMPDIR says",
      );
      assert.equal(asDefaultStore(() => liveTargets()), null, "and liveness must answer unknown");
    });
  });

  it("does not refuse inside a pane on the shared server", () => {

    withEnv({ TMUX: paneOn(defaultTmuxSocketPath()), TMUX_TMPDIR: undefined }, () => {
      assert.equal(asDefaultStore(() => untrustedTmuxServer()), false);
    });
  });

  it("answers unknown rather than dead, so #14's handling carries it", () => {

    asDefaultStore(() => {
      assert.equal(liveTargets(), null, "the batch probe must answer unknown");
      assert.equal(targetLive("%9999"), null, "and so must the single-target one");
    });
  });
});

describe(
  "hive refuses its own tmux calls when a scratch store's socket falls through to the shared one (todo 368)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    // A third question, not a widening of either guard above: untrustedTmuxServer() refuses a PRIVATE
    // socket paired with the DEFAULT store; this refuses the DEFAULT socket paired with a SCRATCH
    // store - the shape produced when TMUX_TMPDIR is set but its directory has gone unreachable.

    it("allows the suite's own configuration: private tmux AND a scratch store", () => {

      assert.equal(scratchStoreOnSharedSocket(), false);
      assert.doesNotThrow(() => tmux("list-sessions"));
    });

    it("refuses when a scratch store's TMUX_TMPDIR is unset, so the socket falls through to the shared one", () => {

      withTmuxTmpDir(undefined, () => {
        assert.equal(scratchStoreOnSharedSocket(), true);
        assert.throws(() => tmux("list-sessions"), /Refusing to run tmux against the shared socket/);
      });
    });

    it("refuses when a scratch store's TMUX_TMPDIR points at a directory that has gone unreachable - the measured mechanism behind comment 1088", () => {

      const missing = join(tmpdir(), `hive-368-missing-${process.pid}`);
      assert.equal(existsSync(missing), false, "precondition: the directory is not there");
      withTmuxTmpDir(missing, () => {
        assert.equal(scratchStoreOnSharedSocket(), true);
        assert.throws(() => tmux("list-sessions"), /Refusing to run tmux against the shared socket/);
      });
    });

    it("fails open (does not refuse) when storeDir() itself cannot be resolved, e.g. under a test runner - a guard that cannot tell what store it is on must not refuse", () => {

      // Not a pin of a genuine default store: storeDir() refuses the default path outright under a
      // test runner, so this always hits the catch branch, never isDefaultStore(storeDir()) itself.
      // That branch cannot be reached from any test runner at all; isDefaultStore(DEFAULT_DATA_DIR) is
      // pinned directly elsewhere instead (test/isolated-hive.test.mjs, test/store-isolation.test.mjs).
      withTmuxTmpDir(undefined, () => {
        assert.equal(asDefaultStore(() => scratchStoreOnSharedSocket()), false);
      });
    });

    it("names both halves in the message, so the way out is obvious", () => {

      let message = "";
      withTmuxTmpDir(undefined, () => {
        try {
          tmux("list-sessions");
        } catch (e) {
          message = e.message;
        }
      });
      assert.match(message, /TMUX_TMPDIR/, "names the tmux half");
      assert.match(message, /HIVE_DATA_DIR is a/, "names the store half");
    });

    it("blames the deciding input, not TMUX_TMPDIR, when an inherited TMUX is what actually named the shared socket (todo 368 finding H)", () => {

      const scratch = mkdtempSync(join(tmpdir(), "hive-368-reachable-"));
      try {
        let message = "";
        withEnv({ TMUX: paneOn(defaultTmuxSocketPath()), TMUX_TMPDIR: scratch }, () => {
          try {
            tmux("list-sessions");
          } catch (e) {
            message = e.message;
          }
        });
        assert.match(message, /an inherited TMUX names the shared socket directly/, message);
        assert.match(message, new RegExp(`TMUX=${paneOn(defaultTmuxSocketPath()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), message);
        assert.doesNotMatch(
          message,
          /TMUX_TMPDIR \(.*\) is set but unreachable/,
          `TMUX_TMPDIR (${scratch}) is reachable and irrelevant here - blaming it cannot clear the refusal: ${message}`,
        );
        assert.match(message, new RegExp(defaultTmuxSocketPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names the resolved socket");
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("does not call a REACHABLE TMUX_TMPDIR unreachable when it is the shared socket's own directory", () => {

      let message = "";
      withEnv({ TMUX: undefined, TMUX_TMPDIR: "/tmp" }, () => {
        try {
          tmux("list-sessions");
        } catch (e) {
          message = e.message;
        }
      });
      assert.doesNotMatch(
        message,
        /is set but unreachable/,
        `/tmp exists, so "recreate it if it was removed" is a no-op and the refusal can never be cleared: ${message}`,
      );
      assert.match(message, /TMUX_TMPDIR \(\/tmp\) is reachable but resolves to the shared socket/, message);
    });
  },
);

describe(
  "an empty tmux_target is never live (todo 180)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("list-panes -t '' resolves to a real session instead of erroring, the reproduction the fix rests on", () => {

      const out = execFileSync("tmux", ["list-panes", "-t", ""], { encoding: "utf8" });
      assert.match(out, /%\d+/, "an empty target answers with a real pane id, not an error");
    });

    it("targetLive('') is always false, without ever asking tmux", () => {

      assert.equal(targetLive(""), false);
    });
  },
);

describe("the janitor sweeps nothing when it cannot trust the server it probed", () => {
  beforeEach(reset);

  it("closes a row whose pane is really gone, as it always has", () => {

    const agent = agentRow("really-gone", "%9600");

    const result = janitor();

    assert.equal(result.probed, true, "a private tmux with a scratch store is a server hive trusts");
    assert.equal(result.closed_agents, 1);
    assert.equal(agentStatus(agent), "closed");
  });

  it("leaves a live worker's row alone when the store belongs to another server", () => {

    const first = agentRow("live-elsewhere", "%9601");
    const second = agentRow("also-live-elsewhere", "%9602");

    const result = asDefaultStore(() => janitor());

    assert.deepEqual(result, { closed_agents: 0, cancelled_timers: 0, probed: false, reaped_codex_homes: 0 });
    assert.equal(agentStatus(first), "running", "a correct answer from the wrong server closes nothing");
    assert.equal(agentStatus(second), "running");
  });

  it("sweeps nothing inside a pane on a private server", () => {

    const first = agentRow("live-on-shared", "%9701");
    const second = agentRow("also-live-on-shared", "%9702");

    const result = withEnv({ TMUX: paneOn(SPIKE_SOCKET), TMUX_TMPDIR: undefined }, () =>
      asDefaultStore(() => janitor()),
    );

    assert.deepEqual(result, { closed_agents: 0, cancelled_timers: 0, probed: false, reaped_codex_homes: 0 });
    assert.equal(agentStatus(first), "running");
    assert.equal(agentStatus(second), "running");
  });

  it("does not cancel wake-ups whose delivery pane lives on the other server", () => {
    const timer = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
           due_at, created_at)
         VALUES (?, 'user:test', 'wake body', 'delay', '[]', 'user:test', '%9603',
           datetime('now', '+1 hour'), datetime('now', '-60 seconds'))
         RETURNING id`,
      )
      .get(project).id;

    asDefaultStore(() => janitor());

    const row = db.prepare("SELECT cancelled_at FROM timers WHERE id = ?").get(timer);
    assert.equal(row.cancelled_at, null, "a lead's pending wake must survive a probe of the wrong server");
  });
});

describe("spawning refuses under the same pairing, not just reading", { skip: hasTmux ? false : "tmux is not installed" }, () => {

  beforeEach(reset);

  const spec = (name) => ({
    projectId: project,
    projectName: "mismatch-test",
    projectPath: projectDir,
    name,
    kind: "command",
    commandString: "sleep 600",
    cwd: projectDir,
    env: {},
    placement: "window",
    parentActor: "user:test",
  });

  const agentCount = () =>
    db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(project).n;

  it("refuses, and leaves no row behind", () => {
    const before = agentCount();

    assert.throws(
      () => asDefaultStore(() => launchAgent(spec("would-be-stranded"))),
      /Refusing to spawn/,
      "a spawn under the bad pair must not reach tmux",
    );

    assert.equal(agentCount(), before, "the refusal must not leave a row behind");
  });

  it("names both halves of the pairing, so the way out is obvious", () => {

    let message = "";
    try {
      asDefaultStore(() => launchAgent(spec("message-check")));
    } catch (e) {
      message = e.message;
    }

    assert.match(message, /TMUX_TMPDIR/, "names the tmux half");
    assert.match(message, /HIVE_DATA_DIR|default store/, "names the store half");

    assert.match(message, /agent_close would kill/, "says what the damage would be");
  });

  it("refuses hive lead and hive attach too, at the session they both create", () => {

    assert.throws(
      () => asDefaultStore(() => ensureSession("hive-should-never-exist", projectDir, { bare: true })),
      /Refusing to create a tmux session/,
    );
  });

  it("still creates a session in the suite's own configuration", () => {

    const name = `hive-ensure-ok-${process.pid}`;
    try {
      assert.equal(ensureSession(name, projectDir, { bare: true }).created, true, "a legitimate pairing still creates one");
      assert.equal(ensureSession(name, projectDir, { bare: true }).created, false, "and is idempotent on the second call");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
      } catch {

      }
    }
  });

  it("still spawns in the suite's own configuration", () => {

    const launched = launchAgent(spec("legitimately-spawned"));

    try {
      assert.match(launched.target, /:@?\d+$|^%\d+$/, "a real tmux target came back");
      assert.equal(agentCount(), 1);
    } finally {

      try {
        execFileSync("tmux", ["kill-session", "-t", `=${sessionName()}`], { stdio: "ignore" });
      } catch {

      }
    }
  });
});
