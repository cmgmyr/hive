import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { REPO, assertScratchStore, clearHiveEnv, isolateTmux, runFixture, scratchDirs } from "./helpers.mjs";

const { hasTmux } = isolateTmux("synthetic usage limit evidence from findings-limit-fork-spike");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
process.env.CLAUDE_CONFIG_DIR = join(dirs.tmp, "claude");
process.env.TZ = "America/New_York";
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { observeClaudeStopFailure, observeUsageLimit, usageLimitGate } = await import("../dist/usageLimit.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const projectId = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("usage-limit-synthetic", dirs.projectDir).id;
const sessionId = "synthetic-claude-session";
const cwd = join(dirs.projectDir, "worker");
const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[/.]/g, "-"));
mkdirSync(transcriptDir, { recursive: true });
const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
const at = Date.UTC(2026, 10, 1, 15, 0);

function agent({ name, transcript = transcriptPath } = {}) {
  return db.prepare(`INSERT INTO agents
    (project_id, actor_id, name, tmux_target, command, cwd, status, kind, pane_pid, session_id, transcript_path)
    VALUES (?, ?, ?, '', 'claude', ?, 'running', 'agent', '101', ?, ?) RETURNING id`)
    .get(projectId, `agent:${name ?? Math.random()}`, name ?? "synthetic", cwd, sessionId, transcript).id;
}

function rejectedQuotaRecord() {
  return JSON.stringify({
    type: "assistant", sessionId, isApiErrorMessage: true, error: "rate_limit",
    apiError: "usage_limit_reached",
    quotaLimits: { status: "rejected", resetsAt: Math.floor((at + 2 * 60 * 60 * 1000) / 1000) },
  });
}

describe("usage limit episode reducer from findings-limit-fork-spike A1-A2 synthetic records", () => {
  it("R1 owns the Claude transcript evidence and persists its episode across a second read", () => {
    writeFileSync(transcriptPath, `${rejectedQuotaRecord()}\n`);
    const id = agent({ name: "owned" });

    observeUsageLimit(id, at);
    const first = db.prepare("SELECT * FROM agent_usage_limits WHERE agent_id = ?").get(id);
    observeUsageLimit(id, at + 30_000);
    const second = db.prepare("SELECT * FROM agent_usage_limits WHERE agent_id = ?").get(id);

    assert.equal(first.signal_key, second.signal_key);
    assert.equal(first.observed_at, second.observed_at);
    assert.equal(usageLimitGate(id, at + 30_000).held, true);
    const modulePath = JSON.stringify(join(new URL("../dist/usageLimit.js", import.meta.url).pathname));
    const dbPath = JSON.stringify(join(new URL("../dist/db.js", import.meta.url).pathname));
    const restarted = runFixture(dirs.tmp, "usage-limit-second-server", `
      const { db, migrate } = await import(${dbPath});
      migrate();
      const { usageLimitGate } = await import(${modulePath});
      process.stdout.write(JSON.stringify(usageLimitGate(${id}, ${at + 30_000})));
      db.close();
    `, { HIVE_DATA_DIR: dirs.dataDir });
    assert.deepEqual(restarted, { held: true, until: first.expires_at });
  });

  it("does not release or upsert a newer episode from a stale pane and session observation", () => {
    writeFileSync(transcriptPath, `${rejectedQuotaRecord()}\n`);
    const id = agent({ name: "stale-observer" });
    db.prepare(`INSERT INTO agent_usage_limits
      (agent_id, project_id, harness, pane_pid, session_id, signal_key, observed_at, reset_at, expires_at, continue_claimed_at)
      VALUES (?, ?, 'claude', '101', ?, 'P0-S0', datetime('now'), NULL, datetime('now', '+2 hours'), datetime('now', '-1 minute'))`)
      .run(id, projectId, sessionId);

    const originalPrepare = db.prepare.bind(db);
    let installedNewerEpisode = false;
    let expectedNewerEpisode;
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (sql === "SELECT * FROM agent_usage_limits WHERE agent_id = ?") {
        return {
          get(...args) {
            if (!installedNewerEpisode) {
              installedNewerEpisode = true;
              originalPrepare("UPDATE agents SET pane_pid = '202', session_id = 'P1-S1' WHERE id = ?").run(id);
              originalPrepare(`UPDATE agent_usage_limits SET pane_pid = '202', session_id = 'P1-S1', signal_key = 'P1-S1',
                observed_at = datetime('now'), reset_at = NULL, expires_at = datetime('now', '+4 hours'), released_at = NULL
                WHERE agent_id = ?`).run(id);
              expectedNewerEpisode = originalPrepare(`SELECT project_id, pane_pid, session_id, signal_key, released_at, continue_claimed_at
                FROM agent_usage_limits WHERE agent_id = ?`).get(id);
            }
            return statement.get(...args);
          },
        };
      }
      return statement;
    };
    try {
      observeUsageLimit(id, at);
    } finally {
      db.prepare = originalPrepare;
    }

    const episode = db.prepare(`SELECT project_id, pane_pid, session_id, signal_key, released_at, continue_claimed_at
      FROM agent_usage_limits WHERE agent_id = ?`).get(id);
    assert.deepEqual(episode, expectedNewerEpisode);
    assert.equal(installedNewerEpisode, true);
  });

  it("R2 rejects foreign transcript paths and warning records below 100 percent", () => {
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", error: "rate_limit", isApiErrorMessage: true }) + "\n");
    const foreign = agent({ name: "foreign", transcript: join(dirs.tmp, "other-project.jsonl") });
    observeUsageLimit(foreign, at);
    assert.equal(db.prepare("SELECT 1 FROM agent_usage_limits WHERE agent_id = ?").get(foreign), undefined);

    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", quotaLimits: { status: "warning" } }) + "\n");
    const warning = agent({ name: "warning" });
    observeUsageLimit(warning, at);
    assert.equal(db.prepare("SELECT 1 FROM agent_usage_limits WHERE agent_id = ?").get(warning), undefined);
  });

  it("R5 does not rearm an unknown reset from the same A2 signal", () => {
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", sessionId, error: "rate_limit", isApiErrorMessage: true, quotaLimits: { status: "rejected" } }) + "\n");
    const id = agent({ name: "unknown-reset" });
    observeUsageLimit(id, at);
    const original = db.prepare("SELECT observed_at, expires_at FROM agent_usage_limits WHERE agent_id = ?").get(id);
    const deadline = Date.parse(`${original.expires_at.replace(" ", "T")}Z`);

    observeUsageLimit(id, deadline + 1);

    const after = db.prepare("SELECT observed_at, expires_at FROM agent_usage_limits WHERE agent_id = ?").get(id);
    assert.deepEqual(after, original);
    assert.equal(deadline - at, 6 * 60 * 60 * 1000);
    assert.equal(usageLimitGate(id, deadline + 1).held, false);
  });

  it("R5 ignores a partial final token record from the spike A2 envelope", () => {
    const id = agent({ name: "partial" });
    appendFileSync(transcriptPath, "{\"type\":\"assistant\",\"error\":\"rate_limit\",\"isApiErrorMessage\":true,\"quotaLimits\":{\"status\":\"rejected\"}}\n{");
    observeUsageLimit(id, at);
    assert.equal(db.prepare("SELECT 1 FROM agent_usage_limits WHERE agent_id = ?").get(id), undefined);
  });

  it("reset parser handles spike A1 timezone, weekday, year rollover and past-clock forms", () => {
    writeFileSync(transcriptPath, "");
    const cases = [
      ["resets 3:45pm", Date.UTC(2026, 10, 1, 14), "2026-11-01T20:45:00.000Z"],
      ["resets Mon 12:00am", Date.UTC(2026, 10, 1, 14), "2026-11-02T05:00:00.000Z"],
      ["resets Oct 2 at 3am (America/New_York)", Date.UTC(2026, 10, 1, 14), "2027-10-02T07:00:00.000Z"],
      ["resets 8:30pm (America/New_York)", Date.UTC(2026, 10, 1, 14), "2026-11-02T01:30:00.000Z"],
    ];
    for (const [resetText, nowMs, expected] of cases) {
      const id = agent({ name: `reset-${resetText}` });
      observeClaudeStopFailure(id, {
        session_id: sessionId,
        transcript_path: transcriptPath,
        error: "rate_limit",
        last_assistant_message: `You've hit your session limit · ${resetText}`,
      }, nowMs);
      assert.equal(db.prepare("SELECT reset_at FROM agent_usage_limits WHERE agent_id = ?").get(id).reset_at, expected);
    }
    const invalid = agent({ name: "invalid-zone" });
    observeClaudeStopFailure(invalid, {
      session_id: sessionId,
      transcript_path: transcriptPath,
      error: "rate_limit",
      last_assistant_message: "You've hit your session limit · resets 3:45pm (Not/A_Zone)",
    }, Date.UTC(2026, 10, 1, 14));
    assert.equal(db.prepare("SELECT reset_at FROM agent_usage_limits WHERE agent_id = ?").get(invalid).reset_at, null);
  });

  it("R2 accepts an owned Codex token_count snapshot only with spike A1 limit pane text", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const { row, pane, session } = codexAgent("limited", "codex-token-count-limited.jsonl", "codex-limit-curly.txt");
    try {
      observeUsageLimit(row, Date.now());
      const episode = db.prepare("SELECT harness, reset_at FROM agent_usage_limits WHERE agent_id = ?").get(row);
      assert.equal(episode.harness, "codex");
      assert.equal(episode.reset_at, new Date(1793555100 * 1000).toISOString());
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    }
  });

  it("R2 rejects the spike A2 Codex warning snapshot below 100 percent despite spike A1 pane text", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const { row, session } = codexAgent("warning-codex", "codex-token-count-warning.jsonl", "codex-limit-ascii.txt");
    try {
      observeUsageLimit(row, Date.now());
      assert.equal(db.prepare("SELECT 1 FROM agent_usage_limits WHERE agent_id = ?").get(row), undefined);
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    }
  });
});

function codexAgent(name, snapshotFixture, paneFixture) {
  const session = `usage-limit-${process.pid}-${name}`;
  const fixtureDir = join(REPO, "test", "fixtures", "usage-limits");
  const paneFile = join(fixtureDir, paneFixture);
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", dirs.tmp, `cat ${paneFile}; sleep 60`], { stdio: "ignore" });
  const [pane, pid] = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" }).trim().split("\t");
  const key = `synthetic-${name}`;
  const codexSessionId = `synthetic-${name}-session`;
  const rollout = join(dirs.dataDir, "codex-homes", key, "sessions", "2026", "11", "01", `rollout-${codexSessionId}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, readFileSync(join(fixtureDir, snapshotFixture), "utf8"));
  const row = db.prepare(`INSERT INTO agents
    (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, status, kind, session_id, codex_home, transcript_path)
    VALUES (?, ?, ?, ?, ?, ?, 'codex', ?, 'running', 'agent', ?, ?, ?) RETURNING id`)
    .get(projectId, `agent:${name}`, name, pane, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), pid, dirs.tmp, codexSessionId, key, rollout).id;
  return { row, pane, session };
}
