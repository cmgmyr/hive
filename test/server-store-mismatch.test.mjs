import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs, withEnv } from "./helpers.mjs";

// Found 2026-07-29 during the #24 lane, by it happening to that lane's own
// worker: agent 40's row read "closed" while its pane was alive and working.
//
// A worker isolating tmux for a spike set TMUX_TMPDIR to a private dir and
// started a nested claude there. That claude inherited HIVE_DATA_DIR=~/.hive,
// started its own hive MCP server as every claude session does, and its janitor
// asked the PRIVATE tmux server about a pane that lives on the shared one. It
// got an authoritative "no such pane" and closed a live worker in the real
// store.
//
// This is not issue #14. There the probe FAILED. Here it SUCCEEDS and answers
// the wrong question correctly, so #14's "did tmux answer" distinction has
// nothing to catch. These tests pin the new refusal and, just as importantly,
// pin the boundary: legitimate isolation sets a private tmux AND a scratch
// store, and that has to keep working or the whole suite stops.

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
  sessionName,
  targetLive,
  tmuxSocketPath,
  untrustedTmuxServer,
} = await import("../dist/tmux.js");
const { launchAgent } = await import("../dist/spawn.js");
migrate();

// ONE cleanup for the file. cleanup() removes the shared socket dir as well
// as killing the sessions it is given, so a per-describe call pulls TMUX_TMPDIR
// out from under every describe still to run. That is not theoretical: it
// happened here first time out, and the later janitor tests started passing
// through the guard because TMUX_TMPDIR now named a directory that was gone,
// which is precisely the bug this commit fixes.
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

// Reproduces the unsafe configuration: this process keeps its private tmux
// server (isolateTmux already set that up) and stops naming a scratch store.
//
// Safe to do here, and worth being explicit about why. dist/db.js opened the
// scratch store at import, above, and holds that handle in a module const, so
// unsetting the variable now cannot make any statement in this file reach the
// real store. The code under test never opens a store either: it compares a
// resolved path and returns. Restored immediately afterwards regardless.
const asDefaultStore = (fn) => withEnv({ HIVE_DATA_DIR: undefined }, fn);
const withTmuxTmpDir = (dir, fn) => withEnv({ TMUX_TMPDIR: dir }, fn);

// A private socket named by an inherited TMUX. tmux writes
// "<socket>,<pid>,<session>" into every pane, and only the first field matters.
const paneOn = (socket) => `${socket},12936,0`;
const SPIKE_SOCKET = "/private/tmp/tmux-501/hivespike";

describe("privateTmuxSocket asks which socket tmux will actually use", () => {
  // Every earlier version of this predicate answered a proxy question and was
  // wrong in a new way each time. These pin the three inputs in tmux's own
  // order of precedence.

  it("treats no tmux env at all as the shared server", () => {
    assert.equal(privateTmuxSocket(undefined, undefined), false);
    assert.equal(privateTmuxSocket(undefined, ""), false);
  });

  it("treats tmux's own default TMUX_TMPDIR as the shared server", () => {
    assert.equal(privateTmuxSocket(undefined, "/tmp"), false);
  });

  it("sees through the macOS /tmp symlink", () => {
    // /tmp is a symlink to /private/tmp on macOS. Naming the same directory by
    // its real path is still the shared server, and reading it as private
    // would refuse to sweep on an ordinary machine.
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
    // tmux does not create the directory, and handed one it cannot reach it
    // uses its default socket. This is the ordinary end state of every isolated
    // session: kill it, the scratch socket dir goes with it, and any shell
    // still exporting the old value now names a path that is gone.
    assert.equal(privateTmuxSocket(undefined, "/nonexistent/hive/socket/dir"), false);
  });

  it("still calls an existing directory private after one has been removed", () => {
    // The pair, so the case above cannot be satisfied by always answering false.
    const scratch = mkdtempSync(join(tmpdir(), "hive-socketgone-"));
    assert.equal(privateTmuxSocket(undefined, scratch), true);

    rmSync(scratch, { recursive: true, force: true });

    assert.equal(privateTmuxSocket(undefined, scratch), false, "the same path, once gone, is shared");
  });

  it("takes an inherited TMUX over TMUX_TMPDIR, in both directions", () => {
    // THE HOLE THAT SHIPPED, and the reason this predicate now takes two
    // arguments. Inside a pane tmux exports the socket it is on, and a tmux
    // client started there talks to THAT socket regardless of TMUX_TMPDIR.
    // Measured inside a real `tmux -L hivespike` pane, both halves.
    //
    // Blind: a -L server sets no TMUX_TMPDIR, so the old predicate read
    // "shared" and the janitor closed live rows whose panes are elsewhere.
    assert.equal(
      privateTmuxSocket(paneOn(SPIKE_SOCKET), undefined),
      true,
      "a -L server is private even with TMUX_TMPDIR unset",
    );
    // And refusing wrongly: a pane on the SHARED server with a stray
    // TMUX_TMPDIR exported is still on the shared socket, so hive must not
    // refuse to sweep it.
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
  // privateTmuxSocket is now built on a claim about tmux, so the claim gets a
  // test rather than a comment. If a future tmux starts creating TMUX_TMPDIR,
  // or starts erroring instead of falling back, this fails and says so
  // directly instead of leaving hive quietly refusing to sweep.
  //
  // Everything here runs against this file's own isolated server. The one call
  // made with a missing TMUX_TMPDIR reaches whatever the DEFAULT socket is,
  // which on a developer machine is their real server, so it is a read that
  // asserts only on the absence of this file's own session name. It never
  // writes, and it never names a session it did not create.
  const session = fallbackSession;
  const missing = join(tmpdir(), `hive-no-such-socket-dir-${process.pid}`);

  before(() => {
    if (!hasTmux) return;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  });

  it("does not create TMUX_TMPDIR, and falls back to the shared socket when it is missing", () => {
    // This used to swallow every tmux error into listed = "" and then assert
    // that the private session was absent, which is true of ANY failure. On a
    // CI runner with no server on the default socket it was vacuous every run,
    // and it pinned "not the private socket" while never pinning "the shared
    // socket" -- which is the half privateTmuxSocket actually depends on.
    //
    // tmux names the socket it tried in its own failure text, so the fallback
    // can be pinned positively without needing a server to exist. Both outcomes
    // are asserted: either it listed sessions (a server is there) or it said it
    // could not reach the DEFAULT socket. An arbitrary failure now fails.
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
    // The control. Without it the test above passes on a tmux that cannot find
    // any server at all.
    const listed = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
    });

    assert.ok(listed.split("\n").includes(session), "the private socket must still resolve normally");
  });
});

describe("hive refuses to read liveness off a tmux server its store does not live on", () => {
  beforeEach(reset);

  it("refuses when a private tmux server is paired with the default store", () => {
    // The reported configuration, exactly: private tmux, default store.
    assert.equal(asDefaultStore(() => untrustedTmuxServer()), true);
  });

  it("allows the suite's own configuration: private tmux AND a scratch store", () => {
    // The boundary that decides whether this fix is usable at all. Every test
    // in this repo runs on a private tmux server, and isolating tmux is the
    // documented advice. Refusing on a private socket alone would break all of
    // it while fixing nothing: the danger is the PAIRING with the shared
    // store, not the isolation.
    assert.equal(untrustedTmuxServer(), false);
    assert.notEqual(liveTargets(), null, "the suite must still get real liveness answers");
  });

  it("allows the everyday case: the shared tmux server and the default store", () => {
    // A human running hive normally sets no TMUX_TMPDIR at all. This must stay
    // completely untouched.
    withTmuxTmpDir(undefined, () => {
      assert.equal(asDefaultStore(() => untrustedTmuxServer()), false);
    });
    withTmuxTmpDir("/tmp", () => {
      assert.equal(asDefaultStore(() => untrustedTmuxServer()), false);
    });
  });

  it("refuses inside a pane on a private server, with TMUX_TMPDIR unset", () => {
    // The configuration the suite could not see. isolateTmux clears TMUX,
    // which is exactly the variable that decides the socket in production, so
    // every test here ran against an environment no real hive session has.
    // Setting it back is the only way this branch gets exercised at all.
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
    // The other half, and the one that would break every real user: a normal
    // hive session runs inside tmux on the shared socket.
    withEnv({ TMUX: paneOn(defaultTmuxSocketPath()), TMUX_TMPDIR: undefined }, () => {
      assert.equal(asDefaultStore(() => untrustedTmuxServer()), false);
    });
  });

  it("answers unknown rather than dead, so #14's handling carries it", () => {
    // null, not false. Everything downstream already treats unknown
    // conservatively because issue #14 made it, so the whole refusal rides on
    // plumbing that exists. Answering false would close every agent instead.
    asDefaultStore(() => {
      assert.equal(liveTargets(), null, "the batch probe must answer unknown");
      assert.equal(targetLive("%9999"), null, "and so must the single-target one");
    });
  });
});

describe(
  "an empty tmux_target is never live (todo 180)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("list-panes -t '' resolves to a real session instead of erroring, the reproduction the fix rests on", () => {
      // The lead's own reproduction against this file's isolated server, kept
      // as a live check rather than a comment: fallbackSession (set up above)
      // is still running at this point in the file, and an empty target
      // silently answers with ITS pane rather than failing the way a dead
      // target does. A future tmux that started erroring instead would fail
      // this test, not targetLive('')'s below, which is the point of keeping
      // both.
      const out = execFileSync("tmux", ["list-panes", "-t", ""], { encoding: "utf8" });
      assert.match(out, /%\d+/, "an empty target answers with a real pane id, not an error");
    });

    it("targetLive('') is always false, without ever asking tmux", () => {
      // Same server, same live session as the test above - if targetLive
      // reached tmux for an empty target the way it used to, this would come
      // back true (or, off the default store, null), never false.
      assert.equal(targetLive(""), false);
    });
  },
);

describe("the janitor sweeps nothing when it cannot trust the server it probed", () => {
  beforeEach(reset);

  it("closes a row whose pane is really gone, as it always has", () => {
    // The control. Without this the refusal below could be satisfied by a
    // janitor that never sweeps anything at all, which would be a worse bug
    // than the one being fixed: stale rows pile up forever.
    const agent = agentRow("really-gone", "%9600");

    const result = janitor();

    assert.equal(result.probed, true, "a private tmux with a scratch store is a server hive trusts");
    assert.equal(result.closed_agents, 1);
    assert.equal(agentStatus(agent), "closed");
  });

  it("leaves a live worker's row alone when the store belongs to another server", () => {
    // The regression pin, and the whole bug. These rows name panes on the
    // shared tmux server. This process is talking to a private one, which will
    // answer, correctly, that it has never heard of them. Believing it closed
    // a live worker mid-lane.
    const first = agentRow("live-elsewhere", "%9601");
    const second = agentRow("also-live-elsewhere", "%9602");

    const result = asDefaultStore(() => janitor());

    assert.deepEqual(result, { closed_agents: 0, cancelled_timers: 0, probed: false });
    assert.equal(agentStatus(first), "running", "a correct answer from the wrong server closes nothing");
    assert.equal(agentStatus(second), "running");
  });

  it("sweeps nothing inside a pane on a private server", () => {
    // The end-to-end version of the hole: TMUX names a -L socket, TMUX_TMPDIR
    // is unset, the store is the default one. Before the predicate took TMUX
    // into account this swept every row.
    const first = agentRow("live-on-shared", "%9701");
    const second = agentRow("also-live-on-shared", "%9702");

    const result = withEnv({ TMUX: paneOn(SPIKE_SOCKET), TMUX_TMPDIR: undefined }, () =>
      asDefaultStore(() => janitor()),
    );

    assert.deepEqual(result, { closed_agents: 0, cancelled_timers: 0, probed: false });
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
  // The write half. Refusing to READ liveness off a tmux server this store does
  // not live on is only half a fix while the write path keeps putting that
  // server's pane ids INTO the store: sessionName() returns the untagged
  // hive-main for the default store, ensureSession creates a second one on the private
  // server, and that server numbers panes from zero, so the row lands in the
  // shared store naming a pane id that very likely exists there belonging to
  // someone else. agent_send would type into it; agent_close would kill it.
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

    // The refusal sits ABOVE the INSERT on purpose. launchAgent puts the row
    // first so a rejection never leaves a half-built pane; refusing after it
    // would trade that for an orphan row instead.
    assert.equal(agentCount(), before, "the refusal must not leave a row behind");
  });

  it("names both halves of the pairing, so the way out is obvious", () => {
    // The same shape as doctor's message. A refusal that says only "refused"
    // sends someone hunting through source for which variable to change.
    let message = "";
    try {
      asDefaultStore(() => launchAgent(spec("message-check")));
    } catch (e) {
      message = e.message;
    }

    assert.match(message, /TMUX_TMPDIR/, "names the tmux half");
    assert.match(message, /HIVE_DATA_DIR|default store/, "names the store half");
    // Was /agent_close would kill|kill/, whose second branch subsumes the
    // first: any message containing "kill" passed, so the refusal could be
    // reworded to name nothing and stay green.
    assert.match(message, /agent_close would kill/, "says what the damage would be");
  });

  it("refuses hive lead and hive attach too, at the session they both create", () => {
    // launchAgent had its own gate, but cmdLead and cmdAttach call
    // ensureSession directly, so the write half was not actually closed. Under
    // the bad pair hive attach created a SECOND hive-1 on the private server
    // and attached the user to an empty session while the real lead and its
    // workers sat on the shared one.
    //
    // The refusal lives in ensureSession rather than at the two call sites,
    // because that is the one function that creates a session on whatever
    // server this process reaches.
    assert.throws(
      () => asDefaultStore(() => ensureSession("hive-should-never-exist", projectDir)),
      /Refusing to create a tmux session/,
    );
  });

  it("still creates a session in the suite's own configuration", () => {
    // The control for the gate above.
    const name = `hive-ensure-ok-${process.pid}`;
    try {
      assert.equal(ensureSession(name, projectDir).created, true, "a legitimate pairing still creates one");
      assert.equal(ensureSession(name, projectDir).created, false, "and is idempotent on the second call");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" });
      } catch {
        // Never started, or already gone.
      }
    }
  });

  it("still spawns in the suite's own configuration", () => {
    // The control, and the whole reason the boundary matters. A gate that
    // refused here would break every spawning test in the repo. Those tests are
    // the distributed version of this assertion; this is the local one, so a
    // reader does not have to take the rest of the suite on faith.
    const launched = launchAgent(spec("legitimately-spawned"));

    try {
      assert.match(launched.target, /:@?\d+$|^%\d+$/, "a real tmux target came back");
      assert.equal(agentCount(), 1);
    } finally {
      // kill-session directly, NOT cleanup(): cleanup removes the shared socket
      // dir along with the session, which is the trap documented at the top of
      // this file and the one that already bit it once. Never kill-server.
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${sessionName()}`], { stdio: "ignore" });
      } catch {
        // Never started, or already gone.
      }
    }
  });
});

// NOT TESTED HERE, deliberately, rather than by oversight: doctor's branch that
// names this refusal instead of saying "re-run when tmux responds". Reaching it
// needs a hive process using the DEFAULT store, and guardStoreDir exits any
// process that tries under a test runner, so a spawned `hive doctor` dies
// before doctor's body runs. A test that asserted untrustedTmuxServer() again
// and called itself a doctor test would only be restating the block above.
