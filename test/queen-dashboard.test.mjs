import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { after, before, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, makeFakeClaude, makeFakeOpen, runCli, runNode, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the queen dashboard tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const { db, migrate } = await import("../dist/db.js");
migrate();
const { addProject } = await import("../dist/context.js");
const { parseQueenBrief, readQueenBrief, renderQueenDashboard, QUEEN_BRIEF_KEY } = await import("../dist/queenDashboard.js");
const { tick, generateQueenDashboardNow } = await import("../dist/scheduler.js");

after(() => {
  let sessions = [];
  try {
    sessions = tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean);
  } catch {}
  cleanup(...sessions);
});

const AS_OF = "2026-09-29 12:00:00";
const LANES = ["waiting_on_you", "stuck", "moving", "quiet"];
const noLinks = () => null;

function proj(id, lane, over = {}) {
  return {
    id,
    name: `proj-${id}`,
    root: `/nowhere/${id}`,
    root_exists: true,
    lane,
    reasons: [lane === "quiet" ? "quiet" : lane === "stuck" ? "dead_lead_pane" : lane === "moving" ? "worker_working" : "needs_human"],
    lead: { state: "alive", agent_id: id, turn: "unknown" },
    workers: { working: 0, idle: 0, needs_input: 0, other: 0, unreachable: 0, unconfirmed: 0 },
    todos: { open: 3, in_progress: 1, blocked: 0, blocked_in_progress: 0, high: 0 },
    needs_human: 0,
    needs_human_items: [],
    last_activity_at: "2026-09-29 11:00:00",
    wakes: { pending: 0, overdue: 0 },
    ...over,
  };
}

function report(projects) {
  const lanes = { waiting_on_you: 0, stuck: 0, moving: 0, quiet: 0 };
  for (const p of projects) lanes[p.lane]++;
  return { schema_version: 1, as_of: AS_OF, totals: { projects: projects.length, lanes }, projects };
}

const oneEach = () => [proj(4, "quiet"), proj(2, "stuck"), proj(1, "waiting_on_you", { needs_human: 1, needs_human_items: [{ todo_id: 9, title: "Approve it", slug: null, updated_at: "2026-09-27 08:00:00" }] }), proj(3, "moving")];

const brief = (over = {}) => ({
  schema_version: 1,
  written_at: "2026-09-29 09:00:00",
  summary: "Morning summary",
  picks: [{ project_id: 1, todo_id: 9, action: "Answer the todo", reason: "It waited two days" }],
  lanes_at_brief: { 1: "waiting_on_you", 2: "stuck", 3: "moving", 4: "quiet" },
  ...over,
});
const ready = (b) => ({ kind: "ready", brief: b });
const count = (html, needle) => html.split(needle).length - 1;

describe("parseQueenBrief", () => {
  it("accepts the v1 shape, including empty picks", () => {
    assert.equal(parseQueenBrief(JSON.stringify(brief())).kind, "ready");
    assert.equal(parseQueenBrief(JSON.stringify(brief({ picks: [] }))).kind, "ready");
    assert.equal(parseQueenBrief(JSON.stringify(brief({ picks: [{ project_id: 1, todo_id: null, action: "a", reason: "r" }] }))).kind, "ready");
  });

  it("reads a schema_version other than numeric 1 as wrong_version, and a missing one as malformed", () => {
    for (const v of [2, "1", 0, null]) {
      assert.deepEqual(parseQueenBrief(JSON.stringify(brief({ schema_version: v }))), { kind: "invalid", reason: "wrong_version" });
    }
    const { schema_version, ...rest } = brief();
    assert.deepEqual(parseQueenBrief(JSON.stringify(rest)), { kind: "invalid", reason: "malformed" });
  });

  it("rejects malformed JSON, non-objects and every malformed nested field", () => {
    const bad = [
      "{nope",
      "[]",
      "null",
      JSON.stringify(brief({ extra: 1 })),
      JSON.stringify(brief({ written_at: "2026-09-29T09:00:00Z" })),
      JSON.stringify(brief({ summary: "  " })),
      JSON.stringify(brief({ picks: "x" })),
      JSON.stringify(brief({ picks: [{ project_id: 0, todo_id: null, action: "a", reason: "r" }] })),
      JSON.stringify(brief({ picks: [{ project_id: 1.5, todo_id: null, action: "a", reason: "r" }] })),
      JSON.stringify(brief({ picks: [{ project_id: 1, todo_id: 0, action: "a", reason: "r" }] })),
      JSON.stringify(brief({ picks: [{ project_id: 1, todo_id: null, action: "", reason: "r" }] })),
      JSON.stringify(brief({ picks: [{ project_id: 1, todo_id: null, action: "a" }] })),
      JSON.stringify(brief({ picks: [{ project_id: 1, todo_id: null, action: "a", reason: "r", x: 1 }] })),
      JSON.stringify(brief({ lanes_at_brief: { "01": "quiet" } })),
      JSON.stringify(brief({ lanes_at_brief: { 1: "asleep" } })),
      JSON.stringify(brief({ lanes_at_brief: [] })),
    ];
    for (const raw of bad) assert.deepEqual(parseQueenBrief(raw), { kind: "invalid", reason: "malformed" }, raw);
  });
});

describe("readQueenBrief", () => {
  mkdirSync(join(dirs.tmp, "brief-queen"));
  mkdirSync(join(dirs.tmp, "brief-other"));
  const queen = addProject(join(dirs.tmp, "brief-queen"), "brief-queen");
  const put = (value, expires = null) =>
    db.prepare("INSERT OR REPLACE INTO kv (project_id, key, value, expires_at) VALUES (?, ?, ?, ?)").run(queen.id, QUEEN_BRIEF_KEY, value, expires);

  it("is missing with no row, and reads a row with no expiry", () => {
    assert.deepEqual(readQueenBrief(queen.id, AS_OF), { kind: "missing" });
    put(JSON.stringify(brief()));
    assert.equal(readQueenBrief(queen.id, AS_OF).kind, "ready");
  });

  it("treats an expired row as missing without purging it, and honours a row expiring exactly at asOf", () => {
    put(JSON.stringify(brief()), "2026-09-29 11:59:59");
    assert.deepEqual(readQueenBrief(queen.id, AS_OF), { kind: "missing" });
    assert.ok(db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(queen.id, QUEEN_BRIEF_KEY), "expired row must not be purged");
    put(JSON.stringify(brief()), AS_OF);
    assert.equal(readQueenBrief(queen.id, AS_OF).kind, "ready");
  });

  it("never reads another project's brief", () => {
    const other = addProject(join(dirs.tmp, "brief-other"), "brief-other");
    assert.deepEqual(readQueenBrief(other.id, AS_OF), { kind: "missing" });
  });
});

describe("renderQueenDashboard", () => {
  it("emits one card and one grid row per project, each project in exactly one lane, in lane order", () => {
    const projects = oneEach();
    const html = renderQueenDashboard(report(projects), { kind: "missing" }, noLinks);
    for (const p of projects) {
      assert.equal(count(html, `data-project="${p.id}"`), 1, `card for ${p.id}`);
      assert.equal(count(html, `id="row-${p.id}"`), 1, `row for ${p.id}`);
    }
    const lanePos = LANES.map((l) => html.indexOf(`data-lane="${l}"`));
    assert.deepEqual([...lanePos].sort((a, b) => a - b), lanePos);
    const rows = [...html.matchAll(/id="row-(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepEqual(rows, [1, 2, 3, 4]);
  });

  it("copies lane counts from report.totals and never recounts", () => {
    const r = report(oneEach());
    r.totals = { projects: 40, lanes: { waiting_on_you: 11, stuck: 12, moving: 13, quiet: 14 } };
    const html = renderQueenDashboard(r, { kind: "missing" }, noLinks);
    for (const [lane, n] of Object.entries(r.totals.lanes)) {
      assert.match(html, new RegExp(`data-lane="${lane}"[^>]*>.*?<span class="count">${n}</span>`));
    }
    assert.match(html, /Every project <span class="count">40<\/span>/);
    assert.match(html, /40 projects on this machine/);
  });

  it("lists needs-human titles with +N more, and labels reasons from the collector's codes", () => {
    const items = [1, 2].map((i) => ({ todo_id: i, title: `Title ${i}`, slug: null, updated_at: "2026-09-29 11:30:00" }));
    const p = proj(1, "waiting_on_you", { needs_human: 7, needs_human_items: items, reasons: ["needs_human", "worker_needs_input"] });
    const html = renderQueenDashboard(report([p, proj(2, "stuck", { reasons: ["dead_lead_pane", "wake_overdue_5m"], lead: { state: "dead_pane", agent_id: 2, turn: "unknown" } })]), { kind: "missing" }, noLinks);
    assert.match(html, /Title 1/);
    assert.match(html, /\+5 more/);
    assert.match(html, /A worker is waiting for input/);
    assert.match(html, /Lead pane is dead/);
    assert.match(html, /A wake is overdue/);
    assert.match(html, /lead dead/);
  });

  it("shows the report's turn beside lead up on a card and a grid row, and nothing when unknown", () => {
    const ended = renderQueenDashboard(report([proj(1, "moving", { lead: { state: "alive", agent_id: 1, turn: "turn_ended" } })]), { kind: "missing" }, noLinks);
    assert.equal((ended.match(/<span class="turn turn-end">turn ended<\/span>/g) ?? []).length, 2);
    const working = renderQueenDashboard(report([proj(1, "moving", { lead: { state: "alive", agent_id: 1, turn: "working" } })]), { kind: "missing" }, noLinks);
    assert.match(working, /<span class="turn turn-work">working<\/span>/);
    const unknown = renderQueenDashboard(report([proj(1, "moving")]), { kind: "missing" }, noLinks);
    assert.doesNotMatch(unknown, /class="turn /);
  });

  it("lists recent queen actions with the project name, escaping every audit string", () => {
    const row = { id: 1, actor_id: "<b>a</b>", home_project_id: 9, target_project_id: 1, operation: "todo_comment<i>", resource_type: "todo", resource_id: 42, summary: "<script>alert(1)</script>", created_at: "2026-09-29 11:00:00" };
    const html = renderQueenDashboard(report([proj(1, "moving")]), { kind: "missing" }, noLinks, [row]);
    assert.match(html, /Recent queen actions/);
    assert.match(html, /proj-1<\/span><span class="audit-op">todo_comment&lt;i&gt;<\/span><span class="ref">todo #42<\/span>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  it("shows an empty state line when there are no queen actions", () => {
    const html = renderQueenDashboard(report([proj(1, "moving")]), { kind: "missing" }, noLinks);
    assert.match(html, /No queen actions recorded yet/);
  });

  it("names a missing project folder in the grid and renders the name as text without a link", () => {
    const html = renderQueenDashboard(report([proj(1, "quiet", { root_exists: false })]), { kind: "missing" }, noLinks);
    assert.match(html, /project folder is missing/);
    assert.doesNotMatch(html, /<a class="proj"/);
  });

  it("renders a visible zero-project state", () => {
    const html = renderQueenDashboard(report([]), { kind: "missing" }, noLinks);
    assert.match(html, /No projects registered/);
    assert.match(html, /0 projects on this machine/);
  });

  it("shows a visible notice for a missing, malformed or wrong-version brief and still renders every project", () => {
    const cases = [
      [{ kind: "missing" }, "No queen brief yet"],
      [{ kind: "invalid", reason: "malformed" }, "Queen brief could not be read"],
      [{ kind: "invalid", reason: "wrong_version" }, "Queen brief version is unsupported"],
    ];
    for (const [state, text] of cases) {
      const html = renderQueenDashboard(report(oneEach()), state, noLinks);
      assert.ok(html.includes(text), text);
      assert.doesNotMatch(html, /Since the brief/);
      assert.doesNotMatch(html, /class="pc-pick"/);
      assert.equal(count(html, 'id="row-'), 4);
    }
  });

  it("shows a fresh brief's action and reason, its age, and reports no lane change", () => {
    const html = renderQueenDashboard(report(oneEach()), ready(brief()), noLinks);
    assert.match(html, /Answer the todo/);
    assert.match(html, /It waited two days/);
    assert.match(html, /written 2026-09-29 09:00:00 UTC, 3h ago/);
    assert.match(html, /No project changed lanes since the brief\./);
    assert.match(html, /pick 1/);
  });

  it("reports only lane, new and removed changes, in lane then id order", () => {
    const b = brief({ lanes_at_brief: { 1: "quiet", 2: "stuck", 3: "waiting_on_you", 9: "moving" } });
    const html = renderQueenDashboard(report(oneEach()), ready(b), noLinks);
    const drift = html.match(/<p class="drift">(.*?)<\/p>/)[1];
    assert.ok(drift.indexOf("proj-1 moved from quiet to waiting on you") >= 0, drift);
    assert.ok(drift.indexOf("proj-3 moved from waiting on you to moving") > drift.indexOf("proj-1 moved"), drift);
    assert.ok(drift.indexOf("proj-4 is new since the brief") > drift.indexOf("proj-3 moved"), drift);
    assert.ok(drift.includes("project #9 is no longer registered"), drift);
    assert.doesNotMatch(drift, /proj-2/);
  });

  it("labels a pick for an unregistered project and keeps its action and reason", () => {
    const b = brief({ picks: [{ project_id: 77, todo_id: 5, action: "Do the thing", reason: "Because" }] });
    const html = renderQueenDashboard(report(oneEach()), ready(b), noLinks);
    assert.match(html, /#77 \(not registered\)/);
    assert.match(html, /Do the thing/);
    assert.match(html, /Because/);
  });

  it("escapes every store string and emits exactly one script element", () => {
    const evil = `<script>alert(1)</script>"'&`;
    const p = proj(1, "waiting_on_you", {
      name: evil,
      needs_human: 1,
      needs_human_items: [{ todo_id: 1, title: evil, slug: null, updated_at: "2026-09-29 11:30:00" }],
    });
    const b = brief({
      summary: evil,
      picks: [{ project_id: 1, todo_id: 1, action: evil, reason: evil }, { project_id: 5, todo_id: null, action: evil, reason: evil }],
      lanes_at_brief: { 1: "quiet", 8: "quiet" },
    });
    const html = renderQueenDashboard(report([p]), ready(b), () => `file:///x" onmouseover="alert(1)`);
    assert.equal(count(html, "<script"), 1);
    assert.equal(count(html, "alert(1)</script>"), 0);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;"));
    assert.doesNotMatch(html, /" onmouseover="/);
  });

  it("holds the auto-refresh in script with a cancellable timer and sessionStorage, never a meta refresh", () => {
    const html = renderQueenDashboard(report(oneEach()), { kind: "missing" }, noLinks);
    assert.doesNotMatch(html, /http-equiv/i);
    assert.match(html, /clearTimeout\(timer\)/);
    assert.match(html, /box\.checked \? setTimeout\(function \(\) \{ location\.reload\(\); \}, 60000\)/);
    assert.match(html, /sessionStorage\.setItem\(KEY/);
  });

  it("says just now, with no ago, for a brief written under a minute before as_of", () => {
    const html = renderQueenDashboard(report(oneEach()), ready(brief({ written_at: "2026-09-29 11:59:40" })), noLinks);
    assert.match(html, /written 2026-09-29 11:59:40 UTC, just now</);
    assert.doesNotMatch(html, /now ago/);
  });

  it("drops the drift line's claim about the picks, leaving lane changes only", () => {
    const html = renderQueenDashboard(report(oneEach()), ready(brief({ lanes_at_brief: { 1: "quiet", 2: "stuck", 3: "moving", 4: "quiet" } })), noLinks);
    assert.doesNotMatch(html, /do not know that/);
    assert.match(html, /proj-1 moved from quiet to waiting on you\.<\/p>/);
  });

  it("names every portfolio STUCK reason in the stuck lane caption", () => {
    const source = readFileSync(new URL("../dist/portfolio.js", import.meta.url), "utf8");
    const stuck = [...source.match(/const STUCK = \[([^\]]*)\]/)[1].matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
    assert.ok(stuck.length >= 6, `parsed STUCK list: ${stuck}`);
    const phrase = {
      dead_lead_pane: "dead lead",
      missing_root_with_work: "missing folder",
      worker_needs_input: "prompt",
      wake_overdue_5m: "late wake",
      in_progress_blocked: "blocked",
      all_active_todos_blocked: "blocked",
      stale_in_progress_48h: "stale",
    };
    const html = renderQueenDashboard(report(oneEach()), { kind: "missing" }, noLinks);
    const caption = html.match(/data-lane="stuck"[^>]*>.*?<p class="lane-rule">([^<]*)<\/p>/)[1];
    for (const reason of stuck) {
      assert.ok(phrase[reason], `caption phrase needed for new STUCK reason ${reason}`);
      assert.ok(caption.includes(phrase[reason]), `${reason} missing from caption: ${caption}`);
    }
  });

  it("starts the reload timer by default, stops it when stored off, and re-arms on toggle", () => {
    const html = renderQueenDashboard(report(oneEach()), { kind: "missing" }, noLinks);
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    const run = (stored) => {
      const timers = [];
      const listeners = {};
      const box = { checked: false, addEventListener: (e, f) => (listeners[e] = f) };
      const store = new Map(stored === null ? [] : [["queen-autoreload", stored]]);
      vm.runInNewContext(script, {
        document: { getElementById: () => box, addEventListener() {} },
        sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
        setTimeout: (f, ms) => (timers.push(ms), timers.length),
        clearTimeout() {},
        location: { reload() {} },
        window: {},
      });
      return { box, timers, listeners, store };
    };
    const fresh = run(null);
    assert.equal(fresh.box.checked, true);
    assert.deepEqual(fresh.timers, [60000]);
    const off = run("0");
    assert.equal(off.box.checked, false);
    assert.deepEqual(off.timers, []);
    off.box.checked = true;
    off.listeners.change();
    assert.deepEqual(off.timers, [60000]);
    assert.equal(off.store.get("queen-autoreload"), "1");
  });

  it("links a project name to its own dashboard only when that file exists inside the project", () => {
    const root = join(dirs.tmp, "linked");
    mkdirSync(join(root, ".hive"), { recursive: true });
    writeFileSync(join(root, ".hive", "dashboard.html"), "<html></html>");
    const withFile = renderQueenDashboard(report([proj(1, "quiet", { root })]), { kind: "missing" });
    assert.match(withFile, /<a class="proj" href="file:\/\/[^"]*\/linked\/\.hive\/dashboard\.html"/);
    const outside = join(dirs.tmp, "outside-hive");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "dashboard.html"), "<html>elsewhere</html>");
    const escaped = join(dirs.tmp, "escaped-root");
    mkdirSync(escaped, { recursive: true });
    symlinkSync(outside, join(escaped, ".hive"));
    const viaSymlink = renderQueenDashboard(report([proj(1, "quiet", { root: escaped })]), { kind: "missing" });
    assert.doesNotMatch(viaSymlink, /<a class="proj"/, "a .hive symlinked outside the project root must not be linked");
    const without = renderQueenDashboard(report([proj(1, "quiet", { root: join(dirs.tmp, "nolink") })]), { kind: "missing" });
    assert.doesNotMatch(without, /<a class="proj"/);
  });
});

describe("queen dashboard generation", () => {
  const home = join(dirs.dataDir, "queen");
  const page = () => join(realpathSync(home), "dashboard.html");
  let queen;

  before(() => {
    mkdirSync(home, { recursive: true });
    queen = addProject(home, "queen");
    db.prepare("DELETE FROM dashboard_meta WHERE project_id = ?").run(queen.id);
  });

  const forceClaim = () =>
    db.prepare("UPDATE kv SET updated_at = datetime('now', '-1 minute') WHERE project_id = ? AND key = 'hive:queen-page-claim'").run(queen.id);

  it("a scheduler tick writes queen/dashboard.html and no queen/.hive/dashboard.html", async () => {
    await tick(null);
    assert.ok(existsSync(page()), "queen page missing");
    assert.ok(!existsSync(join(realpathSync(home), ".hive", "dashboard.html")));
    const html = readFileSync(page(), "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<\/html>\n$/);
    assert.match(html, /No queen brief yet/);
  });

  it("renders a brief written into the queen's kv on the next claimed tick, and leaves no temp file", async () => {
    db.prepare("INSERT OR REPLACE INTO kv (project_id, key, value) VALUES (?, ?, ?)").run(
      queen.id,
      QUEEN_BRIEF_KEY,
      JSON.stringify(brief({ summary: "Fresh from the kv", picks: [], lanes_at_brief: {} })),
    );
    forceClaim();
    await tick(null);
    assert.match(readFileSync(page(), "utf8"), /Fresh from the kv/);
    assert.deepEqual(readdirSync(realpathSync(home)).filter((f) => f.includes(".tmp-")), []);
  });

  it("a cold generate records the page hash so a later tick cannot keep a stale cold page", async () => {
    const put = (summary) =>
      db.prepare("INSERT OR REPLACE INTO kv (project_id, key, value) VALUES (?, ?, ?)").run(
        queen.id,
        QUEEN_BRIEF_KEY,
        JSON.stringify(brief({ summary, picks: [], lanes_at_brief: {} })),
      );
    put("State A");
    forceClaim();
    await tick(null);
    assert.match(readFileSync(page(), "utf8"), /State A/);
    put("State C");
    assert.equal(generateQueenDashboardNow(), page());
    assert.match(readFileSync(page(), "utf8"), /State C/);
    put("State A");
    forceClaim();
    await tick(null);
    assert.match(readFileSync(page(), "utf8"), /State A/);
  });

  it("does not rewrite while the five-second claim is held", async () => {
    forceClaim();
    await tick(null);
    const first = readFileSync(page(), "utf8");
    db.prepare("UPDATE kv SET value = ?, updated_at = datetime('now') WHERE project_id = ? AND key = ?").run("{}", queen.id, QUEEN_BRIEF_KEY);
    await tick(null);
    assert.equal(readFileSync(page(), "utf8"), first);
  });

  it("an ordinary-dashboard claim and mark on the queen project's dashboard_meta row never starve the queen page", async () => {
    db.prepare("INSERT OR IGNORE INTO dashboard_meta (project_id) VALUES (?)").run(queen.id);
    db.prepare("UPDATE dashboard_meta SET last_attempt_at = datetime('now'), last_mark = 'old-server-mark' WHERE project_id = ?").run(queen.id);
    db.prepare("INSERT OR REPLACE INTO kv (project_id, key, value) VALUES (?, ?, ?)").run(
      queen.id,
      QUEEN_BRIEF_KEY,
      JSON.stringify(brief({ summary: "Written past an old server", picks: [], lanes_at_brief: {} })),
    );
    forceClaim();
    await tick(null);
    assert.match(readFileSync(page(), "utf8"), /Written past an old server/);
  });

  it("a failed write keeps the prior page, leaves no temp file, and the tick resolves", async () => {
    const before = readFileSync(page(), "utf8");
    forceClaim();
    const blocked = join(realpathSync(home), ".dashboard.html.tmp-" + process.pid);
    mkdirSync(blocked);
    try {
      await tick(null);
    } finally {
      db.prepare("DELETE FROM kv WHERE project_id = ? AND key LIKE 'hive:queen-page-%'").run(queen.id);
    }
    assert.equal(readFileSync(page(), "utf8"), before);
    assert.equal(generateQueenDashboardNow(), null);
    assert.equal(readFileSync(page(), "utf8"), before);
    rmSync(blocked, { recursive: true });
    assert.equal(generateQueenDashboardNow(), page());
  });

  it("generateQueenDashboardNow returns null while the queen project is not registered", () => {
    const script = `const { generateQueenDashboardNow } = await import(${JSON.stringify(new URL("../dist/scheduler.js", import.meta.url).href)});\nconsole.log(JSON.stringify(generateQueenDashboardNow()));`;
    const other = scratchDirs();
    writeFileSync(join(other.tmp, "f.mjs"), script);
    return runNode(join(other.tmp, "f.mjs"), [], { cwd: other.projectDir, dataDir: other.dataDir, tmp: other.tmp }).then((r) => {
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), "null");
    });
  });

  it("a second data dir writes only its own queen file", async () => {
    const other = scratchDirs();
    const otherHome = join(other.dataDir, "queen");
    mkdirSync(otherHome, { recursive: true });
    const script =
      `const { migrate } = await import(${JSON.stringify(new URL("../dist/db.js", import.meta.url).href)});\nmigrate();\n` +
      `const { addProject } = await import(${JSON.stringify(new URL("../dist/context.js", import.meta.url).href)});\n` +
      `const { generateQueenDashboardNow } = await import(${JSON.stringify(new URL("../dist/scheduler.js", import.meta.url).href)});\n` +
      `addProject(${JSON.stringify(otherHome)}, "queen");\nconsole.log(generateQueenDashboardNow());`;
    writeFileSync(join(other.tmp, "f.mjs"), script);
    const before = readFileSync(page(), "utf8");
    const r = await runNode(join(other.tmp, "f.mjs"), [], { cwd: other.projectDir, dataDir: other.dataDir, tmp: other.tmp });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), join(realpathSync(otherHome), "dashboard.html"));
    assert.ok(existsSync(join(otherHome, "dashboard.html")));
    assert.equal(readFileSync(page(), "utf8"), before);
  });

  it("concurrent writers only ever expose a whole page", async () => {
    const script =
      `import { readFileSync } from "node:fs";\n` +
      `const { generateQueenDashboardNow } = await import(${JSON.stringify(new URL("../dist/scheduler.js", import.meta.url).href)});\n` +
      `const target = generateQueenDashboardNow();\nlet bad = 0;\n` +
      `for (let i = 0; i < 60; i++) { generateQueenDashboardNow(); const h = readFileSync(target, "utf8"); if (!h.endsWith("</html>\\n")) bad++; }\n` +
      `console.log(bad);`;
    writeFileSync(join(dirs.tmp, "conc.mjs"), script);
    const runs = await Promise.all([1, 2, 3].map(() => runNode(join(dirs.tmp, "conc.mjs"), [], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp })));
    for (const r of runs) {
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), "0");
    }
  });
});


describe("hive queen opens the queen page", { skip: hasTmux && process.platform === "darwin" ? false : "needs tmux on darwin" }, () => {
  const fakeOpen = makeFakeOpen(dirs.tmp);
  const claudePath = makeFakeClaude(dirs.tmp)("sleep 600");
  const MARKER = "hive:dashboard_opened";
  const run = (bin, extra = []) =>
    runCli(["queen", ...extra], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${dirname(claudePath)}:${bin}:${process.env.PATH}`, TERM_PROGRAM: "" },
    });
  const queenId = () => db.prepare("SELECT id FROM projects WHERE name = 'queen'").get().id;
  const queenPage = () => join(realpathSync(join(dirs.dataDir, "queen")), "dashboard.html");

  it("renders the page before attaching, opens its one file:// URL, and suppresses a repeat inside eight hours", async () => {
    const first = await run(fakeOpen.bin);
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.ok(existsSync(queenPage()));
    const calls = fakeOpen.calls();
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.equal(calls[0], new URL(`file://${queenPage()}`).href);

    const again = await run(fakeOpen.bin);
    assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.equal(fakeOpen.calls().length, 1);
  });

  it("--no-dashboard writes the page but opens nothing, and a failed open leaves no marker so the next run retries", async () => {
    db.prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(queenId(), MARKER);
    fakeOpen.reset();
    rmSync(queenPage());
    assert.equal((await run(fakeOpen.bin, ["--no-dashboard"])).code, 0);
    assert.deepEqual(fakeOpen.calls(), []);
    assert.ok(existsSync(queenPage()), "--no-dashboard skips only the open; the page is still written");

    assert.equal((await run(fakeOpen.failBin)).code, 0);
    assert.equal(db.prepare("SELECT 1 FROM kv WHERE project_id = ? AND key = ?").get(queenId(), MARKER), undefined);
    assert.equal((await run(fakeOpen.bin)).code, 0);
    assert.equal(fakeOpen.calls().length, 1);
  });
});
