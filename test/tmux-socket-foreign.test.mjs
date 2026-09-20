import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the foreign-socket liveness tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { janitor, tick } = await import("../dist/scheduler.js");
const { isLive } = await import("../dist/tools/agents.js");
const { foreignSocket, rowLive, rowAlive, tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("tmux-socket-foreign-test", dirs.projectDir).id;

const session = `hive-foreign-socket-${process.pid}`;
let livePane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], { stdio: "ignore" });
  livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
});

after(() => cleanup(session));

function reset() {
  db.exec("DELETE FROM wakes; DELETE FROM agents;");
}

function agentRow(name, target, { age = "-60 seconds", socket = "" } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status,
         agent_state, created_at)
       VALUES (?, ?, ?, ?, ?, 'claude', '/tmp', 'running', 'working', datetime('now', ?))
       RETURNING id`,
    )
    .get(project, `agent:${name}`, name, target, socket, age).id;
}

function timerRow({ pane, deliverActor = "user:test", due = "+1 hour" }) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane, due_at, created_at)
       VALUES (?, 'user:test', 'wake body', ?, ?, datetime('now', ?), datetime('now', '-60 seconds'))
       RETURNING id`,
    )
    .get(project, deliverActor, pane, due).id;
}

const agentStatus = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;
const timerOf = (id) => db.prepare("SELECT * FROM wakes WHERE id = ?").get(id);

describe("foreignSocket/rowLive/rowAlive: the predicate itself, no tmux fork needed", () => {
  it("'' is never foreign - D2, the load-bearing call", () => {
    assert.equal(foreignSocket(""), false);
  });

  it("this process's own socket is never foreign", () => {
    assert.equal(foreignSocket(ownSocket), false);
  });

  it("a different socket is foreign", () => {
    assert.equal(foreignSocket(FOREIGN_SOCKET), true);
  });

  it("rowLive/rowAlive short-circuit to null on a foreign socket without ever needing to probe tmux", () => {

    assert.equal(rowLive(FOREIGN_SOCKET, "%not-a-real-target-at-all"), null);
    assert.equal(
      rowAlive(FOREIGN_SOCKET, "%not-a-real-target-at-all", { panes: new Set(), windows: new Set() }),
      null,
    );
  });
});

describe(
  "isLive: a foreign-socket agents row reads unknown, never dead - even for a genuinely live pane",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("reads null for a foreign socket, even though the pane is really alive", () => {
      const agent = { status: "running", tmux_target: livePane, tmux_socket: FOREIGN_SOCKET };
      assert.equal(isLive(agent), null, "a foreign socket must never be believed, alive or dead");
    });

    it("control: reads true for this process's own socket against the same live pane", () => {
      const agent = { status: "running", tmux_target: livePane, tmux_socket: ownSocket };
      assert.equal(isLive(agent), true, "the matching-socket case must behave exactly as before this lane");
    });

    it("control: reads true for a legacy empty socket against the same live pane", () => {
      const agent = { status: "running", tmux_target: livePane, tmux_socket: "" };
      assert.equal(isLive(agent), true, "an empty socket is 'no fact recorded', not foreign - D2");
    });
  },
);

describe(
  "janitor's agents sweep never closes a foreign-socket row, even one whose pane is genuinely dead",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    it("leaves a foreign-socket row running", () => {
      const agent = agentRow("foreign-dead", "%9500", { socket: FOREIGN_SOCKET });

      const result = janitor();

      assert.equal(agentStatus(agent), "running", "a row this process cannot honestly judge must not be swept");
      assert.equal(result.closed_agents, 0);
    });

    it("control: closes a matching-socket row with the identical dead target", () => {
      const agent = agentRow("matching-dead", "%9501", { socket: ownSocket });

      const result = janitor();

      assert.equal(agentStatus(agent), "closed", "the matching-socket case must still sweep, exactly as before");
      assert.equal(result.closed_agents, 1);
    });

    it("control: closes a legacy empty-socket row with the identical dead target", () => {
      const agent = agentRow("legacy-dead", "%9502", { socket: "" });

      const result = janitor();

      assert.equal(agentStatus(agent), "closed", "an empty socket must still sweep exactly as before this lane");
      assert.equal(result.closed_agents, 1);
    });
  },
);

describe(
  "janitor's wake sweep never cancels a wake whose delivery target joins to a foreign-socket agents row",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    it("leaves the timer pending when its deliver_actor's own agents row carries a foreign socket", () => {
      agentRow("foreign-timer-owner", "%irrelevant-own-target", { socket: FOREIGN_SOCKET });
      const timer = timerRow({ pane: "%9600", deliverActor: "agent:foreign-timer-owner" });

      const result = janitor();

      assert.equal(timerOf(timer).cancelled_at, null, "a foreign-socket join must hold the wake, not cancel it");
      assert.equal(result.cancelled_timers, 0);
    });

    it("control: cancels the identical timer when the agents row's socket matches this process", () => {
      agentRow("matching-timer-owner", "%irrelevant-own-target", { socket: ownSocket });
      const timer = timerRow({ pane: "%9601", deliverActor: "agent:matching-timer-owner" });

      const result = janitor();

      assert.notEqual(timerOf(timer).cancelled_at, null, "a matching socket must still cancel exactly as before");
      assert.equal(result.cancelled_timers, 1);
    });

    it("control: cancels the identical timer when deliver_actor names no agents row at all (a plain user: session)", () => {
      const timer = timerRow({ pane: "%9602", deliverActor: "user:some-session" });

      const result = janitor();

      assert.notEqual(
        timerOf(timer).cancelled_at,
        null,
        "a LEFT JOIN miss must read as '' (no fact recorded), not foreign, and still sweep as before",
      );
      assert.equal(result.cancelled_timers, 1);
    });

    it("leaves the timer pending when the ONLY matching agents row is CLOSED and carries a foreign socket (R2-1)", () => {
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, created_at)
         VALUES (?, 'agent:closed-foreign-timer', 'closed-foreign-timer', '%stale', ?, 'claude', '/tmp', 'closed', datetime('now', '-1 hour'))`,
      ).run(project, FOREIGN_SOCKET);
      const timer = timerRow({ pane: "%9700", deliverActor: "agent:closed-foreign-timer" });

      const result = janitor();

      assert.equal(
        timerOf(timer).cancelled_at,
        null,
        "a closed row's own recorded foreign socket must still hold the wake, not cancel it - R2-1",
      );
      assert.equal(result.cancelled_timers, 0);
    });

    it("control: cancels the identical timer when the ONLY matching agents row is CLOSED but carries a MATCHING socket", () => {
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, created_at)
         VALUES (?, 'agent:closed-local-timer', 'closed-local-timer', '%stale', ?, 'claude', '/tmp', 'closed', datetime('now', '-1 hour'))`,
      ).run(project, ownSocket);
      const timer = timerRow({ pane: "%9701", deliverActor: "agent:closed-local-timer" });

      const result = janitor();

      assert.notEqual(
        timerOf(timer).cancelled_at,
        null,
        "a closed row's own matching socket must still sweep exactly as before R2-1's fix",
      );
      assert.equal(result.cancelled_timers, 1);
    });
  },
);

describe(
  "tick()'s delivery candidates: review finding F1 - a closed lead row sharing the running lead's actor_id must not launder a foreign pane past the guard",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    function seedDuplicateActorLead() {
      const closedId = db
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, command, cwd, status, created_at)
           VALUES (?, '', 'lead', 'lead', '%stale-closed-pane', ?, 'claude', '/tmp', 'closed', datetime('now', '-1 hour'))
           RETURNING id`,
        )
        .get(project, ownSocket).id;
      const actorId = `lead:${closedId}`;
      db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, closedId);
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, command, cwd, status, created_at)
         VALUES (?, ?, 'lead', 'lead', '%running-on-foreign-server', ?, 'claude', '/tmp', 'running', datetime('now', '-60 seconds'))`,
      ).run(project, actorId, FOREIGN_SOCKET);
      return actorId;
    }

    it("never delivers into a pane this process only coincidentally shares with the running lead's foreign server", async () => {
      const actorId = seedDuplicateActorLead();

      const timer = timerRow({ pane: livePane, deliverActor: actorId, due: "-1 seconds" });

      await tick();

      const row = timerOf(timer);
      assert.equal(row.fired_at, null, "a foreign-socket lead must never be typed into a locally-alive lookalike pane");
      assert.equal(row.cancelled_at, null, "unknown liveness must hold the wake, not cancel it - D4");
    });

    it("control: delivers exactly as before when only the running row exists (no duplicate actor_id, matching socket)", async () => {
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, command, cwd, status, created_at)
         VALUES (?, 'lead:solo', 'lead', 'lead', ?, ?, 'claude', '/tmp', 'running', datetime('now', '-60 seconds'))`,
      ).run(project, livePane, ownSocket);
      const timer = timerRow({ pane: livePane, deliverActor: "lead:solo", due: "-1 seconds" });

      await tick();

      const row = timerOf(timer);
      assert.notEqual(
        row.fired_at,
        null,
        "the matching-socket, single-row case must still deliver exactly as before this lane",
      );
    });

    it("never delivers when the ONLY matching agents row is CLOSED and carries a foreign socket (R2-1)", async () => {
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, created_at)
         VALUES (?, 'agent:closed-foreign-deliver', 'closed-foreign-deliver', '%stale', ?, 'claude', '/tmp', 'closed', datetime('now', '-1 hour'))`,
      ).run(project, FOREIGN_SOCKET);
      const timer = timerRow({ pane: livePane, deliverActor: "agent:closed-foreign-deliver", due: "-1 seconds" });

      await tick();

      const row = timerOf(timer);
      assert.equal(row.fired_at, null, "a closed row's own recorded foreign socket must still hold the wake - R2-1");
      assert.equal(row.cancelled_at, null, "unknown liveness must hold the wake, not cancel it - D4");
    });

    it("control: delivers when the ONLY matching agents row is CLOSED but carries a MATCHING socket", async () => {
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, created_at)
         VALUES (?, 'agent:closed-local-deliver', 'closed-local-deliver', '%stale', ?, 'claude', '/tmp', 'closed', datetime('now', '-1 hour'))`,
      ).run(project, ownSocket);
      const timer = timerRow({ pane: livePane, deliverActor: "agent:closed-local-deliver", due: "-1 seconds" });

      await tick();

      const row = timerOf(timer);
      assert.notEqual(
        row.fired_at,
        null,
        "a closed row's own matching socket must still deliver exactly as before R2-1's fix",
      );
    });
  },
);

describe("tmuxSocketPath: review finding F3 - an unlinked socket file must not read the identical server as foreign", () => {

  const scratch = mkdtempSync(join(tmpdir(), "hive-f3-"));
  const uid = process.getuid?.() ?? 0;
  const uidDirName = `tmux-${uid}`;
  mkdirSync(join(scratch, uidDirName));
  const realSocket = join(scratch, uidDirName, "default");
  const linkDir = join(scratch, "..", `hive-f3-alias-${process.pid}`);
  symlinkSync(scratch, linkDir);
  const aliasedSocket = join(linkDir, uidDirName, "default");

  const expectedSocket = join(realpathSync(scratch), uidDirName, "default");

  after(() => {
    rmSync(linkDir, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("resolves the aliased path to the SAME canonical socket the real path resolves to, even with no leaf file at all", () => {

    const viaReal = tmuxSocketPath(`${realSocket},123,0`, undefined);
    const viaAlias = tmuxSocketPath(`${aliasedSocket},123,0`, undefined);
    assert.equal(viaReal, viaAlias, "both name the identical real directory and must canonicalise to one string");

    assert.equal(viaAlias, expectedSocket, "must canonicalise to the actual real path, not merely agree with itself");
  });

  it("keeps answering the SAME socket after the leaf that let it resolve fully is unlinked", () => {

    const fd = openSync(aliasedSocket, "w");
    closeSync(fd);
    try {
      const recorded = tmuxSocketPath(`${aliasedSocket},123,0`, undefined);
      assert.equal(recorded, expectedSocket, "must canonicalise to the actual real path, not merely agree with itself");
      unlinkSync(aliasedSocket);
      const readLater = tmuxSocketPath(`${aliasedSocket},123,0`, undefined);
      assert.equal(readLater, recorded, "the same real server must canonicalise identically before and after its socket file is unlinked");
    } finally {
      rmSync(aliasedSocket, { force: true });
    }
  });
});
