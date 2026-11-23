import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { REPO, clearHiveEnv, isolateTmux, raceProcesses, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("Codex continue from synthetic findings-limit-fork-spike A1-A2 evidence");
const dirs = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { continueLimitedCodexWorkers, observeUsageLimit } = await import("../dist/usageLimit.js");
const { liveTargets, paneInCopyMode, rowOwnership, tmuxSocketPath } = await import("../dist/tmux.js");
const { paneClassifierFor } = await import("../dist/harnesses.js");
const { tick } = await import("../dist/scheduler.js");
const { sendUsageHeldMessage } = await import("../dist/leadMessageDelivery.js");
migrate();

const projectDir = join(dirs.projectDir, "usage-limit-continue");
mkdirSync(projectDir, { recursive: true });
const projectId = db.prepare("INSERT INTO projects (name, path) VALUES ('usage-limit-continue', ?) RETURNING id").get(projectDir).id;
const session = `usage-limit-continue-${process.pid}`;
const socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const sink = join(dirs.tmp, "continue.sink");
const sessions = [];
let limitedPane = "";
let limitedPanePid = "";
after(() => cleanup(...sessions));

describe("Codex continuation from synthetic findings-limit-fork-spike A1-A2 evidence", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("R8 two schedulers claim and paste one continue before pending deliveries", async () => {
    const idlePane = readFileSync(join(REPO, "test", "fixtures", "panes", "codex-idle-empty-e.txt"), "utf8");
    const paneScreen = idlePane.replace(
      /You have 1 usage limit reset available\. Run \/usage to use one\./,
      "You’ve hit your usage limit. Try again at 3:45 PM.",
    );
    const paneFile = join(dirs.tmp, "codex-limit-and-empty-input.synthetic.txt");
    writeFileSync(paneFile, paneScreen);
    writeFileSync(sink, "");
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "220", "-y", "50", `cat '${paneFile}'; stty -echo; exec cat > '${sink}'`], { stdio: "ignore" });
    sessions.push(session);
    const [pane] = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" }).trim().split("\t");
    const agentSession = "synthetic-codex-continue-session";
    const homeKey = "synthetic-continue-home";
    const rollout = join(dirs.dataDir, "codex-homes", homeKey, "sessions", "2026", "11", "01", `rollout-${agentSession}.jsonl`);
    mkdirSync(dirname(rollout), { recursive: true });
    writeFileSync(rollout, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        rate_limits: {
          rate_limit_reached_type: "rate_limit_reached",
          primary: { used_percent: 100, window_minutes: 300, resets_at: 1793555100 },
          secondary: null,
        },
      },
    }) + "\n");
    const fixedNow = 1793555200 * 1000;
    const visible = await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" }).includes("usage limit"), 5000);
    assert.ok(visible, "the synthetic A1 limit text must reach the owned test pane before observation");
    const panePid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], { encoding: "utf8" }).trim();
    limitedPane = pane;
    limitedPanePid = panePid;
    const agentId = db.prepare(`INSERT INTO agents
      (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
       session_id, codex_home, transcript_path, resumed_at)
      VALUES (?, 'agent:continue', 'continue-worker', 'agent', ?, ?, ?, 'codex', ?, 'running', ?, ?, ?, '') RETURNING id`)
      .get(projectId, pane, socket, panePid, projectDir, agentSession, homeKey, rollout).id;
    observeUsageLimit(agentId, fixedNow);
    assert.ok(db.prepare("SELECT 1 FROM agent_usage_limits WHERE agent_id = ?").get(agentId),
      `owned Codex spike A2 record did not form an episode: ${execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" })}`);
    assert.equal(paneClassifierFor("codex").choiceCheck(pane).awaitingChoice, false);
    assert.equal(paneClassifierFor("codex").inputBoxState(pane)?.state, "empty");
    assert.equal(paneInCopyMode(pane), false);
    const preflight = db.prepare(`SELECT u.reset_at, julianday(u.reset_at) AS reset_jd, julianday(datetime(?, 'unixepoch')) AS now_jd,
      u.continue_claimed_at, u.released_at, a.status, a.kind, a.resumed_at FROM agent_usage_limits u
      JOIN agents a ON a.id = u.agent_id WHERE u.agent_id = ?`).get(fixedNow / 1000, agentId);
    assert.ok(preflight.reset_jd <= preflight.now_jd, JSON.stringify(preflight));
    assert.equal(rowOwnership(db.prepare("SELECT tmux_target, tmux_socket, pane_pid FROM agents WHERE id = ?").get(agentId), liveTargets()), "live");

    const modulePath = JSON.stringify(new URL("../dist/usageLimit.js", import.meta.url).pathname);
    await raceProcesses(
      `const { continueLimitedCodexWorkers } = await import(${modulePath}); await continueLimitedCodexWorkers(${fixedNow}); process.stdout.write(JSON.stringify("done"));`,
      [[], []],
      { env: { HIVE_DATA_DIR: dirs.dataDir } },
    );

    const episode = db.prepare("SELECT continue_claimed_at, reset_at FROM agent_usage_limits WHERE agent_id = ?").get(agentId);
    assert.equal(episode.reset_at, new Date(1793555100 * 1000).toISOString());
    assert.ok(episode.continue_claimed_at);
    const typed = readFileSync(sink, "utf8") + execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
    assert.equal((typed.match(/continue/g) ?? []).length, 1, typed);
  });

  it("R9 rejects Claude, leads, unassigned workers, unknown resets and panes without spike A1 limit text", async () => {
    const now = Date.now();
    const resetAt = new Date(now - 120_000).toISOString();
    const idleSession = `${session}-no-limit`;
    const idlePaneFile = join(REPO, "test", "fixtures", "panes", "codex-idle-empty-e.txt");
    execFileSync("tmux", ["new-session", "-d", "-s", idleSession, "-x", "220", "-y", "50", `cat '${idlePaneFile}'; cat > '${join(dirs.tmp, "no-limit.sink")}'`], { stdio: "ignore" });
    sessions.push(idleSession);
    const [idlePane, idlePid] = execFileSync("tmux", ["list-panes", "-t", `=${idleSession}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" }).trim().split("\t");
    const inserted = [];
    const add = ({ name, kind = "agent", command = "codex", pane = idlePane, panePid = idlePid, reset = resetAt, resumed = "" }) => {
      const sid = `synthetic-${name}-session`;
      const id = db.prepare(`INSERT INTO agents
        (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status, session_id, resumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?) RETURNING id`)
        .get(projectId, `${kind}:${name}`, name, kind, pane, socket, panePid, command, projectDir, sid, resumed).id;
      db.prepare(`INSERT INTO agent_usage_limits
        (agent_id, project_id, harness, pane_pid, session_id, signal_key, observed_at, reset_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now', '+1 hour'))`)
        .run(id, projectId, command === "claude" ? "claude" : "codex", panePid, sid, `synthetic-${name}`, reset);
      inserted.push(id);
      return id;
    };
    add({ name: "claude-ineligible", command: "claude" });
    add({ name: "lead-ineligible", kind: "lead" });
    const unassigned = add({ name: "unassigned", pane: limitedPane, panePid: limitedPanePid, resumed: "2026-11-01 00:00:00" });
    const unknownReset = add({ name: "unknown-reset", reset: null });
    const notLimited = add({ name: "pane-moved-on" });

    await continueLimitedCodexWorkers(now);

    const claims = db.prepare(`SELECT agent_id FROM agent_usage_limits WHERE agent_id IN (${inserted.map(() => "?").join(",")}) AND continue_claimed_at IS NOT NULL`).all(...inserted);
    assert.deepEqual(claims, []);
    assert.equal(db.prepare("SELECT continue_claimed_at FROM agent_usage_limits WHERE agent_id = ?").get(unassigned).continue_claimed_at, null);
    assert.equal(db.prepare("SELECT continue_claimed_at FROM agent_usage_limits WHERE agent_id = ?").get(unknownReset).continue_claimed_at, null);
    assert.equal(db.prepare("SELECT continue_claimed_at FROM agent_usage_limits WHERE agent_id = ?").get(notLimited).continue_claimed_at, null);
  });

  it("R8 drains authored delivery only after the Codex continue in the same release tick", async () => {
    const releaseSession = `${session}-release-order`;
    const releaseSink = join(dirs.tmp, "release-order.sink");
    writeFileSync(releaseSink, "");
    const idlePane = readFileSync(join(REPO, "test", "fixtures", "panes", "codex-idle-empty-e.txt"), "utf8");
    const limitPane = idlePane.replace(/You have 1 usage limit reset available\. Run \/usage to use one\./,
      "You’ve hit your usage limit. Try again at 3:45 PM.");
    const paneFile = join(dirs.tmp, "codex-limit-release.synthetic.txt");
    writeFileSync(paneFile, limitPane);
    execFileSync("tmux", ["new-session", "-d", "-s", releaseSession, "-x", "220", "-y", "50", `cat '${paneFile}'; stty -echo; exec cat > '${releaseSink}'`], { stdio: "ignore" });
    sessions.push(releaseSession);
    const [pane] = execFileSync("tmux", ["list-panes", "-t", `=${releaseSession}`, "-F", "#{pane_id}\t#{pane_pid}"], { encoding: "utf8" }).trim().split("\t");
    assert.ok(await until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" }).includes("usage limit"), 5000));
    const panePid = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"], { encoding: "utf8" }).trim();
    const sid = "synthetic-codex-release-session";
    const homeKey = "synthetic-codex-release-home";
    const rollout = join(dirs.dataDir, "codex-homes", homeKey, "sessions", "2026", "11", "01", `rollout-${sid}.jsonl`);
    mkdirSync(dirname(rollout), { recursive: true });
    const snapshot = (reset) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: {
      rate_limit_reached_type: "rate_limit_reached", primary: { used_percent: 100, resets_at: reset }, secondary: null,
    } } }) + "\n";
    const nowSeconds = Math.floor(Date.now() / 1000);
    writeFileSync(rollout, snapshot(nowSeconds + 600));
    const workerId = db.prepare(`INSERT INTO agents
      (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
       session_id, codex_home, transcript_path, resumed_at)
      VALUES (?, 'agent:release-order', 'release-worker', 'agent', ?, ?, ?, 'codex', ?, 'running', ?, ?, ?, '') RETURNING id`)
      .get(projectId, pane, socket, panePid, projectDir, sid, homeKey, rollout).id;
    const worker = db.prepare("SELECT * FROM agents WHERE id = ?").get(workerId);
    const queued = await sendUsageHeldMessage({ projectId, fromActor: "agent:sender", target: worker, text: "LIMIT-MESSAGE-AFTER-CONTINUE", submit: true });
    assert.equal(queued.pending, true);
    const wakeId = db.prepare(`INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at)
      VALUES (?, 'agent:sender', 'LIMIT-WAKE-AFTER-CONTINUE', 'delay', ?, ?, datetime('now', '-1 second')) RETURNING id`)
      .get(projectId, worker.actor_id, worker.tmux_target).id;
    writeFileSync(rollout, snapshot(nowSeconds - 120));

    await tick();
    const delivered = readFileSync(releaseSink, "utf8");
    const continuedAt = delivered.indexOf("continue");
    const wakeAt = delivered.indexOf("LIMIT-WAKE-AFTER-CONTINUE");
    const messageAt = delivered.indexOf("LIMIT-MESSAGE-AFTER-CONTINUE");
    assert.ok(continuedAt >= 0, delivered);
    assert.ok(wakeAt > continuedAt, delivered);
    assert.ok(messageAt > continuedAt, delivered);
    assert.ok(db.prepare("SELECT continue_claimed_at FROM agent_usage_limits WHERE agent_id = ?").get(workerId).continue_claimed_at);
    assert.ok(db.prepare("SELECT fired_at FROM wakes WHERE id = ?").get(wakeId).fired_at);
  });

  it("R9 keeps a failed claimed Codex continue from being pasted a second time", async () => {
    const sid = "synthetic-codex-crash-session";
    const home = "synthetic-codex-crash-home";
    const rollout = join(dirs.dataDir, "codex-homes", home, "sessions", "2026", "11", "01", `rollout-${sid}.jsonl`);
    mkdirSync(dirname(rollout), { recursive: true });
    writeFileSync(rollout, JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: {
      rate_limit_reached_type: "rate_limit_reached", primary: { used_percent: 100, resets_at: 1793555100 }, secondary: null,
    } } }) + "\n");
    const row = db.prepare(`INSERT INTO agents
      (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status,
       session_id, codex_home, transcript_path, resumed_at)
      VALUES (?, 'agent:crash', 'crash-worker', 'agent', ?, ?, ?, 'codex', ?, 'running', ?, ?, ?, '') RETURNING id`)
      .get(projectId, limitedPane, socket, limitedPanePid, projectDir, sid, home, rollout).id;
    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    const wrapperDir = join(dirs.tmp, "tmux-wrapper");
    const attempts = join(dirs.tmp, "paste-attempts");
    const wrapper = join(wrapperDir, "tmux");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "paste-buffer" ]; then printf 'attempt\\n' >> '${attempts}'; exit 1; fi\nexec '${realTmux}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${oldPath}`;
    try {
      await continueLimitedCodexWorkers(1793555200 * 1000);
      await continueLimitedCodexWorkers(1793555200 * 1000);
    } finally {
      process.env.PATH = oldPath;
    }
    assert.ok(db.prepare("SELECT continue_claimed_at FROM agent_usage_limits WHERE agent_id = ?").get(row).continue_claimed_at);
    assert.equal(readFileSync(attempts, "utf8").trim().split("\n").length, 1);
  });
});
