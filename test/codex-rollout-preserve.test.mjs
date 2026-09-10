import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
after(() => rmSync(dirs.dataDir, { recursive: true, force: true }));

const { db, migrate } = await import("../dist/db.js");
const { reapCodexHomeForClosedAgent } = await import("../dist/spawn.js");
const { codexHomeDir, codexRolloutsDir, ensureCodexHome, preservedRolloutPath } = await import(
  "../dist/codexHome.js"
);
migrate();

const fakeAuth = join(dirs.dataDir, "..", "fake-auth.json");
writeFileSync(fakeAuth, JSON.stringify({ tokens: "not real" }));

let nextProject = 0;
let nextKey = 0;

function seedProject() {
  const n = nextProject++;
  return db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get(`codex-rollout-preserve-${n}`, `/tmp/codex-rollout-preserve-${n}`).id;
}

function seedAgentRow({ projectId, codexHome, transcriptPath }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, status, codex_home, transcript_path)
       VALUES (?, 'agent:1', 'worker', 'codex', '/tmp', 'agent', 'closed', ?, ?)
       RETURNING id`,
    )
    .get(projectId, codexHome, transcriptPath).id;
}

function buildHomeWithRollout(key) {
  ensureCodexHome({ key, actorId: "agent:1", cwd: "/tmp", brief: "hello", authSource: fakeAuth });
  const dayDir = join(codexHomeDir(key), "sessions", "2026", "09", "09");
  mkdirSync(dayDir, { recursive: true });
  const rolloutPath = join(dayDir, "rollout-x.jsonl");
  writeFileSync(rolloutPath, '{"turn":1}\n');
  return rolloutPath;
}

describe("reapCodexHomeForClosedAgent rewrites transcript_path to the preserved file (todo 919, S2)", () => {
  it("a row whose transcript_path lies inside the reaped home ends with the preserved path and codex_home cleared", () => {
    const projectId = seedProject();
    const key = `worker-${nextKey++}`;
    const rolloutPath = buildHomeWithRollout(key);
    const agentId = seedAgentRow({ projectId, codexHome: key, transcriptPath: rolloutPath });

    reapCodexHomeForClosedAgent(agentId, key);

    const row = db.prepare("SELECT codex_home, transcript_path FROM agents WHERE id = ?").get(agentId);
    assert.equal(row.codex_home, "");
    const expected = join(codexRolloutsDir(key), "2026", "09", "09", "rollout-x.jsonl");
    assert.equal(row.transcript_path, expected);
    assert.equal(existsSync(expected), true, "the preserved file the row now points at must actually exist");
    assert.equal(readFileSync(expected, "utf8"), '{"turn":1}\n');
  });

  it("a row whose transcript_path lies outside the home keeps it unchanged, and codex_home is still cleared", () => {
    const projectId = seedProject();
    const key = `worker-${nextKey++}`;
    buildHomeWithRollout(key);
    const outsidePath = "/somewhere/else/rollout-y.jsonl";
    const agentId = seedAgentRow({ projectId, codexHome: key, transcriptPath: outsidePath });

    reapCodexHomeForClosedAgent(agentId, key);

    const row = db.prepare("SELECT codex_home, transcript_path FROM agents WHERE id = ?").get(agentId);
    assert.equal(row.codex_home, "");
    assert.equal(row.transcript_path, outsidePath, "an unrelated transcript_path must not be touched");
  });

  it("a row with no transcript_path yet keeps it empty, and codex_home is still cleared", () => {
    const projectId = seedProject();
    const key = `worker-${nextKey++}`;
    buildHomeWithRollout(key);
    const agentId = seedAgentRow({ projectId, codexHome: key, transcriptPath: "" });

    reapCodexHomeForClosedAgent(agentId, key);

    const row = db.prepare("SELECT codex_home, transcript_path FROM agents WHERE id = ?").get(agentId);
    assert.equal(row.codex_home, "");
    assert.equal(row.transcript_path, "");
  });

  it("a retry after a first attempt that moved the tracked file and then failed on a second still rewrites transcript_path (fix round)", () => {
    const projectId = seedProject();
    const key = `worker-${nextKey++}`;
    const rolloutPath = buildHomeWithRollout(key);
    const agentId = seedAgentRow({ projectId, codexHome: key, transcriptPath: rolloutPath });

    // Simulate the observable state a genuine partial failure leaves: the tracked file (rollout-x)
    // already moved to its durable destination by a first attempt that then threw on a second,
    // untracked file still sitting in sessions/ - codex_home is untouched (the throw happened
    // before reapCodexHome's rmSync, per the pad's ordering requirement), and the row's
    // transcript_path is still the ORIGINAL path, exactly as a caller who never got to rewrite it
    // would leave it.
    const dest = preservedRolloutPath(key, rolloutPath);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(rolloutPath, dest);
    const secondDayDir = join(codexHomeDir(key), "sessions", "2026", "09", "10");
    mkdirSync(secondDayDir, { recursive: true });
    writeFileSync(join(secondDayDir, "rollout-z.jsonl"), '{"turn":2}\n');

    reapCodexHomeForClosedAgent(agentId, key);

    const row = db.prepare("SELECT codex_home, transcript_path FROM agents WHERE id = ?").get(agentId);
    assert.equal(row.codex_home, "");
    assert.equal(row.transcript_path, dest, "the retry must still find and point at the file an earlier attempt already preserved");
    assert.equal(existsSync(dest), true);
    assert.equal(readFileSync(dest, "utf8"), '{"turn":1}\n');
  });

  it("the losing side of a close/janitor race, running after the winner already preserved and removed the home, still rewrites transcript_path", () => {
    const projectId = seedProject();
    const key = `worker-${nextKey++}`;
    const rolloutPath = buildHomeWithRollout(key);
    const agentId = seedAgentRow({ projectId, codexHome: key, transcriptPath: rolloutPath });

    // Simulate the winner having already fully completed: the file is at its durable destination
    // and the whole home is gone, while this (losing) racer's row still carries the pre-race
    // codex_home and the original transcript_path - it has not run its own reapCodexHome yet.
    const dest = preservedRolloutPath(key, rolloutPath);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(rolloutPath, dest);
    rmSync(codexHomeDir(key), { recursive: true, force: true });

    assert.doesNotThrow(() => reapCodexHomeForClosedAgent(agentId, key));

    const row = db.prepare("SELECT codex_home, transcript_path FROM agents WHERE id = ?").get(agentId);
    assert.equal(row.codex_home, "");
    assert.equal(row.transcript_path, dest, "the loser must still converge on the winner's preserved path");
  });
});
