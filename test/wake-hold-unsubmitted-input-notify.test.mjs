import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { DIST, REPO, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, repaintPaneAsSameWorker, runFixture, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the unsubmitted-input notification tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);
const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;

let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir,
  ]);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

async function spawnShowing(name, shellCommand) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(shellCommand),
    extra_args: [],
    placement: "window",
  });
  await liveAgentRow(mcp, name);
  return receipt;
}

const agentRow = (name) => db.prepare("SELECT id, actor_id, tmux_target FROM agents WHERE name = ?").get(name);
const timerRow = (id) => db.prepare("SELECT * FROM timers WHERE id = ?").get(id);
const noticesAbout = (wakeId) =>
  db
    .prepare("SELECT * FROM timers WHERE id != ? AND body LIKE ? ORDER BY id")
    .all(wakeId, `%wake #${wakeId} %`);

async function ownedWake(ownerName, targetAgentId, body) {
  const wake = await mcp.call("wake_set", { delay_seconds: 5, body, deliver_to: targetAgentId });
  db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow(ownerName).actor_id, wake.wake_id);
  return wake.wake_id;
}

describe(
  "a wake held by unsubmitted human text tells its owner, once per hold episode",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "TOLD ONCE PER EPISODE: notifies the owner once, then stays silent while the box stays pending",
      async () => {
        const owner = await spawnShowing("unsub-notify-owner", replayFixture("ready-idle.txt"));
        const stuck = await spawnShowing("unsub-notify-stuck", replayFixture("real-input.txt"));
        const wakeId = await ownedWake("unsub-notify-owner", stuck.agent_id, "INTEGRATION unsub-notify original body");

        let notices;
        await until(async () => {
          notices = noticesAbout(wakeId);
          return notices.length > 0;
        }, 15000);
        assert.equal(notices.length, 1, "the hold must produce exactly one notification to the wake's owner");
        const notice = notices[0];
        assert.equal(notice.deliver_pane, owner.tmux_target, "delivered to the owner's own pane");
        assert.equal(
          notice.deliver_actor,
          agentRow("unsub-notify-owner").actor_id,
          "delivered AS that actor, not just at its pane",
        );
        assert.match(notice.body, /unsub-notify-stuck/, "it must name the pane holding the wake");
        assert.match(notice.body, /unsubmitted/, "and say what is holding it");

        const heldAtFirst = timerRow(wakeId).held_at;
        assert.ok(heldAtFirst, "the original must be recorded as held");
        await until(async () => timerRow(wakeId).held_at > heldAtFirst, 12000);
        assert.ok(
          timerRow(wakeId).held_at > heldAtFirst,
          "the scheduler must have re-held this wake on a later tick, or the count below proves nothing",
        );
        assert.equal(
          noticesAbout(wakeId).length,
          1,
          "one notification per hold episode: a per-tick version inserts one every three seconds",
        );
      },
    );

    it("RE-ARM: hold -> deliver -> hold files a second notice", async () => {
      const owner = await spawnShowing("unsub-rearm-owner", replayFixture("ready-idle.txt"));
      const stuck = await spawnShowing("unsub-rearm-stuck", replayFixture("real-input.txt"));
      const wake = await mcp.call("wake_set", {
        delay_seconds: 1,
        repeat_every_seconds: 2,
        body: "INTEGRATION unsub-rearm body",
        deliver_to: stuck.agent_id,
      });
      db.prepare("UPDATE timers SET owner = ? WHERE id = ?").run(agentRow("unsub-rearm-owner").actor_id, wake.wake_id);
      const wakeId = wake.wake_id;

      await until(async () => noticesAbout(wakeId).length > 0, 15000);
      assert.equal(noticesAbout(wakeId).length, 1, "the first hold episode notifies once");
      assert.match(timerRow(wakeId).held_reason ?? "", /unsubmitted/, "held for the input-box reason");

      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("ready-idle.txt"));
      const beforeDeliver = timerRow(wakeId).typed_at;
      await until(async () => timerRow(wakeId).typed_at !== beforeDeliver, 15000);
      assert.equal(timerRow(wakeId).held_reason, null, "delivering clears the hold, or nothing can re-arm");

      repaintPaneAsSameWorker(db, stuck.tmux_target, replayFixture("real-input.txt"));
      await until(async () => noticesAbout(wakeId).length > 1, 15000);
      assert.equal(noticesAbout(wakeId).length, 2, "a second hold episode is a second notice");
    });

    it(
      "NOBODY TO TELL: files no notice and still holds when the owner is its own delivery target",
      async () => {
        const stuck = await spawnShowing("unsub-nobody-stuck", replayFixture("real-input.txt"));
        const wakeId = await ownedWake("unsub-nobody-stuck", stuck.agent_id, "INTEGRATION unsub-nobody body");
        assert.equal(
          timerRow(wakeId).owner,
          agentRow("unsub-nobody-stuck").actor_id,
          "the fixture must really put the owner and the blocked pane on the same actor, or silence proves nothing",
        );

        await until(async () => timerRow(wakeId).held_at != null, 15000);
        assert.match(timerRow(wakeId).held_reason, /unsubmitted/, "held for the input-box reason, not lost silently");
        await until(async () => noticesAbout(wakeId).length > 0, 9000);
        assert.equal(noticesAbout(wakeId).length, 0, "nobody to tell: the owner IS the blocked pane");
        assert.equal(timerRow(wakeId).fired_at, null, "and it must not have fired either");
      },
    );

    it(
      "TRANSIENT RETRY: a tick that cannot resolve the owner's pane retries instead of latching shut",
      async () => {
        const owner = await spawnShowing("unsub-transient-owner", replayFixture("ready-idle.txt"));
        const stuck = await spawnShowing("unsub-transient-stuck", replayFixture("real-input.txt"));
        const ownerActorId = agentRow("unsub-transient-owner").actor_id;

        const wakeId = await ownedWake("unsub-transient-owner", stuck.agent_id, "INTEGRATION unsub-transient body");

        // Simulate the owner's pane being momentarily unresolvable (a tmux timeout, mid-restart):
        // ownerPaneIfLive only matches a 'running' row, so this closed row cannot be resolved.
        db.prepare("UPDATE agents SET status = 'closed' WHERE actor_id = ?").run(ownerActorId);

        await until(async () => timerRow(wakeId).held_at != null, 15000);
        assert.match(
          timerRow(wakeId).held_reason,
          /could not resolve/,
          "must hold under the transient reason, not the plain one, while the owner is unresolvable",
        );
        assert.equal(noticesAbout(wakeId).length, 0, "no notice yet: there was nobody live to tell it to");

        db.prepare("UPDATE agents SET status = 'running' WHERE actor_id = ?").run(ownerActorId);

        await until(async () => noticesAbout(wakeId).length > 0, 15000);
        assert.equal(noticesAbout(wakeId).length, 1, "the retry must file the notice once the owner resolves");
        assert.match(
          timerRow(wakeId).held_reason,
          /delivering now would paste/,
          "and converge onto the plain reason now that the notice has been filed",
        );
      },
    );
  },
);

describe("two schedulers holding the same unsubmitted-input wake", () => {
  it(
    "claims the hold and files the notice exactly once across concurrent instances",
    { skip: hasTmux ? false : "no tmux" },
    () => {
      const { dataDir, tmp } = scratchDirs();
      const spawnPane = (fixture) =>
        execFileSync("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-t", sessionName(), replayFixture(fixture)], {
          encoding: "utf8",
        }).trim();
      const stuckPane = spawnPane("real-input.txt");
      const ownerPane = spawnPane("ready-idle.txt");

      const IMPORTS =
        `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
        `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const { tmuxSocketPath } = await import(${JSON.stringify(join(DIST, "tmux.js"))});\n` +
        `migrate();\n`;

      const SEED =
        `const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);\n` +
        `const stuckPane = ${JSON.stringify(stuckPane)};\n` +
        `const ownerPane = ${JSON.stringify(ownerPane)};\n` +
        `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('cc', '/tmp/cc') RETURNING id").get().id;\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:9', 'conc-owner', ?, ?, 'claude', '/tmp', 'agent', 'running', 'idle', datetime('now', '-200 seconds'), datetime('now', '-300 seconds'))\`).run(project, ownerPane, socket);\n` +
        `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status, agent_state, state_changed_at, created_at)\n` +
        `  VALUES (?, 'agent:2', 'conc-stuck', ?, ?, 'claude', '/tmp', 'agent', 'running', 'idle', datetime('now', '-200 seconds'), datetime('now', '-300 seconds'))\`).run(project, stuckPane, socket);\n` +
        `const wakeId = db.prepare(\`INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, created_at)\n` +
        `  VALUES (?, 'agent:9', 'go on then', 'delay', 'agent:2', ?, datetime('now', '-5 seconds'), datetime('now', '-60 seconds')) RETURNING id\`).get(project, stuckPane).id;\n`;

      const TICKER =
        IMPORTS +
        `const snapshot = { panes: new Set([${JSON.stringify(stuckPane)}, ${JSON.stringify(ownerPane)}]), windows: new Set() };\n` +
        `const startAt = Number(process.env.CONC_BARRIER_AT);\n` +
        `while (Date.now() < startAt) {}\n` +
        `for (let i = 0; i < 3; i++) await tick(snapshot);\n`;

      let out;
      try {
        out = runFixture(
          tmp,
          "unsub-concurrent-runner",
          IMPORTS +
            SEED +
            `
        import { spawn } from "node:child_process";
        import { writeFileSync as write } from "node:fs";
        import { join } from "node:path";

        const tickerPath = join(${JSON.stringify(tmp)}, "unsub-concurrent-ticker.mjs");
        write(tickerPath, ${JSON.stringify(TICKER)});
        // Generous enough that both children are past their imports and their
        // own store open before either starts ticking, on a machine under load.
        const barrier = String(Date.now() + 4000);
        const run = () =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [tickerPath], {
              stdio: "inherit",
              env: { ...process.env, CONC_BARRIER_AT: barrier },
            });
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ticker exited " + code))));
          });
        await Promise.all([run(), run()]);

        const notices = db.prepare("SELECT COUNT(*) AS n FROM timers WHERE id != ? AND body LIKE ?").get(wakeId, "%wake #" + wakeId + " %").n;
        const held = db.prepare("SELECT held_reason, held_at FROM timers WHERE id = ?").get(wakeId);
        process.stdout.write(JSON.stringify({ notices, heldReason: held.held_reason, heldAt: held.held_at }));
        `,
          { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR },
        );
      } finally {
        for (const pane of [stuckPane, ownerPane]) execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });
      }

      assert.ok(out.heldAt, "the wake must really have held, or the count below proves nothing");
      assert.match(out.heldReason ?? "", /unsubmitted/, "held for the input-box reason");
      assert.equal(out.notices, 1, "the claim and the notice happen exactly once across both instances");
    },
  );
});
