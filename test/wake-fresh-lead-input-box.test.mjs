import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScratchStore, clearHiveEnv, isolateTmux, leadRow, runCli, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the fresh-lead wake input-box tests");
const { dataDir, projectDir, tmp } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { sessionName, tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const session = `fresh-lead-${process.pid}`;
const sessions = [session];
const received = join(tmp, "received.txt");
const dropped = join(tmp, "dropped.txt");
const ready = join(tmp, "ready.txt");
const fakeBin = join(tmp, "fake-bin");
mkdirSync(fakeBin);
const fake = join(fakeBin, "claude");
writeFileSync(fake, [
  "#!/bin/bash",
  "sleep 2",
  `while read -t 0.1 -r line; do printf '%s\\n' "$line" >> '${dropped}'; done`,
  `cat '${join(process.cwd(), "test/fixtures/panes/ready-idle.txt")}'`,
  `touch '${ready}'`,
  `exec cat >> '${received}'`,
  "",
].join("\n"));
chmodSync(fake, 0o755);

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
after(() => cleanup(...sessions, sessionName()));

function createLeadWake({ command = "claude", ageSeconds = 0, clearAgeSeconds = null, name }) {
  sessions.push(name);
  const cwd = mkdtempSync(join(tmp, `${name}-project-`));
  execFileSync("tmux", [
    "-S", socket, "new-session", "-d", "-s", name, "-x", "220", "-y", "50", "sleep", "600",
  ], { encoding: "utf8" });
  const target = execFileSync("tmux", ["-S", socket, "list-panes", "-t", `=${name}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
  const panePid = execFileSync("tmux", ["-S", socket, "display-message", "-p", "-t", target, "#{pane_pid}"], {
    encoding: "utf8",
  }).trim();
  const actorId = `lead:fresh-box-${process.pid}-${name}`;
  const projectId = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get(name, cwd).id;
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status)
     VALUES (?, ?, 'lead', ?, ?, ?, ?, ?, 'lead', 'running')`,
  ).run(projectId, actorId, target, socket, panePid, command, cwd);
  db.prepare(
    `INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
     VALUES (?, 'lead_pane_start', 'unknown', ?, datetime('now', ?))`,
  ).run(actorId, panePid, `-${ageSeconds} seconds`);
  if (clearAgeSeconds !== null) {
    db.prepare(
      `INSERT INTO agent_state_log (actor_id, event, state, payload, created_at)
       VALUES (?, 'session_start', 'unknown', ?, datetime('now', ?))`,
    ).run(actorId, JSON.stringify({ source: "clear", session_id: `session-${name}` }), `-${clearAgeSeconds} seconds`);
  }
  const wakeId = db.prepare(
    `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at)
     VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds')) RETURNING id`,
  ).get(projectId, actorId, "unchanged codex lead marker", actorId, target).id;
  return { actorId, pane: target, wakeId };
}

it(
  "a wake due when a fresh lead pane starts waits for the input box, not the pane",
  needsTmux,
  async () => {
    const leadStart = await runCli(["lead", projectDir, "--detach"], {
      cwd: projectDir,
      dataDir,
      tmp,
      env: { PATH: `${fakeBin}:${process.env.PATH}` },
    });
    assert.equal(leadStart.code, 0, leadStart.stderr);
    const lead = leadRow(db, db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id);
    const actorId = lead.actor_id;
    const pane = lead.tmux_target;
    const projectId = lead.project_id;
    const wakeId = db.prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at)
       VALUES (?, ?, ?, 'delay', '[]', ?, ?, datetime('now', '-1 seconds')) RETURNING id`,
    ).get(projectId, actorId, "fresh lead box marker", actorId, pane).id;

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_state_log WHERE actor_id = ? AND event = 'session_start'").get(actorId).n, 0);
    assert.equal(
      db.prepare("SELECT payload FROM agent_state_log WHERE actor_id = ? AND event = 'lead_pane_start'").get(actorId).payload,
      lead.pane_pid,
    );

    await tick();

    const held = db.prepare("SELECT held_at, held_reason, typed_at, typed_seen FROM wakes WHERE id = ?").get(wakeId);
    assert.ok(held.held_at, "the wake stays pending during the lead's input-box boot window");
    assert.match(held.held_reason, /input box is not on screen yet/i);
    assert.equal(held.typed_at, null, "a booting lead pane must not consume the wake");
    assert.equal(held.typed_seen, null, "the wake must not be recorded as typed into the booting pane");

    assert.ok(await until(() => existsSync(ready), 5000), "the fake lead eventually renders its input box");
    await tick();
    assert.ok(await until(() => readFileSync(received, "utf8").includes(`[hive wake #${wakeId}`), 5000));
    assert.match(db.prepare("SELECT typed_seen FROM wakes WHERE id = ?").get(wakeId).typed_seen, /box=empty/);
    assert.equal(existsSync(dropped) ? readFileSync(dropped, "utf8") : "", "", "nothing was typed before the box rendered");
  },
);

it("a Claude lead delivers after the 60-second fresh-session box window expires", needsTmux, async () => {
  const name = `fresh-bound-${process.pid}`;
  const { wakeId } = createLeadWake({ ageSeconds: 61, clearAgeSeconds: 0, name });
  await tick();
  const wake = db.prepare("SELECT typed_at, held_reason, typed_seen FROM wakes WHERE id = ?").get(wakeId);
  assert.ok(wake.typed_at, "the expired boot window preserves the prior delivery behavior");
  assert.doesNotMatch(wake.held_reason ?? "", /input box is not on screen yet/i);
  assert.match(wake.typed_seen, /box=absent/);
});

it("a codex lead keeps its existing no-box delivery behavior", needsTmux, async () => {
  const name = `fresh-codex-${process.pid}`;
  const { wakeId } = createLeadWake({ command: "codex", name });
  await tick();
  const wake = db.prepare("SELECT typed_at, held_reason, typed_seen FROM wakes WHERE id = ?").get(wakeId);
  assert.ok(wake.typed_at, "Codex remains on the existing classifier path");
  assert.doesNotMatch(wake.held_reason ?? "", /input box is not on screen yet/i);
  assert.match(wake.typed_seen, /box=absent/);
});

it("a Claude lead capture failure skips delivery without stamping typed_at", needsTmux, async () => {
  const name = `fresh-capture-${process.pid}`;
  const { wakeId } = createLeadWake({ name });
  const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const bin = join(tmp, "failing-tmux-bin");
  mkdirSync(bin);
  const wrapper = join(bin, "tmux");
  writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" capture-pane "*) exit 1;; esac\nexec '${realTmux}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await tick();
  } finally {
    process.env.PATH = originalPath;
  }
  const wake = db.prepare("SELECT typed_at, held_at, typed_seen FROM wakes WHERE id = ?").get(wakeId);
  assert.equal(wake.typed_at, null, "a failed screen observation must not stamp a delivery");
  assert.equal(wake.held_at, null, "capture failure retries next tick instead of creating a lasting hold");
  assert.equal(wake.typed_seen, null, "an unobserved box must not be recorded as empty or absent");
});
