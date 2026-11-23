import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_fork tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const fakeClaude = makeFakeClaude(dirs.tmp);
const fakeCodexDir = join(dirs.tmp, "fake-codex-bin");
mkdirSync(fakeCodexDir, { recursive: true });
const fakeCodex = join(fakeCodexDir, "codex");
writeFileSync(fakeCodex, `#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const forkAt = args.indexOf("fork");
if (forkAt !== -1) {
  const source = args[forkAt + 1];
  const id = randomUUID();
  const day = new Date().toISOString().slice(0, 10).split("-");
  const dir = join(process.env.CODEX_HOME, "sessions", ...day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-fork.jsonl"), JSON.stringify({ type: "session_meta", payload: { id, session_id: id, forked_from_id: source } }) + "\\n");
}
setInterval(() => {}, 1000);
`);
chmodSync(fakeCodex, 0o755);
const noForkCodexDir = join(dirs.tmp, "codex-no-fork-bin");
mkdirSync(noForkCodexDir, { recursive: true });
const noForkCodex = join(noForkCodexDir, "codex");
writeFileSync(noForkCodex, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
chmodSync(noForkCodex, 0o755);

const OWNER = "lead:fork-tests";
let mcp;
let projectId;
let todoId;

before(async () => {
  mkdirSync(join(dirs.tmp, ".codex"), { recursive: true });
  writeFileSync(join(dirs.tmp, ".codex", "auth.json"), JSON.stringify({ tokens: "scratch-only" }));
  writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: OWNER, HOME: dirs.tmp, HIVE_SPAWN_READY_MS: "1500" },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
  todoId = (await mcp.call("todo_create", { title: "source todo", body: "belongs to the source only" })).todo_id;
});

after(async () => {
  if (mcp) {
    const rows = db.prepare("SELECT id FROM agents WHERE project_id = ? AND status = 'running'").all(projectId);
    for (const row of rows) await mcp.call("agent_close", { agent_id: row.id }).catch(() => {});
    await mcp.close();
  }
  cleanup(sessionName());
  rmSync(dirname(dirs.dataDir), { recursive: true, force: true });
});

async function sourceClaude(name) {
  await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(),
    model: "claude-sonnet-4-5",
    extra_args: ["--effort", "high"],
    todo_id: todoId,
  });
  const row = await liveAgentRow(mcp, name);
  const transcript = join(dirs.tmp, `${name}.jsonl`);
  const sourceSessionId = db.prepare("SELECT session_id FROM agents WHERE id = ?").get(row.agent_id).session_id;
  writeFileSync(transcript, JSON.stringify({ session_id: sourceSessionId, private_text: "source conversation" }) + "\n");
  db.prepare("UPDATE agents SET transcript_path = ?, extra_args = ? WHERE id = ?")
    .run(transcript, JSON.stringify({ args: ["--effort", "high"], read_only: true }), row.agent_id);
  return { ...row, transcript, source: db.prepare("SELECT * FROM agents WHERE id = ?").get(row.agent_id) };
}

function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bareSource({ kind = "agent", command = "claude", cwd = dirs.projectDir, sessionId = randomUUID(), transcriptPath = "", codexHome = "", status = "closed" } = {}) {
  return db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, status, session_id, transcript_path, codex_home)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(projectId, `fixture:${randomUUID()}`, `fixture-${randomUUID()}`, command, cwd, kind, status, sessionId, transcriptPath, codexHome).id;
}

describe("agent_fork", NEEDS_TMUX, () => {
  it("fork creates a child and leaves the source worker unchanged", async () => {
    const parent = await sourceClaude("fork-source");
    const rowBefore = db.prepare("SELECT * FROM agents WHERE id = ?").get(parent.agent_id);
    const sourceHash = hash(parent.transcript);

    const receipt = await mcp.call("agent_fork", { agent_id: parent.agent_id, name: "fork-child" });
    const child = db.prepare("SELECT * FROM agents WHERE id = ?").get(receipt.agent_id);

    assert.notEqual(receipt.agent_id, parent.agent_id);
    assert.notEqual(receipt.actor_id, parent.actor_id);
    assert.notEqual(receipt.tmux_target, parent.tmux_target);
    assert.equal(receipt.forked_from_agent_id, parent.agent_id);
    assert.equal(receipt.forked_from_session_id, rowBefore.session_id);
    assert.match(receipt.session_id, /^[0-9a-f-]{36}$/i);
    assert.equal(child.session_id, receipt.session_id);
    assert.equal(child.forked_from_agent_id, parent.agent_id);
    assert.equal(child.forked_from_session_id, rowBefore.session_id);
    assert.ok(child.resumed_at, "the restore-idle latch is stamped in the row insert");
    assert.equal(child.cwd, rowBefore.cwd);
    assert.equal(child.todo_id, null, "the source todo is never inherited implicitly");
    assert.equal(child.model, "claude-sonnet-4-5");
    assert.deepEqual(JSON.parse(child.extra_args), { args: ["--effort", "high"], read_only: true });
    assert.match(child.command, /--session-id [0-9a-f-]{36}.*--resume [0-9a-f-]{36}.*--fork-session/);
    assert.match(receipt.permission_note, /permission grants are not copied/);
    assert.equal(JSON.stringify(receipt).includes("source conversation"), false);
    assert.deepEqual(db.prepare("SELECT * FROM agents WHERE id = ?").get(parent.agent_id), rowBefore);
    assert.equal(hash(parent.transcript), sourceHash);

    const status = await mcp.call("agent_status", { agent_id: receipt.agent_id });
    assert.equal(status.forked_from_agent_id, parent.agent_id);
    assert.equal(status.forked_from_session_id, rowBefore.session_id);
    const listed = (await mcp.call("agent_list", {})).agents.find((agent) => agent.agent_id === receipt.agent_id);
    assert.equal(listed.forked_from_session_id, rowBefore.session_id);
  });

  it("fork uses the interactive Codex fork command with an isolated seeded home", async () => {
    const parentName = "codex-source";
    await mcp.call("agent_spawn", { name: parentName, command: fakeCodex, model: "gpt-6.1-sol" });
    const parentLive = await liveAgentRow(mcp, parentName);
    const parent = db.prepare("SELECT * FROM agents WHERE id = ?").get(parentLive.agent_id);
    const sourceSessionId = randomUUID();
    const dateParts = new Date().toISOString().slice(0, 10).split("-");
    const sessions = join(dirs.dataDir, "codex-homes", parent.codex_home, "sessions", ...dateParts);
    mkdirSync(sessions, { recursive: true });
    const sourceTranscript = join(sessions, `rollout-${sourceSessionId}.jsonl`);
    writeFileSync(sourceTranscript, JSON.stringify({ type: "session_meta", payload: { id: sourceSessionId, session_id: sourceSessionId } }) + "\n");
    db.prepare("UPDATE agents SET session_id = ?, transcript_path = ? WHERE id = ?").run(sourceSessionId, sourceTranscript, parent.id);
    const sourceRowBefore = db.prepare("SELECT * FROM agents WHERE id = ?").get(parent.id);
    const parentHome = join(dirs.dataDir, "codex-homes", parent.codex_home);
    const parentHomeFileHashes = ["config.toml", "hooks.json"].map((file) => [file, hash(join(parentHome, file))]);
    const sourceHash = hash(sourceTranscript);
    const altCwd = join(dirs.projectDir, "alternate-cwd");
    mkdirSync(altCwd, { recursive: true });

    const beforeInvalidOverride = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n;
    await assert.rejects(
      mcp.call("agent_fork", { agent_id: parent.id, name: "codex-max-effort", effort: "max" }),
      /not supported by codex/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n, beforeInvalidOverride);

    const receipt = await mcp.call("agent_fork", { agent_id: parent.id, name: "codex-child", cwd: altCwd });
    const child = db.prepare("SELECT * FROM agents WHERE id = ?").get(receipt.agent_id);
    const childHome = join(dirs.dataDir, "codex-homes", child.codex_home);
    const childTranscript = child.transcript_path;

    assert.deepEqual(db.prepare("SELECT * FROM agents WHERE id = ?").get(parent.id), sourceRowBefore);
    assert.notEqual(child.codex_home, parent.codex_home);
    assert.equal(child.cwd, altCwd);
    assert.equal(child.forked_from_agent_id, parent.id);
    assert.equal(child.forked_from_session_id, sourceSessionId);
    assert.notEqual(child.session_id, sourceSessionId);
    assert.equal(child.session_id, receipt.session_id);
    const cwdOption = child.command.indexOf("-C");
    const forkCommand = child.command.indexOf("fork", cwdOption);
    assert.ok(cwdOption >= 0 && forkCommand > cwdOption, "codex fork accepts -C before its subcommand");
    assert.ok(child.command.includes(`fork ${sourceSessionId}`), "the positional session id follows `fork`");
    assert.equal(hash(sourceTranscript), sourceHash);
    assert.deepEqual(parentHomeFileHashes.map(([file]) => [file, hash(join(parentHome, file))]), parentHomeFileHashes);
    assert.equal(hash(childTranscript) !== sourceHash, true);
    assert.equal(readlinkSync(join(childHome, "auth.json")), join(dirs.tmp, ".codex", "auth.json"));
    const childConfig = readFileSync(join(childHome, "config.toml"), "utf8");
    assert.ok(childConfig.includes(`HIVE_AGENT_ID = "${child.actor_id}"`));
    assert.equal(childConfig.includes(`HIVE_AGENT_ID = "${parent.actor_id}"`), false);
    assert.equal(lstatSync(join(childHome, "sessions", ...dateParts, `rollout-${sourceSessionId}.jsonl`)).isSymbolicLink(), false);
    assert.match(receipt.permission_note, /permission grants are not copied/);
  });

  it("closing a forked Codex child leaves the source row and home usable", async () => {
    await mcp.call("agent_spawn", { name: "codex-close-source", command: fakeCodex, model: "gpt-6.1-sol" });
    const live = await liveAgentRow(mcp, "codex-close-source");
    const source = db.prepare("SELECT * FROM agents WHERE id = ?").get(live.agent_id);
    const sourceSessionId = randomUUID();
    const dateParts = new Date().toISOString().slice(0, 10).split("-");
    const sourceDir = join(dirs.dataDir, "codex-homes", source.codex_home, "sessions", ...dateParts);
    mkdirSync(sourceDir, { recursive: true });
    const sourceTranscript = join(sourceDir, `rollout-${sourceSessionId}.jsonl`);
    writeFileSync(
      sourceTranscript,
      JSON.stringify({ type: "session_meta", payload: { id: sourceSessionId, session_id: sourceSessionId } }) + "\n",
    );
    db.prepare("UPDATE agents SET session_id = ?, transcript_path = ? WHERE id = ?").run(sourceSessionId, sourceTranscript, source.id);
    const sourceRowBefore = db.prepare("SELECT * FROM agents WHERE id = ?").get(source.id);
    const sourceHash = hash(sourceTranscript);
    const sourceHome = join(dirs.dataDir, "codex-homes", source.codex_home);
    const sourceHomeHashes = ["config.toml", "hooks.json"].map((file) => [file, hash(join(sourceHome, file))]);

    const fork = await mcp.call("agent_fork", { agent_id: source.id, name: "codex-close-child" });
    const child = db.prepare("SELECT * FROM agents WHERE id = ?").get(fork.agent_id);
    assert.notEqual(child.codex_home, source.codex_home);

    await mcp.call("agent_close", { agent_id: child.id });

    assert.deepEqual(db.prepare("SELECT * FROM agents WHERE id = ?").get(source.id), sourceRowBefore);
    assert.equal(hash(sourceTranscript), sourceHash);
    assert.deepEqual(
      sourceHomeHashes.map(([file]) => [file, hash(join(sourceHome, file))]),
      sourceHomeHashes,
    );
    assert.equal((await mcp.call("agent_status", { agent_id: source.id })).alive, true);
  });

  it("fork supports parked Codex homes and refuses a closed source whose home was reaped", async () => {
    await mcp.call("agent_spawn", { name: "parked-codex-source", command: fakeCodex, model: "gpt-6.1-sol" });
    const parkedLive = await liveAgentRow(mcp, "parked-codex-source");
    const parkedBefore = db.prepare("SELECT * FROM agents WHERE id = ?").get(parkedLive.agent_id);
    const parkedSession = randomUUID();
    const parkedDir = join(dirs.dataDir, "codex-homes", parkedBefore.codex_home, "sessions", "2026", "11", "01");
    mkdirSync(parkedDir, { recursive: true });
    const parkedTranscript = join(parkedDir, `rollout-${parkedSession}.jsonl`);
    writeFileSync(parkedTranscript, JSON.stringify({ type: "session_meta", payload: { id: parkedSession } }) + "\n");
    db.prepare("UPDATE agents SET session_id = ?, transcript_path = ? WHERE id = ?").run(parkedSession, parkedTranscript, parkedBefore.id);
    await mcp.call("agent_park", { agent_id: parkedBefore.id });
    const parked = db.prepare("SELECT * FROM agents WHERE id = ?").get(parkedBefore.id);
    assert.ok(parked.parked_at);
    assert.ok(parked.codex_home);
    const fork = await mcp.call("agent_fork", { agent_id: parked.id, name: "parked-codex-child" });
    assert.equal(fork.forked_from_agent_id, parked.id);
    assert.equal(fork.forked_from_session_id, parkedSession);

    await mcp.call("agent_spawn", { name: "reaped-codex-source", command: fakeCodex, model: "gpt-6.1-sol" });
    const reapedLive = await liveAgentRow(mcp, "reaped-codex-source");
    const reapedId = reapedLive.agent_id;
    const reapedSession = randomUUID();
    const reaped = db.prepare("SELECT * FROM agents WHERE id = ?").get(reapedId);
    const reapedDir = join(dirs.dataDir, "codex-homes", reaped.codex_home, "sessions", "2026", "11", "01");
    mkdirSync(reapedDir, { recursive: true });
    const reapedTranscript = join(reapedDir, `rollout-${reapedSession}.jsonl`);
    writeFileSync(reapedTranscript, JSON.stringify({ type: "session_meta", payload: { id: reapedSession } }) + "\n");
    db.prepare("UPDATE agents SET session_id = ?, transcript_path = ? WHERE id = ?").run(reapedSession, reapedTranscript, reapedId);
    await mcp.call("agent_close", { agent_id: reapedId });
    const countBefore = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n;
    await assert.rejects(mcp.call("agent_fork", { agent_id: reapedId, name: "reaped-codex-child" }), /not parked; its fork home may have been reaped/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n, countBefore);
  });

  it("ambiguous or timed-out fork discovery retires only the child", async () => {
    await mcp.call("agent_spawn", { name: "codex-timeout-source", command: noForkCodex, model: "gpt-6.1-sol" });
    const live = await liveAgentRow(mcp, "codex-timeout-source");
    const source = db.prepare("SELECT * FROM agents WHERE id = ?").get(live.agent_id);
    const sourceSessionId = randomUUID();
    const sourceDir = join(dirs.dataDir, "codex-homes", source.codex_home, "sessions", "2026", "11", "01");
    mkdirSync(sourceDir, { recursive: true });
    const sourceTranscript = join(sourceDir, `rollout-${sourceSessionId}.jsonl`);
    writeFileSync(sourceTranscript, JSON.stringify({ type: "session_meta", payload: { id: sourceSessionId } }) + "\n");
    db.prepare("UPDATE agents SET session_id = ?, transcript_path = ? WHERE id = ?").run(sourceSessionId, sourceTranscript, source.id);
    const sourceHash = hash(sourceTranscript);
    const sourceConfigHash = hash(join(dirs.dataDir, "codex-homes", source.codex_home, "config.toml"));

    await assert.rejects(
      mcp.call("agent_fork", { agent_id: source.id, name: "codex-timeout-child" }),
      /fork session was not identified.*child agent_id .* was retired/,
    );
    const child = db.prepare("SELECT * FROM agents WHERE name = 'codex-timeout-child'").get();
    assert.ok(child);
    assert.equal(child.status, "closed");
    assert.equal(child.codex_home, "");
    assert.equal(db.prepare("SELECT status, session_id FROM agents WHERE id = ?").get(source.id).status, "running");
    assert.equal(db.prepare("SELECT session_id FROM agents WHERE id = ?").get(source.id).session_id, sourceSessionId);
    assert.equal(hash(sourceTranscript), sourceHash);
    assert.equal(hash(join(dirs.dataDir, "codex-homes", source.codex_home, "config.toml")), sourceConfigHash);
    assert.equal((await mcp.call("agent_status", { agent_id: source.id })).alive, true);
  });

  it("invalid fork sources create neither a row nor a pane", async () => {
    const parent = await sourceClaude("fork-invalid-session");
    db.prepare("UPDATE agents SET session_id = '' WHERE id = ?").run(parent.agent_id);
    const beforeMissingSession = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n;
    await assert.rejects(mcp.call("agent_fork", { agent_id: parent.agent_id, name: "invalid-child" }), /no recorded session id/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n, beforeMissingSession);

    const lead = bareSource({ kind: "lead", sessionId: randomUUID(), transcriptPath: parent.transcript });
    const unsupported = bareSource({ command: "sh", sessionId: randomUUID(), transcriptPath: parent.transcript });
    const missingTranscript = bareSource({ sessionId: randomUUID() });
    const fileAsCwd = join(dirs.tmp, "not-a-directory");
    writeFileSync(fileAsCwd, "file");
    const missingCwd = bareSource({ cwd: fileAsCwd, sessionId: randomUUID(), transcriptPath: parent.transcript });
    const codexWithoutHome = bareSource({ command: "codex", status: "running", sessionId: randomUUID(), transcriptPath: parent.transcript });
    const beforeInvalids = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n;
    for (const [agentId, error, name] of [
      [lead, /worker, not a lead/, "lead-source-child"],
      [unsupported, /unsupported fork harness/, "unsupported-child"],
      [missingTranscript, /no readable transcript/, "transcript-child"],
      [missingCwd, /no readable working directory/, "cwd-child"],
      [codexWithoutHome, /no recorded CODEX_HOME/, "home-child"],
    ]) {
      await assert.rejects(mcp.call("agent_fork", { agent_id: agentId, name }), error);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n, beforeInvalids);
  });

  it("fork refuses a colliding child name and a foreign project", async () => {
    const parent = await sourceClaude("fork-guard-source");
    await mcp.call("agent_spawn", { name: "fork-collision", command: fakeClaude() });
    const before = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n;
    await assert.rejects(mcp.call("agent_fork", { agent_id: parent.agent_id, name: "fork-collision" }), /already exists/);

    const foreignProject = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("foreign-fork", join(dirs.tmp, "foreign" )).id;
    const foreignCwd = join(dirs.tmp, "foreign");
    mkdirSync(foreignCwd, { recursive: true });
    const foreignAgent = db.prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, session_id, transcript_path)
       VALUES (?, 'foreign-source', 'claude', ?, 'agent', 'foreign-session', ?) RETURNING id`,
    ).get(foreignProject, dirs.projectDir, parent.transcript).id;
    await assert.rejects(
      mcp.call("agent_fork", { agent_id: parent.agent_id, name: "foreign-cwd-child", cwd: foreignCwd }),
      /belongs to project "foreign-fork"/,
    );
    await assert.rejects(
      mcp.call("agent_fork", { agent_id: foreignAgent, name: "foreign-child", project_id: foreignProject }),
      /same-project only/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ?").get(projectId).n, before);
  });
});
