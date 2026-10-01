import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { DIST, assertScratchStore, clearHiveEnv, isolateTmux, runNode, scratchDirs } from "./helpers.mjs";

isolateTmux("the Codex hook home ownership tests");
const { dataDir, tmp } = scratchDirs();
clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();
const HOOK = join(DIST, "hook.js");
const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-codex-home-ownership", dataDir).id;
let serial = 0;

function fixture({ command = "codex", kind = "agent", home = true, state = "unknown", sessionId = "", resumedAt = "pending" } = {}) {
  const actorId = `${kind === "lead" ? "lead" : "agent"}:home-${serial++}`;
  const key = `home-${serial}`;
  const homeDir = join(dataDir, "codex-homes", key);
  const sessions = join(homeDir, "sessions");
  mkdirSync(sessions, { recursive: true });
  db.prepare("INSERT INTO actors (id, name, kind, last_seen_at) VALUES (?, ?, ?, ?)")
    .run(actorId, actorId, kind, "2000-01-01 00:00:00");
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, agent_state,
                         codex_home, session_id, transcript_path, resumed_at)
     VALUES (?, ?, ?, '%9600', ?, ?, 'running', ?, ?, ?, ?, '', ?)`
  ).run(project, actorId, actorId, command, tmp, kind, state, home ? key : "", sessionId, resumedAt);
  const rollout = join(sessions, "2026", "10", "rollout-session.jsonl");
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, "{}\n");
  const agentId = db.prepare("SELECT id FROM agents WHERE actor_id = ?").get(actorId).id;
  return { actorId, agentId, key, homeDir, sessions, rollout };
}

function row(actorId) {
  return db.prepare(
    `SELECT agent_state, session_id, transcript_path, resumed_at, state_changed_at, codex_home
       FROM agents WHERE actor_id = ?`,
  ).get(actorId);
}

function actor(actorId) {
  return db.prepare("SELECT last_seen_at FROM actors WHERE id = ?").get(actorId);
}

function logs(actorId) {
  return db.prepare("SELECT event, state, payload FROM agent_state_log WHERE actor_id = ? ORDER BY id")
    .all(actorId);
}

async function send(f, event, payload, actorId = f.actorId) {
  const env = actorId === null ? {} : { HIVE_AGENT_ID: actorId };
  const result = await runNode(HOOK, [event], {
    dataDir,
    env,
    stdin: JSON.stringify(payload),
  });
  assert.equal(result.code, 0, `hook must exit 0 for ${event}`);
}

async function closeAndReapHome(f) {
  db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE id = ?").run(f.agentId);
  const { reapCodexHomeForClosedAgent } = await import("../dist/spawn.js");
  reapCodexHomeForClosedAgent(f.agentId, f.key);
}

const event = (session_id, transcript_path, extra = {}) => ({ hook_event_name: "UserPromptSubmit", session_id, transcript_path, ...extra });

describe("Codex worker hooks write only when the transcript belongs to the generated home", () => {
  it("an owned first prompt binds identity, clears resumed_at, changes state and appends its raw event", async () => {
    const f = fixture();
    const payload = event("owned-session", f.rollout);
    await send(f, "prompt", payload);
    assert.deepEqual(row(f.actorId), {
      agent_state: "working", session_id: "owned-session", transcript_path: f.rollout,
      resumed_at: "", state_changed_at: row(f.actorId).state_changed_at, codex_home: f.key,
    });
    assert.notEqual(row(f.actorId).state_changed_at, null);
    assert.notEqual(actor(f.actorId).last_seen_at, "2000-01-01 00:00:00");
    assert.deepEqual(logs(f.actorId).map(({ event, state }) => ({ event, state })), [{ event: "prompt", state: "working" }]);
    assert.equal(logs(f.actorId)[0].payload, JSON.stringify(payload));
  });

  it("a foreign first prompt cannot bind, clear the latch, touch last_seen or append a row", async () => {
    const f = fixture();
    const other = fixture();
    const before = row(f.actorId);
    const lastSeen = actor(f.actorId);
    await send(f, "prompt", event("foreign-session", other.rollout));
    assert.deepEqual(row(f.actorId), before);
    assert.deepEqual(actor(f.actorId), lastSeen);
    assert.deepEqual(logs(f.actorId), []);
  });

  it("an owned parent prompt and Stop survive a relocated child's foreign prompt and Stop", async () => {
    const f = fixture();
    const other = fixture();
    await send(f, "prompt", event("parent-session", f.rollout));
    const before = row(f.actorId);
    const lastSeen = actor(f.actorId);
    await send(f, "prompt", event("child-session", other.rollout));
    await send(f, "stop", { hook_event_name: "Stop", session_id: "parent-session", transcript_path: other.rollout });
    assert.deepEqual(row(f.actorId), before);
    assert.deepEqual(actor(f.actorId), lastSeen);
    await send(f, "stop", event("parent-session", f.rollout));
    assert.deepEqual(logs(f.actorId).map(({ event, state }) => ({ event, state })), [
      { event: "prompt", state: "working" }, { event: "stop", state: "idle" },
    ]);
    assert.equal(row(f.actorId).agent_state, "idle");
  });

  it("a matching session does not authorize a foreign path or a foreign first subagent event", async () => {
    const f = fixture({ state: "idle", sessionId: "parent-session", resumedAt: "" });
    const other = fixture();
    const before = row(f.actorId);
    await send(f, "prompt", event("parent-session", other.rollout));
    await send(f, "subagent_start", { hook_event_name: "SubagentStart", session_id: "child-session", transcript_path: other.rollout, agent_id: "child" });
    assert.deepEqual(row(f.actorId), before);
    assert.deepEqual(logs(f.actorId), []);
  });

  it("owned session replacements and fork-shaped rollout names remain accepted", async () => {
    const f = fixture();
    for (const sessionId of ["new-session", "clear-session", "resume-session", "fork-parent-session"]) {
      const rollout = join(f.sessions, sessionId === "fork-parent-session" ? "rollout-child-different-id.jsonl" : `rollout-child-${sessionId}.jsonl`);
      writeFileSync(rollout, "{}\n");
      await send(f, "prompt", event(sessionId, rollout));
      assert.equal(row(f.actorId).session_id, sessionId);
      assert.equal(row(f.actorId).transcript_path, rollout);
    }
    assert.deepEqual(logs(f.actorId).map(({ state }) => state), ["working", "working", "working", "working"]);
  });

  it("an owned compaction-shaped sequence still lets the parent Stop finish", async () => {
    const f = fixture();
    await send(f, "prompt", event("stable-session", f.rollout));
    await send(f, "prompt", event("stable-session", f.rollout, { hook_event_name: "PreCompact" }));
    await send(f, "stop", event("stable-session", f.rollout, { hook_event_name: "Stop" }));
    assert.deepEqual(logs(f.actorId).map(({ event, state }) => ({ event, state })), [
      { event: "prompt", state: "working" }, { event: "prompt", state: "working" }, { event: "stop", state: "idle" },
    ]);
  });

  it("a rejected subagent_start cannot hold idle and a rejected subagent_stop cannot close an owned start", async () => {
    const f = fixture({ state: "working" });
    const other = fixture();
    await send(f, "subagent_start", { hook_event_name: "SubagentStart", session_id: "parent", transcript_path: f.rollout, agent_id: "child" });
    await send(f, "subagent_stop", { hook_event_name: "SubagentStop", session_id: "parent", transcript_path: other.rollout, agent_id: "child" });
    await send(f, "stop", event("parent", f.rollout));
    assert.equal(row(f.actorId).agent_state, "working");
    assert.deepEqual(logs(f.actorId).map(({ event }) => event), ["subagent_start", "stop"]);
    await send(f, "subagent_stop", { hook_event_name: "SubagentStop", session_id: "parent", transcript_path: f.rollout, agent_id: "child" });
    await send(f, "stop", event("parent", f.rollout));
    assert.equal(row(f.actorId).agent_state, "idle");
    assert.deepEqual(logs(f.actorId).map(({ event }) => event), ["subagent_start", "stop", "subagent_stop", "stop"]);
  });

  it("missing, null and empty paths require an already-bound equal nonempty session", async () => {
    for (const transcript_path of [undefined, null, ""]) {
      const f = fixture({ state: "idle", sessionId: "bound-session", resumedAt: "" });
      const payload = { hook_event_name: "UserPromptSubmit", session_id: "bound-session", ...(transcript_path === undefined ? {} : { transcript_path }) };
      await send(f, "prompt", payload);
      assert.equal(row(f.actorId).agent_state, "working");
      assert.equal(row(f.actorId).session_id, "bound-session");
      assert.equal(row(f.actorId).transcript_path, "");
      assert.equal(logs(f.actorId).length, 1);
    }
    for (const { payload, initialSession } of [
      { payload: { hook_event_name: "UserPromptSubmit", session_id: "first-bind" }, initialSession: "" },
      { payload: { hook_event_name: "UserPromptSubmit", session_id: "replacement", transcript_path: null }, initialSession: "bound-session" },
      { payload: { hook_event_name: "UserPromptSubmit", session_id: 3, transcript_path: "" }, initialSession: "bound-session" },
      { payload: { hook_event_name: "UserPromptSubmit", session_id: "bound-session", transcript_path: 4 }, initialSession: "bound-session" },
      { payload: { hook_event_name: "UserPromptSubmit", session_id: "bound-session", transcript_path: false }, initialSession: "bound-session" },
    ]) {
      const f = fixture({ state: "idle", sessionId: initialSession, resumedAt: "" });
      const before = row(f.actorId);
      const lastSeen = actor(f.actorId);
      await send(f, "prompt", payload);
      assert.deepEqual(row(f.actorId), before);
      assert.deepEqual(actor(f.actorId), lastSeen);
      assert.deepEqual(logs(f.actorId), []);
    }
  });

  it("rejects sibling homes, sessions-prefix lookalikes, traversal, relative paths, NULs and outward symlinks", async () => {
    for (const pathKind of ["sibling", "prefix", "traversal", "relative", "nul", "symlink"]) {
      const f = fixture();
      const sibling = fixture();
      const outside = join(tmp, `outside-${serial++}.jsonl`);
      writeFileSync(outside, "{}\n");
      const link = join(f.sessions, "outward.jsonl");
      symlinkSync(outside, link);
      const transcript_path = {
        sibling: sibling.rollout,
        prefix: `${f.sessions}-lookalike/rollout.jsonl`,
        traversal: join(f.sessions, "..", "sessions-escape", "rollout.jsonl"),
        relative: "relative/rollout.jsonl",
        nul: `${f.rollout}\0bad`,
        symlink: link,
      }[pathKind];
      const before = row(f.actorId);
      const lastSeen = actor(f.actorId);
      await send(f, "prompt", event("unowned", transcript_path));
      assert.deepEqual(row(f.actorId), before, `rejected ${pathKind} path: ${String(transcript_path)}`);
      assert.deepEqual(actor(f.actorId), lastSeen);
      assert.deepEqual(logs(f.actorId), []);
      await send(f, "prompt", event(`owned-${pathKind}`, f.rollout));
      assert.equal(row(f.actorId).agent_state, "working", "owned positive control after every rejected path");
      assert.deepEqual(logs(f.actorId).map(({ event, state }) => ({ event, state })), [{ event: "prompt", state: "working" }]);
    }
  });

  it("accepts equivalent symlink aliases and an owned missing final rollout file", async () => {
    const f = fixture();
    const alias = join(tmp, `alias-${serial++}`);
    symlinkSync(f.homeDir, alias);
    const aliasPath = join(alias, "sessions", "2026", "10", "alias-rollout.jsonl");
    await send(f, "prompt", event("alias-session", aliasPath));
    assert.equal(row(f.actorId).transcript_path, aliasPath);
    assert.equal(row(f.actorId).session_id, "alias-session");
    assert.equal(existsSync(aliasPath), false, "the final file need not exist below owned directories");
    assert.equal(relative(realpathSync(f.homeDir), realpathSync(alias)), "");
  });

  it("serializes owned and foreign prompt/Stop events without letting foreign ingress replace identity", async () => {
    const f = fixture();
    const other = fixture();
    const results = await Promise.all([
      send(f, "prompt", event("owned-session", f.rollout)),
      send(f, "prompt", event("foreign-session", other.rollout)),
      send(f, "stop", event("foreign-session", other.rollout)),
    ]);
    assert.equal(results.length, 3);
    assert.equal(row(f.actorId).session_id, "owned-session");
    assert.equal(row(f.actorId).transcript_path, f.rollout);
    assert.deepEqual(logs(f.actorId).map(({ event, state }) => ({ event, state })), [{ event: "prompt", state: "working" }]);
    await send(f, "stop", event("owned-session", f.rollout));
    assert.deepEqual(logs(f.actorId).map(({ event, state }) => ({ event, state })), [
      { event: "prompt", state: "working" }, { event: "stop", state: "idle" },
    ]);
  });

  it("a closed and reaped Codex row ignores a foreign late hook while a running owned row still accepts its prompt", async () => {
    const closed = fixture();
    const foreign = fixture();
    await closeAndReapHome(closed);
    assert.equal(existsSync(closed.homeDir), false);
    assert.equal(row(closed.actorId).codex_home, "");
    const beforeRow = db.prepare("SELECT * FROM agents WHERE actor_id = ?").get(closed.actorId);
    const beforeActor = db.prepare("SELECT * FROM actors WHERE id = ?").get(closed.actorId);
    const beforeLogs = logs(closed.actorId);

    await send(closed, "prompt", event("late-foreign-session", foreign.rollout));

    assert.deepEqual(db.prepare("SELECT * FROM agents WHERE actor_id = ?").get(closed.actorId), beforeRow);
    assert.deepEqual(db.prepare("SELECT * FROM actors WHERE id = ?").get(closed.actorId), beforeActor);
    assert.deepEqual(logs(closed.actorId), beforeLogs);

    const running = fixture();
    await send(running, "prompt", event("owned-session", running.rollout));
    assert.equal(row(running.actorId).agent_state, "working");
    assert.equal(row(running.actorId).session_id, "owned-session");
    assert.equal(row(running.actorId).transcript_path, running.rollout);
    assert.deepEqual(logs(running.actorId).map(({ event, state }) => ({ event, state })), [{ event: "prompt", state: "working" }]);
  });

  it("preserves Claude, lead, legacy Codex and missing-identity behavior", async () => {
    const claude = fixture({ command: "claude", home: false });
    await send(claude, "prompt", event("claude-replacement", "/elsewhere/claude.jsonl"));
    assert.equal(row(claude.actorId).session_id, "claude-replacement");
    const lead = fixture({ kind: "lead", command: "codex", home: true });
    await send(lead, "prompt", event("lead-session", join(tmp, "foreign.jsonl")));
    assert.equal(row(lead.actorId).session_id, "");
    assert.deepEqual(logs(lead.actorId).map(({ state }) => state), ["working"]);
    const legacy = fixture({ command: "codex", home: false });
    await send(legacy, "prompt", event("legacy-session", "/legacy/path.jsonl"));
    assert.equal(row(legacy.actorId).session_id, "legacy-session");

    const closedClaude = fixture({ command: "claude", home: false });
    db.prepare("UPDATE agents SET status = 'closed', closed_at = datetime('now') WHERE actor_id = ?").run(closedClaude.actorId);
    await send(closedClaude, "prompt", event("closed-claude-session", "/closed/claude.jsonl"));
    assert.equal(row(closedClaude.actorId).agent_state, "working");
    assert.equal(row(closedClaude.actorId).session_id, "closed-claude-session");
    assert.equal(row(closedClaude.actorId).transcript_path, "/closed/claude.jsonl");

    const missing = fixture();
    await send(missing, "prompt", event("no-actor", missing.rollout), null);
    assert.deepEqual(logs(missing.actorId), []);
  });
});
