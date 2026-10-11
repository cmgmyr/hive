import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the question record tests");
const skip = !hasTmux && "tmux is not installed";
const dirs = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
const { QUEEN_REACH } = await import("../dist/context.js");
migrate();

const OWN_SOCKET = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const tmuxRun = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const sessions = [];
let seq = 0;

function pane() {
  const session = `questions-${process.pid}-${seq++}`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "cat"], { stdio: "ignore" });
  sessions.push(session);
  const id = tmuxRun("list-panes", "-t", `=${session}`, "-F", "#{pane_id}");
  return { id, pid: tmuxRun("display-message", "-p", "-t", id, "#{pane_pid}") };
}

function project(name, path) {
  mkdirSync(path, { recursive: true });
  const real = realpathSync(path);
  return { id: db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, real).id, path: real };
}

function agent(projectId, actor, { kind = "agent", live = true } = {}) {
  const p = live ? pane() : { id: "%gone", pid: "" };
  db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actor, actor);
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, pane_pid, command, cwd, status, agent_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'claude', '/tmp', 'running', 'working') RETURNING id`,
    )
    .get(projectId, actor, actor, kind, p.id, OWN_SOCKET, p.pid).id;
}

const home = project("questions-home", dirs.projectDir);
const away = project("questions-away", join(dirs.tmp, "away"));
const queen = project("queen", join(dirs.dataDir, "queen"));
const queenLeadId = db
  .prepare(
    `INSERT INTO agents (project_id, name, command, cwd, kind, status, tmux_target, tmux_socket)
     VALUES (?, 'lead', 'claude', '/', 'lead', 'running', '%none', '') RETURNING id`,
  )
  .get(queen.id);
db.prepare("UPDATE agents SET actor_id = 'lead:queen' WHERE id = ?").run(queenLeadId.id);
db.prepare("INSERT OR IGNORE INTO actors (id, name, kind) VALUES ('lead:queen', 'lead', 'lead')").run();

const clients = [];
async function clientAs(actor, cwd = home.path) {
  const env = actor ? { HIVE_AGENT_ID: actor } : {};
  const mcp = new McpClient({ cwd, dataDir: dirs.dataDir, env });
  await mcp.start();
  clients.push(mcp);
  return mcp;
}

const refusal = async (mcp, name, args) => {
  try {
    await mcp.call(name, args);
  } catch (e) {
    return e.message;
  }
  assert.fail(`${name} should have been refused: ${JSON.stringify(args)}`);
};

const opts = (n = 2, rec = 0) =>
  Array.from({ length: n }, (_, i) => ({ label: `Opt${i}`, description: `description ${i}`, recommended: i === rec }));
const choice = (over = {}) => ({
  kind: "choice",
  question: "Which database should hold the cache?",
  header: "Cache store",
  options: opts(),
  default_answer: "Opt0",
  ...over,
});
const freeText = (over = {}) => ({
  kind: "free_text",
  question: "What should the release be named?",
  header: "Release name",
  default_answer: "Keep the working title",
  ...over,
});
const rows = () => db.prepare("SELECT COUNT(*) AS n FROM questions").get().n;
const wakeCount = () => db.prepare("SELECT COUNT(*) AS n FROM wakes").get().n;

let asker;
let other;
let human;

before(async () => {
  if (!hasTmux) return;
  agent(home.id, "agent:asker");
  agent(home.id, "agent:other");
  agent(away.id, "agent:away");
  asker = await clientAs("agent:asker");
  other = await clientAs("agent:other");
  human = await clientAs(null);
});

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  cleanup(...sessions);
});

describe("question tools, over real MCP", () => {
  it("question records survive a server restart", { skip }, async () => {
    const made = await asker.call("question_ask", choice({ ref: { kind: "todo", number: 9001 } }));
    assert.equal(made.created, true);
    const fresh = await clientAs("agent:asker");
    const got = await fresh.call("question_get", { question_id: made.question_id });
    assert.equal(got.state, "pending");
    assert.equal(got.asker, "agent:asker");
    assert.deepEqual(got.ref, { kind: "todo", number: 9001 });
    assert.deepEqual(got.options, opts());
    assert.equal(got.default_answer, "Opt0");
  });

  it("ask upserts only a pending typed ref in its project", { skip }, async () => {
    const first = await asker.call("question_ask", choice({ ref: { kind: "pr", number: 7 } }));
    const before = rows();
    const again = await other.call(
      "question_ask",
      choice({ question: "Which store should hold the cache now?", ref: { kind: "pr", number: 7 } }),
    );
    assert.equal(again.question_id, first.question_id);
    assert.equal(again.created, false);
    assert.equal(rows(), before);
    const got = await asker.call("question_get", { question_id: first.question_id });
    assert.equal(got.question, "Which store should hold the cache now?");
    assert.equal(got.asker, "agent:asker", "the original asker survives an upsert by another session");
    assert.equal(got.updated_by, "agent:other");
  });

  it("absent and nonpending refs create new questions", { skip }, async () => {
    const a = await asker.call("question_ask", freeText());
    const b = await asker.call("question_ask", freeText());
    assert.notEqual(a.question_id, b.question_id);

    const todo = await asker.call("question_ask", freeText({ ref: { kind: "todo", number: 55 } }));
    const pr = await asker.call("question_ask", freeText({ ref: { kind: "pr", number: 55 } }));
    assert.notEqual(todo.question_id, pr.question_id, "a todo and a PR with the same number do not collide");

    await asker.call("question_update", { question_id: todo.question_id, state: "defaulted" });
    const afterDefault = await asker.call("question_ask", freeText({ ref: { kind: "todo", number: 55 } }));
    assert.notEqual(afterDefault.question_id, todo.question_id, "a defaulted row does not capture its ref");
    assert.equal(afterDefault.created, true);

    const awayClient = await clientAs("agent:away", away.path);
    const foreign = await awayClient.call("question_ask", freeText({ ref: { kind: "todo", number: 55 } }));
    assert.equal(foreign.created, true, "the same ref in another project is a different question");
    assert.equal(db.prepare("SELECT project_id FROM questions WHERE id = ?").get(foreign.question_id).project_id, away.id);
  });

  it("ask returns deterministic similar pending ids excluding itself", { skip }, async () => {
    db.exec("DELETE FROM questions");
    const ask = (question, ref) => asker.call("question_ask", freeText({ question, ...(ref ? { ref } : {}) }));
    const a = await ask("Should we retire the legacy exporter module?");
    const b = await ask("Retire legacy exporter module now?");
    const c = await ask("Which database for the cache?");
    const d = await ask("Rename the config module?");
    const e = await ask("  SHOULD we   retire the legacy exporter module? ");
    const gone = await ask("Retire the legacy exporter module soon?");
    await asker.call("question_update", { question_id: gone.question_id, state: "withdrawn" });
    const awayClient = await clientAs("agent:away", away.path);
    await awayClient.call("question_ask", freeText({ question: "Retire the legacy exporter module?" }));

    const probe = await ask("Retire the legacy exporter module?", { kind: "todo", number: 1 });
    assert.deepEqual(probe.similar_question_ids, [a.question_id, b.question_id, e.question_id].sort((x, y) => x - y));
    assert.ok(!probe.similar_question_ids.includes(probe.question_id));
    assert.ok(![c.question_id, d.question_id, gone.question_id].some((id) => probe.similar_question_ids.includes(id)));
    const reUpsert = await ask("Retire the legacy exporter module?", { kind: "todo", number: 1 });
    assert.deepEqual(reUpsert.similar_question_ids, probe.similar_question_ids);
  });

  it("invalid question shapes leave the store unchanged", { skip }, async () => {
    const before = rows();
    const bad = {
      "one option": choice({ options: opts(1) }),
      "five options": choice({ options: opts(5) }),
      "no option recommended": choice({ options: opts(3).map((o) => ({ ...o, recommended: false })) }),
      "two recommended": choice({ options: opts(3).map((o, i) => ({ ...o, recommended: i < 2 })) }),
      "header of 13 characters": choice({ header: "Cache storage" }),
      "blank header": choice({ header: "   " }),
      "free text header of 13": freeText({ header: "Release names" }),
      "free text without a header": (({ header, ...rest }) => rest)(freeText()),
      "default is not the recommended label": choice({ default_answer: "Opt1" }),
      "duplicate labels": choice({ options: opts(3).map((o) => ({ ...o, label: "Same" })), default_answer: "Same" }),
      "blank label": choice({ options: [{ label: " ", description: "x", recommended: true }, ...opts(2).slice(1)], default_answer: " " }),
      "blank description": choice({ options: [{ ...opts(2)[0], description: "" }, opts(2)[1]] }),
      "blank question": choice({ question: " " }),
      "blank default for free text": freeText({ default_answer: " " }),
      "free text carrying options": freeText({ options: opts() }),
      "choice without options": (({ options, ...rest }) => rest)(choice()),
      "control character in the question": choice({ question: "bell\u0007 here" }),
      "ref number zero": choice({ ref: { kind: "todo", number: 0 } }),
      "ref number past safe integer": choice({ ref: { kind: "todo", number: 2 ** 60 } }),
    };
    for (const [label, input] of Object.entries(bad)) {
      await refusal(asker, "question_ask", input);
      assert.equal(rows(), before, `${label} must not write`);
    }
    for (const n of [2, 3, 4]) {
      const ok = await asker.call("question_ask", choice({ question: `A fresh question number ${n} entirely`, options: opts(n) }));
      assert.equal(ok.created, true, `${n} options is valid`);
    }
    const twelve = await asker.call("question_ask", freeText({ question: "Twelve char header is fine here", header: "123456789012" }));
    assert.equal(twelve.created, true);
  });

  it("a session with no safe wake target cannot ask", { skip }, async () => {
    const before = rows();
    const noRow = await clientAs("agent:ghost");
    await refusal(noRow, "question_ask", freeText());
    assert.equal(rows(), before);
    const gone = agent(home.id, "agent:gone-pane", { live: false });
    const goneClient = await clientAs("agent:gone-pane");
    await refusal(goneClient, "question_ask", freeText());
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(gone);
    assert.equal(rows(), before);
  });

  it("explicit lifecycle changes remove only pending counts", { skip }, async () => {
    db.exec("DELETE FROM questions");
    const q = [];
    for (const word of ["alpha", "bravo", "charlie", "delta"]) {
      q.push((await asker.call("question_ask", freeText({ question: `Distinct ${word} question wording` }))).question_id);
    }
    const pending = () => db.prepare("SELECT COUNT(*) AS n FROM questions WHERE state = 'pending'").get().n;
    assert.equal(pending(), 4);
    assert.deepEqual(await asker.call("question_update", { question_id: q[0], state: "defaulted" }), { question_id: q[0], state: "defaulted" });
    assert.deepEqual(await human.call("question_update", { question_id: q[1], state: "withdrawn" }), { question_id: q[1], state: "withdrawn" });
    assert.equal(pending(), 2);
    const listed = (await asker.call("question_list")).questions;
    assert.deepEqual(listed.map((r) => [r.id, r.state]), [[q[2], "pending"], [q[3], "pending"], [q[0], "defaulted"]]);
    assert.equal((await asker.call("question_get", { question_id: q[1] })).state, "withdrawn", "get returns any state");
    assert.deepEqual(await asker.call("question_update", { question_id: q[0], state: "withdrawn" }), { question_id: q[0], state: "withdrawn" });
  });

  it("lifecycle rejects nonowner and terminal changes", { skip }, async () => {
    const id = (await asker.call("question_ask", freeText({ question: "Lifecycle ownership probe wording" }))).question_id;
    await refusal(other, "question_update", { question_id: id, state: "withdrawn" });
    assert.equal(db.prepare("SELECT state FROM questions WHERE id = ?").get(id).state, "pending");

    await asker.call("question_update", { question_id: id, state: "defaulted" });
    assert.match(await refusal(asker, "question_update", { question_id: id, state: "defaulted" }), /QUESTION_STATE_CONFLICT/);
    assert.match(await refusal(asker, "question_update", { question_id: id, question: "edit a defaulted row" }), /QUESTION_STATE_CONFLICT/);

    await asker.call("question_update", { question_id: id, state: "withdrawn" });
    for (const patch of [{ state: "defaulted" }, { state: "withdrawn" }, { question: "edit a withdrawn row" }]) {
      assert.match(await refusal(asker, "question_update", { question_id: id, ...patch }), /QUESTION_STATE_CONFLICT/);
    }
    assert.equal(db.prepare("SELECT state FROM questions WHERE id = ?").get(id).state, "withdrawn");
    await refusal(asker, "question_update", { question_id: id });
  });

  it("update merges and revalidates the whole payload", { skip }, async () => {
    const id = (await asker.call("question_ask", choice({ question: "Merge validation probe wording" }))).question_id;
    await refusal(asker, "question_update", { question_id: id, default_answer: "Opt1" });
    await refusal(asker, "question_update", { question_id: id, header: "thirteen char" });
    await refusal(asker, "question_update", { question_id: id, options: opts(1) });
    await asker.call("question_update", { question_id: id, header: "New header" });
    await asker.call("question_update", { question_id: id, options: opts(3, 2), default_answer: "Opt2" });
    const got = await asker.call("question_get", { question_id: id });
    assert.equal(got.header, "New header");
    assert.equal(got.default_answer, "Opt2");
    assert.equal(got.options.length, 3);
    const ft = (await asker.call("question_ask", freeText({ question: "Free text options probe wording" }))).question_id;
    await refusal(asker, "question_update", { question_id: ft, options: opts() });
  });

  it("question tools reject unknown nested and root keys", { skip }, async () => {
    const before = rows();
    assert.match(await refusal(asker, "question_ask", { ...freeText(), typo: true }), /typo/);
    assert.match(await refusal(asker, "question_ask", choice({ options: [{ ...opts(2)[0], extra: 1 }, opts(2)[1]] })), /extra/);
    assert.match(await refusal(asker, "question_ask", freeText({ ref: { kind: "todo", number: 1, extra: 1 } })), /extra/);
    assert.match(await refusal(asker, "question_ask", { ...freeText(), project_id: away.id }), /project_id/);
    assert.match(await refusal(asker, "question_get", { question_id: 1, project_id: away.id }), /project_id/);
    assert.match(await refusal(asker, "question_list", { extra: 1 }), /extra/);
    assert.match(await refusal(asker, "question_update", { question_id: 1, state: "withdrawn", extra: 1 }), /extra/);
    assert.match(await refusal(asker, "question_answer", { question_id: 1, answer: "x", extra: 1 }), /extra/);
    assert.equal(rows(), before);
  });

  it("question reads and writes refuse foreign ids and queen text access", { skip }, async () => {
    const awayClient = await clientAs("agent:away", away.path);
    const foreign = (await awayClient.call("question_ask", freeText({ question: "Secret away project question text" }))).question_id;
    const snapshot = db.prepare("SELECT * FROM questions WHERE id = ?").get(foreign);

    for (const [name, args] of [
      ["question_get", { question_id: foreign }],
      ["question_update", { question_id: foreign, state: "withdrawn" }],
      ["question_answer", { question_id: foreign, answer: "stolen" }],
    ]) {
      const message = await refusal(asker, name, args);
      assert.match(message, /No question/);
      assert.ok(!message.includes("Secret away"), "a refusal never echoes the foreign text");
    }
    assert.ok(!JSON.stringify(await asker.call("question_list")).includes("Secret away"));
    assert.deepEqual(db.prepare("SELECT * FROM questions WHERE id = ?").get(foreign), snapshot);

    for (const tool of ["question_ask", "question_get", "question_list", "question_update", "question_answer"]) {
      assert.equal(QUEEN_REACH[tool], "home", `${tool} is classified for the queen as home-only`);
    }
    const queenMcp = await clientAs("lead:queen", queen.path);
    assert.match(await refusal(queenMcp, "question_get", { question_id: foreign }), /No question/);
    assert.match(await refusal(queenMcp, "question_get", { question_id: foreign, project_id: away.id }), /project_id/);
    assert.ok(!JSON.stringify(await queenMcp.call("question_list")).includes("Secret away"));
  });
});

describe("the question table's ownership", () => {
  it("questions prevent empty project and actor pruning", { skip }, async () => {
    const lonely = project("questions-lonely", join(dirs.tmp, "lonely"));
    const actor = "agent:question-only";
    db.prepare("INSERT INTO actors (id, name, kind, last_seen_at) VALUES (?, ?, 'agent', datetime('now', '-1 day'))").run(actor, actor);
    db.prepare(
      `INSERT INTO questions (project_id, asker, asker_agent_id, kind, question, header, default_answer, updated_by)
       VALUES (?, 'agent:someone', 1, 'free_text', 'q', 'h', 'd', ?)`,
    ).run(lonely.id, actor);
    const prune = await human.call("project_prune");
    assert.ok(!prune.deleted?.some?.((p) => p.id === lonely.id), JSON.stringify(prune));
    assert.ok(db.prepare("SELECT 1 FROM projects WHERE id = ?").get(lonely.id));
    await human.call("actor_prune");
    assert.ok(db.prepare("SELECT 1 FROM actors WHERE id = ?").get(actor), "an actor named by a question row is kept");
  });
});
