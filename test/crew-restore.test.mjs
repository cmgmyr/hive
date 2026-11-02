import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertScratchStore,
  clearHiveEnv,
  crashPane,
  DIST,
  isolateTmux,
  liveAgentRow,
  makeFakeClaude,
  McpClient,
  namedInStandingReport,
  reportedAsFinished,
  REPO,
  runCli,
  runNode,
  scratchDirs,
  seedDeadPaneLead,
  seedStandingWatch,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the crew-restore tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const fakeHome = join(dirs.tmp, "home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "fixture" }));
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

const { db } = await import("../dist/db.js");
await assertScratchStore();
const { sessionName, rowOwnership, liveTargets } = await import("../dist/tmux.js");
const { codexHomeDir } = await import("../dist/codexHome.js");
const { tick } = await import("../dist/scheduler.js");
const HOOK = join(DIST, "hook.js");
const STOP_PAYLOAD = readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "stop-idle.json"), "utf8");
const PROMPT_PAYLOAD = readFileSync(join(REPO, "test", "fixtures", "hook-payloads", "prompt-user.json"), "utf8");
let mcp;
let projectId;
let todoId;

function fakeHarness(name) {
  const binDir = join(dirs.tmp, `${name}-bin`);
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, name);
  const argvLog = join(dirs.tmp, `${name}-argv.log`);
  const envLog = join(dirs.tmp, `${name}-env.log`);
  const body = `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}\nprintf 'actor=%s\\nname=%s\\ncwd=%s\\nhome=%s\\n' "$HIVE_AGENT_ID" "$HIVE_AGENT_NAME" "$PWD" "$CODEX_HOME" >> ${JSON.stringify(envLog)}\nexec sleep 90\n`;
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  return { bin, argvLog, envLog };
}

const claude = fakeHarness("claude");
const codex = fakeHarness("codex");
const fakeClaude = makeFakeClaude(dirs.tmp);

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "1", HOME: fakeHome },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  todoId = db.prepare("INSERT INTO todos (project_id, title) VALUES (?, ?) RETURNING id").get(projectId, "crew restore identity").id;
});

after(async () => {
  await mcp?.close();
  cleanup(sessionName());
});

async function spawnPair() {
  const c = await mcp.call("agent_spawn", {
    name: "restore-claude",
    command: claude.bin,
    model: "sonnet",
    extra_args: ["--effort", "high"],
    todo_id: todoId,
  });
  const x = await mcp.call("agent_spawn", {
    name: "restore-codex",
    command: codex.bin,
    model: "gpt-5.1-codex",
    extra_args: ["-c", "model_reasoning_effort=high"],
    todo_id: todoId,
  });
  await liveAgentRow(mcp, "restore-claude");
  await liveAgentRow(mcp, "restore-codex");
  db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run("claude-session-nonce", c.agent_id);
  db.prepare("UPDATE agents SET session_id = ? WHERE id = ?").run("codex-session-nonce", x.agent_id);
  return [c.agent_id, x.agent_id];
}

async function fireHook(actorId, event, payload) {
  const result = await runNode(HOOK, [event], { dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId }, stdin: payload });
  assert.equal(result.code, 0, `the ${event} hook must exit successfully`);
}

function row(id) {
  return db.prepare("SELECT * FROM agents WHERE id = ? AND project_id = ?").get(id, projectId);
}

describe("hive crew-restore", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("dry-run leaves stale rows and panes untouched, then restores each harness on its own row", async () => {
    const ids = await spawnPair();
    const before = ids.map(row);
    for (const agent of before) crashPane(agent.tmux_target);

    const preview = await runCli(["crew-restore", "--dry-run", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(preview.code, 0, preview.stderr);
    const dry = JSON.parse(preview.stdout);
    assert.equal(dry.project_id, projectId);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.rows.map((item) => item.outcome), ["would_restore", "would_restore"]);
    for (const prior of before) {
      const unchanged = row(prior.id);
      assert.equal(unchanged.status, "running");
      assert.equal(unchanged.recovery_state, "");
      assert.equal(unchanged.tmux_target, prior.tmux_target);
    }
    assert.doesNotMatch(readFileSync(claude.argvLog, "utf8"), /--resume/);
    assert.doesNotMatch(readFileSync(codex.argvLog, "utf8"), /\nresume\n/);

    const restored = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(restored.code, 0, restored.stderr);
    const result = JSON.parse(restored.stdout);
    assert.deepEqual(result.rows.map((item) => item.outcome), ["restored", "restored"]);
    for (const [index, prior] of before.entries()) {
      const current = row(prior.id);
      assert.equal(current.status, "running");
      assert.equal(current.recovery_state, "");
      assert.equal(current.actor_id, prior.actor_id);
      assert.equal(current.name, prior.name);
      assert.equal(current.project_id, prior.project_id);
      assert.equal(current.parent_actor_id, prior.parent_actor_id);
      assert.equal(current.cwd, prior.cwd);
      assert.equal(current.session_id, prior.session_id);
      assert.equal(current.todo_id, todoId);
      assert.equal(current.model, prior.model);
      assert.equal(current.extra_args, prior.extra_args);
      assert.notEqual(current.pane_pid, prior.pane_pid);
      assert.equal(rowOwnership(current, liveTargets()), "live");
      assert.equal(result.rows[index].tmux_target, current.tmux_target);
    }
    assert.match(readFileSync(claude.argvLog, "utf8"), /--resume\nclaude-session-nonce/);
    assert.match(readFileSync(claude.argvLog, "utf8"), /--effort\nhigh/);
    assert.match(readFileSync(claude.envLog, "utf8"), new RegExp(`actor=${before[0].actor_id}`));
    assert.match(readFileSync(codex.argvLog, "utf8"), /resume\ncodex-session-nonce/);
    assert.match(readFileSync(codex.argvLog, "utf8"), /model_reasoning_effort=high/);
    assert.match(readFileSync(codex.envLog, "utf8"), new RegExp(`home=${codexHomeDir(before[1].codex_home)}`));

    const second = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).rows.filter((item) => item.outcome === "restored").length, 0);
    for (const id of ids) await mcp.call("agent_close", { agent_id: id });
  });

  it("two CLI processes racing for one pending row publish only one pane", async () => {
    const receipt = await mcp.call("agent_spawn", { name: "restore-race", command: claude.bin });
    await liveAgentRow(mcp, "restore-race");
    db.prepare("UPDATE agents SET session_id = 'race-session' WHERE id = ?").run(receipt.agent_id);
    const before = row(receipt.agent_id);
    crashPane(before.tmux_target);

    const options = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { HOME: fakeHome } };
    const [a, b] = await Promise.all([
      runCli(["crew-restore", "--json"], options),
      runCli(["crew-restore", "--json"], options),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const outcomes = [JSON.parse(a.stdout), JSON.parse(b.stdout)].flatMap((r) => r.rows).filter((r) => r.agent_id === receipt.agent_id);
    assert.equal(outcomes.filter((r) => r.outcome === "restored").length, 1);
    const after = row(receipt.agent_id);
    assert.equal(after.status, "running");
    assert.equal(after.recovery_state, "");
    assert.equal(after.actor_id, before.actor_id);
    assert.equal(after.session_id, "race-session");
    assert.equal(rowOwnership(after, liveTargets()), "live");
    assert.equal((readFileSync(claude.argvLog, "utf8").match(/race-session/g) ?? []).length, 1);
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });

  it("mixed restore failure rolls back pending state and a retry skips the success", async () => {
    const success = await mcp.call("agent_spawn", { name: "restore-retry-success", command: claude.bin });
    await liveAgentRow(mcp, "restore-retry-success");
    db.prepare("UPDATE agents SET session_id = 'success-session' WHERE id = ?").run(success.agent_id);
    const successBefore = row(success.agent_id);
    crashPane(successBefore.tmux_target);

    const failure = await mcp.call("agent_spawn", { name: "restore-retry-failure", command: claude.bin });
    await liveAgentRow(mcp, "restore-retry-failure");
    db.prepare("UPDATE agents SET session_id = 'retry-session' WHERE id = ?").run(failure.agent_id);
    const failureBefore = row(failure.agent_id);
    crashPane(failureBefore.tmux_target);
    db.exec(`CREATE TRIGGER crew_restore_fail_actor BEFORE INSERT ON actors WHEN NEW.id = '${failureBefore.actor_id}' BEGIN SELECT RAISE(ABORT, 'simulated resume setup failure'); END`);

    const result = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    db.exec("DROP TRIGGER crew_restore_fail_actor");
    assert.equal(result.code, 1);
    const firstRows = JSON.parse(result.stdout).rows;
    assert.equal(firstRows.find((candidate) => candidate.agent_id === success.agent_id).outcome, "restored");
    const failed = firstRows.find((candidate) => candidate.agent_id === failure.agent_id);
    assert.equal(failed.outcome, "failed");
    assert.ok(failed.reason, "the failed launch must carry a row-specific reason");
    const afterFailure = row(failure.agent_id);
    assert.equal(afterFailure.status, "closed");
    assert.equal(afterFailure.recovery_state, "pending");
    assert.equal(afterFailure.tmux_target, failureBefore.tmux_target);
    assert.equal(afterFailure.pane_pid, failureBefore.pane_pid);
    const afterSuccess = row(success.agent_id);
    assert.equal(afterSuccess.status, "running");
    assert.notEqual(afterSuccess.pane_pid, successBefore.pane_pid);
    const successfulLaunches = () => (readFileSync(claude.argvLog, "utf8").match(/success-session/g) ?? []).length;
    assert.equal(successfulLaunches(), 1);

    const retry = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(retry.code, 0, retry.stderr);
    const retryRows = JSON.parse(retry.stdout).rows;
    assert.equal(retryRows.find((candidate) => candidate.agent_id === success.agent_id).outcome, "skipped");
    assert.equal(retryRows.find((candidate) => candidate.agent_id === failure.agent_id).outcome, "restored");
    assert.equal(row(success.agent_id).status, "running");
    assert.equal(row(success.agent_id).pane_pid, afterSuccess.pane_pid);
    assert.equal(successfulLaunches(), 1, "the retry must not launch the already restored row again");
    assert.equal(row(failure.agent_id).status, "running");
    assert.equal(row(failure.agent_id).recovery_state, "");
    assert.equal(rowOwnership(row(failure.agent_id), liveTargets()), "live");
    await mcp.call("agent_close", { agent_id: success.agent_id });
    await mcp.call("agent_close", { agent_id: failure.agent_id });
  });

  it("unknown foreign pane ownership is skipped and a missing session is reported as a retryable failure", async () => {
    const active = await mcp.call("agent_spawn", { name: "restore-live", command: claude.bin });
    await liveAgentRow(mcp, "restore-live");
    const live = await mcp.call("agent_spawn", { name: "restore-foreign", command: claude.bin });
    await liveAgentRow(mcp, "restore-foreign");
    const activeBefore = row(active.agent_id);
    const originalSocket = row(live.agent_id).tmux_socket;
    db.prepare("UPDATE agents SET tmux_socket = ? WHERE id = ?").run("/tmp/foreign-tmux-socket", live.agent_id);
    const missingSession = db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd,
          status, kind, session_id, recovery_state, parent_actor_id)
       VALUES (?, 'agent:restore-no-session', 'restore-no-session', '', '', '', ?, ?, 'closed', 'agent', '', 'pending', 'lead:restore')
       RETURNING id`,
    ).get(projectId, claude.bin, dirs.projectDir).id;

    const result = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(result.code, 1);
    const rows = JSON.parse(result.stdout).rows;
    assert.equal(rows.find((candidate) => candidate.agent_id === active.agent_id).outcome, "skipped");
    assert.equal(rows.find((candidate) => candidate.agent_id === live.agent_id).outcome, "skipped");
    const blocked = rows.find((candidate) => candidate.agent_id === missingSession);
    assert.equal(blocked.outcome, "failed");
    assert.match(blocked.reason, /session id/);
    assert.equal(row(live.agent_id).status, "running");
    assert.equal(row(live.agent_id).tmux_socket, "/tmp/foreign-tmux-socket");
    assert.equal(row(active.agent_id).status, "running");
    assert.equal(row(active.agent_id).tmux_target, activeBefore.tmux_target);
    assert.equal(row(active.agent_id).pane_pid, activeBefore.pane_pid);
    assert.equal(row(missingSession).status, "closed");
    assert.equal(row(missingSession).recovery_state, "pending");
    db.prepare("UPDATE agents SET tmux_socket = ? WHERE id = ?").run(originalSocket, live.agent_id);
    await mcp.call("agent_close", { agent_id: active.agent_id });
    await mcp.call("agent_close", { agent_id: live.agent_id });
    db.prepare("DELETE FROM agents WHERE id = ?").run(missingSession);
  });

  it("reports missing cwd, Codex home, unsupported harness, and running-name collisions per pending row", async () => {
    const collision = await mcp.call("agent_spawn", { name: "restore-name-taken", command: claude.bin });
    await liveAgentRow(mcp, "restore-name-taken");
    const insertPending = (name, command, cwd, codexHome = "") => db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, status, kind, session_id,
          codex_home, recovery_state, parent_actor_id)
       VALUES (?, ?, ?, ?, ?, 'closed', 'agent', ?, ?, 'pending', 'lead:restore-test') RETURNING id`,
    ).get(projectId, `agent:${name}`, name, command, cwd, `${name}-session`, codexHome).id;
    const missingCwd = insertPending("restore-missing-cwd", claude.bin, join(dirs.tmp, "gone-checkout"));
    const missingHome = insertPending("restore-missing-home", codex.bin, dirs.projectDir, "gone-codex-home");
    const unsupported = insertPending("restore-unsupported", "sleep 60", dirs.projectDir);
    const nameCollision = insertPending("restore-name-taken", claude.bin, dirs.projectDir);

    const result = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(result.code, 1);
    const rows = JSON.parse(result.stdout).rows;
    const expected = [
      [missingCwd, /working directory/],
      [missingHome, /Codex home/],
      [unsupported, /does not support resume/],
      [nameCollision, /already uses this name/],
    ];
    for (const [agentId, reason] of expected) {
      const item = rows.find((candidate) => candidate.agent_id === agentId);
      assert.equal(item.outcome, "failed");
      assert.match(item.reason, reason);
      assert.equal(row(agentId).recovery_state, "pending");
    }
    await mcp.call("agent_close", { agent_id: collision.agent_id });
    for (const [agentId] of expected) db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  });

  it("an unanswered tmux probe leaves a running row and pane untouched", async () => {
    const receipt = await mcp.call("agent_spawn", { name: "restore-unanswered", command: claude.bin });
    await liveAgentRow(mcp, "restore-unanswered");
    const before = row(receipt.agent_id);
    const failingTmux = join(dirs.tmp, "tmux-fails");
    mkdirSync(failingTmux, { recursive: true });
    writeFileSync(join(failingTmux, "tmux"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(failingTmux, "tmux"), 0o755);

    const result = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome, PATH: `${failingTmux}:${process.env.PATH}` },
    });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const item = report.rows.find((candidate) => candidate.agent_id === receipt.agent_id);
    assert.equal(item.outcome, "skipped");
    assert.match(item.reason, /could not be checked/);
    assert.equal(row(receipt.agent_id).status, "running");
    assert.equal(row(receipt.agent_id).tmux_target, before.tmux_target);
    assert.equal(row(receipt.agent_id).pane_pid, before.pane_pid);
    assert.equal(rowOwnership(row(receipt.agent_id), liveTargets()), "live");
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });

  it("deliberately closed workers remain excluded from the recovery command", async () => {
    const receipt = await mcp.call("agent_spawn", { name: "restore-closed", command: claude.bin });
    await liveAgentRow(mcp, "restore-closed");
    db.prepare("UPDATE agents SET session_id = 'closed-session' WHERE id = ?").run(receipt.agent_id);
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
    const before = row(receipt.agent_id);
    assert.equal(before.recovery_state, "excluded");

    const result = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(result.code, 0, result.stderr);
    const item = JSON.parse(result.stdout).rows.find((candidate) => candidate.agent_id === receipt.agent_id);
    assert.equal(item.outcome, "skipped");
    assert.equal(row(receipt.agent_id).status, "closed");
    assert.equal(row(receipt.agent_id).recovery_state, "excluded");
    assert.equal(row(receipt.agent_id).tmux_target, before.tmux_target);
  });

  it("restore only reads and changes rows from the current project", async () => {
    const otherPath = join(dirs.tmp, "other-project");
    mkdirSync(otherPath, { recursive: true });
    const otherProjectId = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("restore-other", otherPath).id;
    const otherAgentId = db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, status, kind, session_id,
          recovery_state, parent_actor_id)
       VALUES (?, 'agent:restore-other', 'restore-other-worker', ?, ?, 'closed', 'agent', 'other-session', 'pending', 'lead:other')
       RETURNING id`,
    ).get(otherProjectId, claude.bin, otherPath).id;

    const result = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.project_id, projectId);
    assert.equal(report.rows.some((candidate) => candidate.agent_id === otherAgentId), false);
    const otherRow = db.prepare("SELECT status, recovery_state FROM agents WHERE id = ?").get(otherAgentId);
    assert.equal(otherRow.status, "closed");
    assert.equal(otherRow.recovery_state, "pending");
    db.prepare("DELETE FROM agents WHERE id = ?").run(otherAgentId);
    db.prepare("DELETE FROM projects WHERE id = ?").run(otherProjectId);
  });

  it("a surviving watch ignores the recovery Stop, then reports the next assigned turn", async () => {
    const owner = "lead:crew-restore-watch";
    seedDeadPaneLead(db, projectId, dirs.projectDir, owner);
    const watchId = seedStandingWatch(db, projectId, owner);
    const receipt = await mcp.call("agent_spawn", { name: "restore-watch", command: fakeClaude() });
    const live = await liveAgentRow(mcp, "restore-watch");
    db.prepare("UPDATE agents SET parent_actor_id = ? WHERE id = ?").run(owner, receipt.agent_id);
    const before = row(receipt.agent_id);
    await fireHook(before.actor_id, "prompt", PROMPT_PAYLOAD);
    crashPane(live.tmux_target);

    const restored = await runCli(["crew-restore", "--json"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { HOME: fakeHome },
    });
    assert.equal(restored.code, 0, restored.stderr);
    const after = row(receipt.agent_id);
    assert.equal(after.status, "running");
    assert.ok(after.resumed_at);
    assert.equal(after.actor_id, before.actor_id);
    assert.equal(after.parent_actor_id, before.parent_actor_id);
    const snapshot = liveTargets();

    await fireHook(after.actor_id, "stop", STOP_PAYLOAD);
    await tick(snapshot);
    assert.equal(reportedAsFinished(db, watchId, "restore-watch"), false);

    await fireHook(after.actor_id, "prompt", PROMPT_PAYLOAD);
    assert.equal(row(receipt.agent_id).resumed_at, "");
    await fireHook(after.actor_id, "stop", STOP_PAYLOAD);
    await tick(snapshot);
    assert.equal(reportedAsFinished(db, watchId, "restore-watch"), true);
    assert.equal(namedInStandingReport(db, watchId, "restore-watch"), true);
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });
});
