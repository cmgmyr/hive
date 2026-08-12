import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

// Step 1 of the dashboard lane (todo 308): renderDashboard() is pure - no
// tmux, no filesystem, no scheduler - so this file needs neither isolateTmux
// (nothing here can reach a tmux server; see test/suite-isolation.test.mjs's
// own REACHES_TMUX list) nor a spawned process per case. One store, imported
// once, reused across every test in this file.
//
// Step 2 (todo 309) added tick() itself, which CAN reach tmux - but only
// when it has a due timer to deliver. Every test below that calls tick()
// seeds zero timers and always passes tick(null) explicitly ("liveness is
// unknown, do not ask" - src/scheduler.ts's own comment on tick's snapshot
// parameter), never bare tick(), so no test in this file ever forks a real
// tmux process. Keep both of those true for any test added here later, or
// this file needs isolateTmux() after all.

clearHiveEnv();
process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
await assertScratchStore();

// Forced rather than left to whatever the runner's default is (CI images are
// typically UTC, which would make a local-vs-UTC bucketing bug invisible: on
// a UTC box, local IS UTC, so a broken implementation and a correct one
// would agree on every day boundary). America/New_York is UTC-4/-5, matching
// Chris's own report of the bug ("this box is UTC-4"), and a non-zero offset
// is what lets the boundary test below actually distinguish correct from
// broken. Measured directly, not assumed: mutating process.env.TZ
// mid-process changes what better-sqlite3's own 'localtime' modifier reports
// on the very next query, so setting it here (before the dist modules below
// ever touch the database) is sufficient - no need to set it in the shell.
// node:test isolates each file into its own process, so this cannot leak
// into any other test file.
process.env.TZ = "America/New_York";

const { db, migrate } = await import("../dist/db.js");
const {
  renderDashboard,
  TODO_CAP,
  AGENT_CAP,
  WAKE_CAP,
  ACTIVITY_SOURCE_LIMIT,
  ACTIVITY_DISPLAY_CAP,
  fetchDayStats,
  CHART_DAYS,
} = await import("../dist/dashboard.js");
const { tick } = await import("../dist/scheduler.js");
migrate();

// The exact UTC instant that corresponds to a given LOCAL calendar day, N
// days before today, at a given local time of day. Computed entirely inside
// SQLite (the 'localtime'/'utc' modifiers), never via JS Date arithmetic, so
// the day boundary a fixture is seeded against and the day boundary the code
// under test computes both come from the identical clock - see
// fetchDayStats's own comment in src/dashboard.ts for why that matters.
function localDayOffsetUtc(daysAgo, localTime = "12:00:00") {
  return db
    .prepare(`SELECT datetime(date('now', 'localtime', '-${daysAgo} day') || ' ${localTime}', 'utc') AS ts`)
    .get().ts;
}

// A minimal fake-DOM harness for the Live toggle's client-side SCRIPT. This
// file has no real browser, so extracting the script's source text and
// asserting on its STRING CONTENT (as the section-persistence tests below
// already do, e.g. "the script must select details[id]") proves the code is
// present, never that it BEHAVES correctly - not enough for something this
// stateful (a toggle whose whole job is arming/disarming a timer based on
// stored state). This harness instead EXECUTES the real, extracted script
// against fake document/window/sessionStorage/setTimeout objects and
// observes real outcomes: was a timer armed, what got persisted, what the
// checkbox and stamp end up showing. Deliberately narrow - it does not
// simulate <details> elements at all (document.querySelectorAll returns an
// empty array), because the details-restore behavior is already covered
// elsewhere and this harness exists specifically for the toggle.
function extractScript(html) {
  const start = html.indexOf("<script>") + "<script>".length;
  const end = html.indexOf("</script>");
  return html.slice(start, end);
}

function makeFakeToggleEnv(storedState) {
  const sessionData = {};
  if (storedState !== undefined) sessionData["hive-dashboard-state"] = JSON.stringify(storedState);

  const checkbox = {
    checked: false,
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
  };
  const stampEl = {
    textContent: "",
    getAttribute: () => "2026-08-07 20:34:36",
  };
  const elementsById = { "live-toggle": checkbox, "generated-stamp": stampEl };

  let armedCount = 0;
  let clearedCount = 0;
  let reloaded = false;

  const env = {
    checkbox,
    stampEl,
    getArmedCount: () => armedCount,
    getClearedCount: () => clearedCount,
    getReloaded: () => reloaded,
    getSessionData: () => sessionData,
  };

  env.fakeDocument = {
    querySelectorAll: () => [],
    getElementById: (id) => elementsById[id] || null,
  };
  env.fakeWindow = {
    scrollY: 0,
    scrollTo() {},
    addEventListener() {},
  };
  env.fakeSessionStorage = {
    getItem: (k) => (k in sessionData ? sessionData[k] : null),
    setItem: (k, v) => {
      sessionData[k] = v;
    },
  };
  env.fakeLocation = {
    reload: () => {
      reloaded = true;
    },
  };
  env.fakeSetTimeout = () => {
    armedCount++;
    return armedCount; // any truthy, distinct id is fine - never awaited for real
  };
  env.fakeClearTimeout = () => {
    clearedCount++;
  };

  return env;
}

// Runs the REAL extracted script text (not a reimplementation) with the
// browser globals it references shadowed by the fakes above - a standard
// sandboxing technique: `new Function` parameters shadow the identically-
// named ambient globals for everything inside the function body.
function runToggleScript(scriptSrc, env) {
  const fn = new Function(
    "document",
    "window",
    "sessionStorage",
    "location",
    "setTimeout",
    "clearTimeout",
    scriptSrc,
  );
  fn(env.fakeDocument, env.fakeWindow, env.fakeSessionStorage, env.fakeLocation, env.fakeSetTimeout, env.fakeClearTimeout);
}

let projectCount = 0;
function seedProject(name) {
  return db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get(name, `/scratch/${name}-${projectCount++}`).id;
}

function seedPad(projectId, name, content) {
  db.prepare("INSERT INTO scratchpads (project_id, name, content) VALUES (?, ?, ?)").run(
    projectId,
    name,
    content,
  );
}

function seedTodo(projectId, { title, priority = "medium", status = "open" }) {
  return db
    .prepare("INSERT INTO todos (project_id, title, priority, status) VALUES (?, ?, ?, ?) RETURNING id")
    .get(projectId, title, priority, status).id;
}

function blockOn(todoId, blockerId) {
  db.prepare("INSERT INTO todo_blockers (todo_id, blocker_id) VALUES (?, ?)").run(todoId, blockerId);
}

// awaitingFirstPrompt stamps agents.resumed_at, which src/firstPrompt.ts reads
// as "started, and not yet given anything" - what launchAgent writes at every
// spawn and resumeAgent at every resume, cleared by the worker's first real
// prompt. Seeded rather than driven here because renderDashboard is a pure
// reader; the end-to-end path through a real spawn and real hooks is
// test/spawn-false-finish.test.mjs's.
function seedAgent(projectId, { name, actorId, agentState = "unknown", kind = "agent", awaitingFirstPrompt = false }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, status, agent_state, kind, resumed_at)
       VALUES (?, ?, ?, 'claude', '/scratch', 'running', ?, ?, ?) RETURNING id`,
    )
    .get(projectId, actorId, name, agentState, kind, awaitingFirstPrompt ? "2026-08-12 03:49:23" : "").id;
}

function seedWake(projectId, { body, dueInSeconds, kind = "delay", maxWaitInSeconds }) {
  const dueAt = dueInSeconds != null ? `datetime('now', '+${dueInSeconds} seconds')` : "NULL";
  const maxWaitAt = maxWaitInSeconds != null ? `datetime('now', '+${maxWaitInSeconds} seconds')` : "NULL";
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, max_wait_at)
       VALUES (?, 'user:test', ?, ?, 'user:test', '%1', ${dueAt}, ${maxWaitAt}) RETURNING id, due_at, max_wait_at`,
    )
    .get(projectId, body, kind);
}

// UTC -> the same local formatting renderDashboard uses, computed
// independently (not by re-reading dashboard.ts's own function) so this is a
// real check of the derived value, not a tautology.
function expectedLocal(utc) {
  const d = new Date(`${utc.replace(" ", "T")}Z`);
  const p2 = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

describe("renderDashboard: board section", () => {
  it("renders the board pad's content in full, in a <pre>, unreflowed", () => {
    const project = seedProject("board-test");
    const content = ">>> section one\n    indented line carrying meaning\n>>> section two";
    seedPad(project, "board", content);
    const html = renderDashboard(project);
    // Escaped, not raw: ">" becomes "&gt;" so the pad's own markup can never
    // be mistaken for the dashboard's, but a browser renders the escaped form
    // right back to ">>>" visually, so this is the content surviving, not it
    // being altered.
    assert.ok(html.includes("&gt;&gt;&gt; section one"), "leading >>> must survive (escaped)");
    assert.ok(html.includes("    indented line carrying meaning"), "indentation must survive verbatim");
    assert.ok(/<pre class="board">/.test(html), "board content must render inside a <pre>");
  });

  it("says plainly when the project has no board pad, instead of crashing or silently omitting the section", () => {
    const project = seedProject("no-board-test");
    const html = renderDashboard(project);
    assert.ok(html.includes('No pad named "board"'), "a missing board pad must be a stated fact on the page");
  });

  it("escapes HTML-significant characters in pad content so injected markup cannot render", () => {
    const project = seedProject("board-escape-test");
    seedPad(project, "board", '<script>alert(1)</script> & "quoted" \'text\'');
    const html = renderDashboard(project);
    assert.ok(!html.includes("<script>alert(1)</script>"), "a raw <script> tag from stored content must never appear unescaped");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the escaped form must be present instead");
  });
});

describe("renderDashboard: open todos", () => {
  it("renders queue order (priority, then id) and marks a blocked todo distinctly from a dispatchable one", () => {
    const project = seedProject("todos-test");
    const low = seedTodo(project, { title: "low priority task", priority: "low" });
    const high = seedTodo(project, { title: "high priority task", priority: "high" });
    const blockerId = seedTodo(project, { title: "the blocker itself", priority: "high" });
    const blocked = seedTodo(project, { title: "blocked task", priority: "high" });
    blockOn(blocked, blockerId);

    const html = renderDashboard(project);

    // Queue order: high-priority todos (blocker, blocked, high) all precede
    // the low-priority one, because priority sorts before id.
    const idxLow = html.indexOf("low priority task");
    const idxHigh = html.indexOf("high priority task");
    const idxBlocked = html.indexOf("blocked task");
    assert.ok(idxHigh < idxLow, "a high-priority todo must render before a low-priority one");
    assert.ok(idxBlocked < idxLow, "a high-priority blocked todo still outranks a low-priority open one");

    // Visual distinctness: a blocked todo carries hive doctor's own "warn"
    // status word (visual redesign - status badges reuse doctor's ok/warn/
    // FAIL vocabulary rather than invented badge words like the old
    // "BLOCKED"/"OPEN" pills) and names its blocker by id and title; a
    // dispatchable one reads "ok" instead.
    const blockedLi = html.slice(html.lastIndexOf("<li", idxBlocked), html.indexOf("</li>", idxBlocked) + 6);
    assert.ok(
      blockedLi.includes('<span class="status status-warn">warn</span> blocked'),
      "a blocked todo must carry the warn status word, not an invented badge",
    );
    assert.ok(blockedLi.includes(`#${blockerId}`), "the blocker's id must be named");
    assert.ok(blockedLi.includes("the blocker itself"), "the blocker's title must be named");

    const highLi = html.slice(html.lastIndexOf("<li", idxHigh), html.indexOf("</li>", idxHigh) + 6);
    assert.ok(
      highLi.includes('<span class="status status-ok">ok</span> open'),
      "a dispatchable todo must carry the ok status word, not warn",
    );
    assert.ok(!highLi.includes("status-warn"), "a dispatchable todo must not carry the warn status");
  });

  it("excludes completed and archived todos from the open list", () => {
    const project = seedProject("todos-exclude-test");
    seedTodo(project, { title: "done already", status: "completed" });
    const archived = seedTodo(project, { title: "archived task" });
    db.prepare("UPDATE todos SET archived_at = datetime('now') WHERE id = ?").run(archived);
    seedTodo(project, { title: "still open" });

    const html = renderDashboard(project);
    assert.ok(!html.includes("done already"), "a completed todo must not appear in the open list");
    assert.ok(!html.includes("archived task"), "an archived todo must not appear in the open list");
    assert.ok(html.includes("still open"));
  });

  it("caps the open-todos list and says so on the page - a fixture that stays under the cap could never fail this", () => {
    const project = seedProject("todos-cap-test");
    const total = TODO_CAP + 5;
    for (let i = 0; i < total; i++) seedTodo(project, { title: `cap task ${i}` });

    const html = renderDashboard(project);
    const rendered = (html.match(/class="todo /g) || []).length;
    assert.equal(rendered, TODO_CAP, "exactly TODO_CAP items must render, not the full set");
    assert.ok(
      html.includes(`Showing ${TODO_CAP} of ${total} open todos (capped)`),
      "the page must say it is capped, and by how much",
    );
  });
});

describe("renderDashboard: 7-day throughput chart (Chris's follow-up request)", () => {
  it("always returns exactly CHART_DAYS entries, so a day with no activity renders as a real zero, never a gap", () => {
    const project = seedProject("chart-empty-project");
    const stats = fetchDayStats(project);
    assert.equal(stats.length, CHART_DAYS);
    assert.ok(
      stats.every((s) => s.completed === 0 && s.backlog === 0),
      "an empty project's every day must read as a real zero",
    );
  });

  it("buckets a late-evening-local completion into ITS local day, never the UTC day it crosses into", () => {
    // 22:00 local yesterday. This file forces TZ=America/New_York (UTC-4/-5),
    // so 22:00 plus that offset always lands past midnight UTC - the exact
    // shape from the bug report ("work done after 20:00 local lands on the
    // next UTC day"). A UTC-day bucketing bug would count this as completed
    // TODAY; correct local-day bucketing counts it as completed YESTERDAY.
    const project = seedProject("chart-local-bucketing");
    const todoId = seedTodo(project, { title: "late finish" });
    db.prepare("UPDATE todos SET status = 'completed', completed_at = ? WHERE id = ?").run(
      localDayOffsetUtc(1, "22:00:00"),
      todoId,
    );
    const stats = fetchDayStats(project);
    const today = stats[stats.length - 1];
    const yesterday = stats[stats.length - 2];
    assert.equal(yesterday.completed, 1, "a 22:00-local completion must count toward YESTERDAY's local day");
    assert.equal(today.completed, 0, "and must not bleed into today's bucket via the UTC day it crosses into");
  });

  it("counts a todo in the backlog from its creation day through (not including) the day it completes", () => {
    const project = seedProject("chart-backlog-window");
    const todoId = seedTodo(project, { title: "spans several days" });
    db.prepare("UPDATE todos SET created_at = ? WHERE id = ?").run(localDayOffsetUtc(4, "09:00:00"), todoId);
    db.prepare("UPDATE todos SET status = 'completed', completed_at = ? WHERE id = ?").run(
      localDayOffsetUtc(1, "09:00:00"),
      todoId,
    );
    const stats = fetchDayStats(project);
    const byDaysAgo = (daysAgo) => stats[stats.length - 1 - daysAgo];
    assert.equal(byDaysAgo(4).backlog, 1, "present in the backlog on its own creation day");
    assert.equal(byDaysAgo(2).backlog, 1, "still in the backlog on a day it is open and uncompleted");
    assert.equal(byDaysAgo(1).backlog, 0, "not in the backlog on the day it completes (not STRICTLY after end of day)");
    assert.equal(byDaysAgo(0).backlog, 0, "and not today either, once completed");
  });

  it("excludes an archived todo from the backlog, even one otherwise open", () => {
    const project = seedProject("chart-backlog-archived");
    const todoId = seedTodo(project, { title: "archived, still technically open" });
    db.prepare("UPDATE todos SET created_at = ?, archived_at = datetime('now') WHERE id = ?").run(
      localDayOffsetUtc(2, "09:00:00"),
      todoId,
    );
    const stats = fetchDayStats(project);
    assert.ok(stats.every((s) => s.backlog === 0), "an archived todo must never count toward the backlog");
  });

  it("labels today's bar as partial, in both the axis label and the caption", () => {
    const project = seedProject("chart-today-partial");
    const html = renderDashboard(project);
    const today = fetchDayStats(project)[CHART_DAYS - 1].day;
    assert.ok(html.includes(`${today.slice(5)}*`), "today's x-axis label must carry the partial marker");
    assert.ok(html.includes("Today (*) is still in progress"), "the chart must say in words that today is partial");
  });

  it("sizes the y-axis to the real computed data, not a fixed scale", () => {
    const project = seedProject("chart-axis-scale");
    for (let i = 0; i < 12; i++) {
      const id = seedTodo(project, { title: `done ${i}` });
      db.prepare("UPDATE todos SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(id);
    }
    const html = renderDashboard(project);
    const stats = fetchDayStats(project);
    const maxValue = Math.max(1, ...stats.map((s) => s.completed), ...stats.map((s) => s.backlog));
    assert.ok(html.includes(`>${maxValue}</text>`), "the axis max label must reflect the real computed maximum");
  });

  it("renders as a hand-drawn inline <svg>, not an externally-sourced image", () => {
    const project = seedProject("chart-inline-svg");
    const html = renderDashboard(project);
    assert.ok(/<svg[^>]*class="chart"/.test(html));
    assert.ok(!/<img\b/i.test(html), "no <img> - the chart must be inline SVG, not a rendered/uploaded image");
  });
});

describe("renderDashboard: in flight agents", () => {
  it("shows a running agent's live state", () => {
    const project = seedProject("agents-test");
    seedAgent(project, { name: "impl-worker", actorId: "agent:1001", agentState: "working" });
    const html = renderDashboard(project);
    assert.ok(html.includes("impl-worker"));
    // Visual redesign: "working" now carries the "live" status word (hive's
    // own vocabulary for "currently running", the same accent a pending
    // wake gets) rather than a bespoke colored state badge.
    assert.ok(
      html.includes('<span class="status status-live">live</span> working'),
      "the agent's current state must be shown, carrying the live status word",
    );
  });

  it("renders no status badge for a lead row - it has no state channel - and shows its last log event instead", () => {
    // src/hook.ts's agent_state UPDATE is scoped WHERE kind = 'agent', so a
    // lead's agent_state reads 'unknown' forever by design. Chris, looking
    // at a real render: that "unknown" reads as broken. It is not, and this
    // pins the fix: no badge at all for a non-'agent' kind, the real last
    // agent_state_log event in its place.
    const project = seedProject("lead-no-state-channel-test");
    seedAgent(project, { name: "lead-88", actorId: "lead:88", agentState: "unknown", kind: "lead" });
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES ('lead:88', 'prompt', 'unknown', strftime('%Y-%m-%d %H:%M:%f', 'now'))",
    ).run();
    const html = renderDashboard(project);
    const agentsSection = html.slice(html.indexOf('id="section-agents"'), html.indexOf('id="section-wakes"'));
    assert.ok(agentsSection.includes("lead-88"));
    assert.ok(!/class="status status-\w+"/.test(agentsSection), "a lead row must carry no status badge at all");
    assert.ok(
      agentsSection.includes("last event: prompt,"),
      "a lead row must show its real last log event instead of a fabricated status",
    );
  });

  it("shows 'no log event recorded' for a lead row with no agent_state_log rows at all, rather than nothing", () => {
    const project = seedProject("lead-no-log-test");
    seedAgent(project, { name: "fresh-lead", actorId: "lead:fresh", kind: "lead" });
    const html = renderDashboard(project);
    assert.ok(html.includes("no log event recorded"));
  });

  it("still shows the ok/warn/live status badge for an ordinary kind='agent' row - the state channel is real for it", () => {
    const project = seedProject("agent-still-has-channel-test");
    seedAgent(project, { name: "impl-worker", actorId: "agent:channel-1", agentState: "idle", kind: "agent" });
    const html = renderDashboard(project);
    assert.ok(html.includes('<span class="status status-ok">ok</span> idle'));
  });

  it("a worker that has been given nothing yet is not a green idle - and BOTH badges say so (todos 366, 373)", () => {
    // Todo 366's finding, widened by todo 373. An idle latch means "a turn
    // ended", and a spawned worker's first turn is hive's own announcement
    // while a resumed worker's is the restore replay - neither is work anybody
    // asked for. The wake path was the one that could get a worker torn down,
    // which is why 366 is low; the page saying a worker finished when it has
    // been given nothing is the same misreading with a smaller blast radius.
    //
    // TWO SITES IN ONE FILE, and that is the whole reason this asserts a
    // count. src/dashboard.ts badges a running agent in the NOW strip and
    // again in the In Flight list, so a fix applied to the site a reader
    // happened to open passes an `includes` and fails this
    // (common-issues/a-fix-applied-to-only-some-call-sites.md). The NOW strip
    // caps at NOW_AGENTS_SHOWN, so this project seeds exactly one agent.
    const project = seedProject("agent-awaiting-first-prompt-test");
    seedAgent(project, {
      name: "unassigned-worker",
      actorId: "agent:awaiting-1",
      agentState: "idle",
      awaitingFirstPrompt: true,
    });
    const html = renderDashboard(project);
    assert.equal(
      html.split("idle (no assignment yet)").length - 1,
      2,
      "the NOW strip and the In Flight list must both say it",
    );
    assert.ok(
      !html.includes('<span class="status status-ok">ok</span> idle'),
      "nothing on the page may still render this worker as a plain pass",
    );
  });

  it("only the idle latch is rewritten - a worker awaiting its first prompt that is WORKING still reads working", () => {
    // The suppression is about one misreading, not about the row being
    // untrustworthy: a fresh worker mid-turn really is working, and a badge
    // that hedged about that would be inventing a second fact.
    const project = seedProject("agent-awaiting-but-working-test");
    seedAgent(project, {
      name: "busy-fresh-worker",
      actorId: "agent:awaiting-2",
      agentState: "working",
      awaitingFirstPrompt: true,
    });
    const html = renderDashboard(project);
    assert.ok(html.includes('<span class="status status-live">live</span> working'));
    assert.ok(!html.includes("no assignment yet"));
  });

  it("excludes closed agents", () => {
    const project = seedProject("agents-closed-test");
    const id = seedAgent(project, { name: "closed-worker", actorId: "agent:1002" });
    db.prepare("UPDATE agents SET status = 'closed' WHERE id = ?").run(id);
    const html = renderDashboard(project);
    assert.ok(!html.includes("closed-worker"), "a closed agent must not appear as in-flight");
  });

  it("caps the in-flight list and says so", () => {
    const project = seedProject("agents-cap-test");
    const total = AGENT_CAP + 3;
    for (let i = 0; i < total; i++) {
      seedAgent(project, { name: `cap-worker-${i}`, actorId: `agent:cap-${i}` });
    }
    const html = renderDashboard(project);
    const rendered = (html.match(/class="agent">/g) || []).length;
    assert.equal(rendered, AGENT_CAP);
    assert.ok(html.includes(`Showing ${AGENT_CAP} of ${total} running agents (capped)`));
  });
});

describe("renderDashboard: pending wakes", () => {
  it("renders a wake's fire time in local time, matching an independent conversion of its stored UTC row", () => {
    const project = seedProject("wakes-test");
    const { due_at } = seedWake(project, { body: "check on the deploy", dueInSeconds: 3600 });
    const html = renderDashboard(project);
    assert.ok(html.includes("check on the deploy"));
    assert.ok(
      html.includes(expectedLocal(due_at)),
      `expected the local rendering of ${due_at} (${expectedLocal(due_at)}) to appear`,
    );
    assert.ok(html.includes(`title="${due_at} UTC"`), "the raw UTC value must still be present, labelled as UTC");
  });

  it("renders an idle-mode wake's max_wait_at rather than a due_at it does not have", () => {
    const project = seedProject("wakes-idle-test");
    const { max_wait_at } = seedWake(project, {
      body: "resume once idle",
      kind: "idle_any",
      maxWaitInSeconds: 900,
    });
    const html = renderDashboard(project);
    assert.ok(html.includes("resume once idle"));
    assert.ok(html.includes(expectedLocal(max_wait_at)));
    assert.ok(html.includes("fires when watched agents go idle"));
  });

  it("excludes a wake that already fired and is not repeating", () => {
    const project = seedProject("wakes-fired-test");
    const { id } = seedWake(project, { body: "already delivered", dueInSeconds: -60 });
    db.prepare("UPDATE timers SET fired_at = datetime('now') WHERE id = ?").run(id);
    const html = renderDashboard(project);
    assert.ok(!html.includes("already delivered"), "a fired one-shot wake must not appear as pending");
  });

  it("caps the pending-wakes list and says so", () => {
    const project = seedProject("wakes-cap-test");
    const total = WAKE_CAP + 4;
    for (let i = 0; i < total; i++) seedWake(project, { body: `cap wake ${i}`, dueInSeconds: 60 + i });
    const html = renderDashboard(project);
    const rendered = (html.match(/class="wake">/g) || []).length;
    assert.equal(rendered, WAKE_CAP);
    assert.ok(html.includes(`Showing ${WAKE_CAP} of ${total} pending wakes (capped)`));
  });
});

describe("renderDashboard: recent activity", () => {
  it("merges todo comments and agent_state_log transitions, newest first", () => {
    const project = seedProject("activity-test");
    const todo = seedTodo(project, { title: "activity todo" });
    db.prepare("INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'user:test', 'older comment', datetime('now', '-30 seconds'))").run(todo);
    seedAgent(project, { name: "activity-worker", actorId: "agent:activity-1" });
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES ('agent:activity-1', 'stop', 'idle', strftime('%Y-%m-%d %H:%M:%f', 'now'))",
    ).run();

    const html = renderDashboard(project);
    assert.ok(html.includes("older comment"));
    assert.ok(html.includes("activity-worker"));
    assert.ok(html.includes("activity-worker → idle"));
    const idxState = html.indexOf("activity-worker");
    const idxComment = html.indexOf("older comment");
    assert.ok(idxState < idxComment, "the newer state-log row must render before the older comment");
  });

  it("scopes agent_state_log to the requesting project via the agent's own actor_id, not another project's", () => {
    const projectA = seedProject("activity-scope-a");
    const projectB = seedProject("activity-scope-b");
    seedAgent(projectB, { name: "b-worker", actorId: "agent:scope-b" });
    db.prepare(
      "INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES ('agent:scope-b', 'stop', 'idle', strftime('%Y-%m-%d %H:%M:%f', 'now'))",
    ).run();

    const htmlA = renderDashboard(projectA);
    assert.ok(!htmlA.includes("b-worker"), "project A's dashboard must not show project B's agent activity");
  });

  it("caps one noisy source at ACTIVITY_SOURCE_LIMIT, but still reports that source's TRUE total in the cap note", () => {
    // A comment-only project whose comment count alone exceeds
    // ACTIVITY_SOURCE_LIMIT. If the cap note reported merged.length (the
    // post-truncation count) rather than a real COUNT(*), this would read
    // "Showing 30 of 30" instead of naming the 5 comments actually dropped -
    // the two-stage version of the silent-cap defect PR #44 nearly shipped.
    const project = seedProject("activity-source-cap-test");
    const todo = seedTodo(project, { title: "cap activity todo" });
    const commentTotal = ACTIVITY_SOURCE_LIMIT + 5;
    for (let i = 0; i < commentTotal; i++) {
      db.prepare(
        "INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'user:test', ?, datetime('now', ? || ' seconds'))",
      ).run(todo, `comment ${i}`, `-${i}`);
    }
    const html = renderDashboard(project);
    const rendered = (html.match(/class="activity">/g) || []).length;
    assert.equal(rendered, ACTIVITY_SOURCE_LIMIT, "only what the source query fetched can render");
    assert.ok(
      html.includes(`Showing ${ACTIVITY_SOURCE_LIMIT} of ${commentTotal} recent activity entries (capped)`),
      "the note must name the TRUE total, not the truncated fetch count",
    );
  });

  it("caps the merged list at ACTIVITY_DISPLAY_CAP when neither source alone was truncated", () => {
    // Both sources individually stay under ACTIVITY_SOURCE_LIMIT, so nothing
    // is lost before the merge; the merge itself is what exceeds
    // ACTIVITY_DISPLAY_CAP. This isolates the second cap from the first -
    // the source-limit test above cannot exercise this path, since one
    // source alone can never fetch past ACTIVITY_SOURCE_LIMIT.
    const project = seedProject("activity-display-cap-test");
    const todo = seedTodo(project, { title: "display cap todo" });
    const commentTotal = ACTIVITY_SOURCE_LIMIT - 10;
    for (let i = 0; i < commentTotal; i++) {
      db.prepare(
        "INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'user:test', ?, datetime('now', ? || ' seconds'))",
      ).run(todo, `comment ${i}`, `-${i}`);
    }
    const stateLogTotal = ACTIVITY_SOURCE_LIMIT - 5;
    seedAgent(project, { name: "display-cap-worker", actorId: "agent:display-cap" });
    for (let i = 0; i < stateLogTotal; i++) {
      db.prepare(
        "INSERT INTO agent_state_log (actor_id, event, state, created_at) VALUES ('agent:display-cap', 'stop', 'idle', strftime('%Y-%m-%d %H:%M:%f', datetime('now', ? || ' seconds')))",
      ).run(`-${i}`);
    }
    const total = commentTotal + stateLogTotal;
    assert.ok(total > ACTIVITY_DISPLAY_CAP, "precondition: the combined total must exceed the display cap");
    assert.ok(
      commentTotal <= ACTIVITY_SOURCE_LIMIT && stateLogTotal <= ACTIVITY_SOURCE_LIMIT,
      "precondition: neither source alone may hit its own limit, or this stops isolating the display cap",
    );

    const html = renderDashboard(project);
    const rendered = (html.match(/class="activity">/g) || []).length;
    assert.equal(rendered, ACTIVITY_DISPLAY_CAP);
    assert.ok(html.includes(`Showing ${ACTIVITY_DISPLAY_CAP} of ${total} recent activity entries (capped)`));
  });
});

describe("renderDashboard: pads section (Chris's follow-up request)", () => {
  it("lists an active pad other than board, collapsed by default, with revision/updated/size in the summary", () => {
    const project = seedProject("pads-list-test");
    seedPad(project, "lessons", "some lessons content");
    const html = renderDashboard(project);
    assert.ok(
      html.includes('<details class="pad-item" id="pad-lessons">'),
      "a pad's own <details> must carry no open attribute - collapsed by default",
    );
    assert.ok(html.includes("lessons"));
    assert.ok(html.includes("rev 1"));
    assert.ok(html.includes("some lessons content"), "expanding must show the full content in a <pre>");
  });

  it("excludes the board pad's content, and says in one line that it is shown above", () => {
    const project = seedProject("pads-excludes-board-test");
    seedPad(project, "board", "UNIQUEBOARDMARKER content");
    const html = renderDashboard(project);
    const padsSection = html.slice(html.indexOf('id="section-pads"'));
    assert.ok(
      !padsSection.includes("UNIQUEBOARDMARKER"),
      "board's content must not be inlined a second time in the pads section",
    );
    assert.ok(padsSection.includes('other than "board"'), 'must say in one line that board is shown above');
  });

  it("excludes an archived pad entirely", () => {
    const project = seedProject("pads-excludes-archived-test");
    seedPad(project, "archived-one", "should never appear");
    db.prepare("UPDATE scratchpads SET archived = 1 WHERE project_id = ? AND name = 'archived-one'").run(project);
    const html = renderDashboard(project);
    assert.ok(!html.includes("should never appear"), "an archived pad must not be inlined");
  });

  it("shows a real byte size derived from the pad's own content, not a placeholder", () => {
    const project = seedProject("pads-size-test");
    seedPad(project, "sized", "x".repeat(2000));
    const html = renderDashboard(project);
    assert.ok(html.includes("2.0 KB"), "size must reflect the pad's real content length");
  });

  it("says plainly when there are no other active pads", () => {
    const project = seedProject("pads-empty-test");
    const html = renderDashboard(project);
    assert.ok(html.includes("No other active pads."));
  });
});

describe("renderDashboard: project scoping", () => {
  it("never mixes one project's todos into another project's rendering", () => {
    const projectA = seedProject("scope-a");
    const projectB = seedProject("scope-b");
    seedTodo(projectA, { title: "belongs to A only" });
    seedTodo(projectB, { title: "belongs to B only" });

    const htmlA = renderDashboard(projectA);
    assert.ok(htmlA.includes("belongs to A only"));
    assert.ok(!htmlA.includes("belongs to B only"), "project A's page must never show project B's todo");
  });
});

describe("renderDashboard: the NOW strip is the only thing expanded by default (visual redesign)", () => {
  // Superseded by the visual redesign: the earlier round made only the
  // board default collapsed, with every other section still defaulting
  // open. Chris's follow-up ("it's a lot of info on screen even when pads
  // are collapsed") moved the bar - now EVERY <details> section defaults
  // collapsed, full stop, and the NOW strip (not a <details> at all, no
  // toggle) is the sole thing a fresh session sees expanded. This test
  // replaces the old one rather than extending it: the old assertion that
  // "todos still defaults open" pinned exactly the behavior this round
  // deliberately changed.
  it("every <details class=\"section\"> carries no open attribute - board included, but no longer board alone", () => {
    const project = seedProject("all-sections-collapsed-test");
    seedPad(project, "board", "board content");
    seedTodo(project, { title: "an open todo" });
    const html = renderDashboard(project);
    for (const id of ["board", "todos", "throughput", "agents", "wakes", "activity", "pads"]) {
      assert.ok(
        html.includes(`<details class="section" id="section-${id}">`),
        `section-${id} must default collapsed - no open attribute in the markup a fresh session first sees`,
      );
      assert.ok(
        !html.includes(`<details class="section" id="section-${id}" open>`),
        `section-${id} must not default open`,
      );
    }
  });

  it("the NOW strip itself is not a <details> and carries no collapse state - it is always visible", () => {
    const project = seedProject("now-strip-always-visible-test");
    const html = renderDashboard(project);
    assert.ok(/<section class="now"/.test(html), "the NOW strip must be a plain, non-collapsible element");
    const nowIdx = html.indexOf('<section class="now"');
    const nowEnd = html.indexOf("</section>", nowIdx);
    const nowBlock = html.slice(nowIdx, nowEnd);
    assert.ok(!nowBlock.includes("<details"), "the NOW strip must contain no nested <details> of its own");
  });

  it("the NOW strip answers workers/next wake/todos/trend in under four lines, before any section is expanded", () => {
    const project = seedProject("now-strip-content-test");
    seedAgent(project, { name: "now-worker", actorId: "agent:now-1", agentState: "working" });
    seedWake(project, { body: "check the deploy", dueInSeconds: 3600 });
    seedTodo(project, { title: "a now-strip todo" });
    const html = renderDashboard(project);
    const nowBlock = html.slice(html.indexOf('<section class="now"'), html.indexOf("</section>") + "</section>".length);
    assert.ok(nowBlock.includes("now-worker"), "workers running must be visible in the strip");
    assert.ok(!nowBlock.includes("check the deploy"), "the strip states counts and times, not full wake bodies");
    assert.ok(/workers/.test(nowBlock) && /next wake/.test(nowBlock) && /todos/.test(nowBlock) && /trend/.test(nowBlock));
  });

  it("says plainly when nothing is running or scheduled, rather than an empty line", () => {
    const project = seedProject("now-strip-empty-test");
    const html = renderDashboard(project);
    const nowBlock = html.slice(html.indexOf('<section class="now"'), html.indexOf("</section>") + "</section>".length);
    assert.ok(nowBlock.includes("no workers running"));
    assert.ok(nowBlock.includes("nothing scheduled"));
  });

  it("the NOW strip's compact worker line shows a lead by name only, no status badge and no last-event sentence", () => {
    // The one-line NOW strip has no room for "last event: ... local" without
    // defeating its own 3-second-scan purpose - that detail lives in the In
    // Flight section below. Here a lead is silent about status rather than
    // fabricating one.
    const project = seedProject("now-strip-lead-test");
    seedAgent(project, { name: "lead-88", actorId: "lead:88", agentState: "unknown", kind: "lead" });
    const html = renderDashboard(project);
    const nowBlock = html.slice(html.indexOf('<section class="now"'), html.indexOf("</section>") + "</section>".length);
    assert.ok(nowBlock.includes("lead-88"));
    assert.ok(!/class="status status-\w+"/.test(nowBlock), "the NOW strip must show no status badge for a lead");
  });

  it("the persistence script covers every details[id], not just top-level sections, so a stored preference - board included - always wins over this default", () => {
    const project = seedProject("script-selector-test");
    const html = renderDashboard(project);
    assert.ok(
      html.includes('querySelectorAll("details[id]")'),
      "the script must select by id generically, or a reader's stored board preference (or a pad's) would never be restored",
    );
  });
});

describe("renderDashboard: escaping is pinned at every sink, not the board pad alone (counselors, finding 4)", () => {
  // Before this block, test/dashboard.test.mjs's ONLY escaping assertion
  // covered renderBoardSection alone - dropping escapeHtml from a todo
  // title, a blocker title, an agent name, a wake body, an activity
  // comment's author/body/todo_title, or the project name left the whole
  // suite green. Each test below was run against dashboard.ts with that
  // sink's escapeHtml call removed and confirmed to fail red before being
  // restored, per .claude/sessions/workflows/verify-a-test-goes-red-first.md.
  const XSS = "<script>alert(1)</script>";
  const XSS_ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

  it("escapes a todo's own title", () => {
    const project = seedProject("escape-todo-title");
    seedTodo(project, { title: XSS });
    const html = renderDashboard(project);
    assert.ok(!html.includes(XSS), "a raw <script> in a todo title must never appear unescaped");
    assert.ok(html.includes(XSS_ESCAPED));
  });

  it("escapes a blocker's title, shown inline on the todo it blocks", () => {
    const project = seedProject("escape-blocker-title");
    const blocker = seedTodo(project, { title: XSS });
    const blocked = seedTodo(project, { title: "normal task" });
    blockOn(blocked, blocker);
    const html = renderDashboard(project);
    assert.ok(!html.includes(XSS), "a raw <script> in a blocker's title must never appear unescaped");
    assert.ok(html.includes(XSS_ESCAPED));
  });

  it("escapes an agent's name", () => {
    const project = seedProject("escape-agent-name");
    seedAgent(project, { name: XSS, actorId: "agent:escape-name" });
    const html = renderDashboard(project);
    assert.ok(!html.includes(XSS), "a raw <script> in an agent name must never appear unescaped");
    assert.ok(html.includes(XSS_ESCAPED));
  });

  it("escapes a wake's body", () => {
    const project = seedProject("escape-wake-body");
    seedWake(project, { body: XSS, dueInSeconds: 60 });
    const html = renderDashboard(project);
    assert.ok(!html.includes(XSS), "a raw <script> in a wake body must never appear unescaped");
    assert.ok(html.includes(XSS_ESCAPED));
  });

  it("truncates a wake body whole, THEN escapes it - never the reverse, which would slice an entity in half", () => {
    const project = seedProject("escape-wake-truncate-order");
    const raw = "x".repeat(158) + "&" + "y".repeat(50); // longer than the 160-char cap, "&" straddles it
    seedWake(project, { body: raw, dueInSeconds: 60 });
    const html = renderDashboard(project);
    const correctOrder = (raw.slice(0, 160) + "…").replace(/&/g, "&amp;");
    const wrongOrder = raw.replace(/&/g, "&amp;").slice(0, 160) + "…";
    assert.ok(html.includes(correctOrder), "truncate-then-escape must produce a whole, unbroken entity");
    assert.ok(!html.includes(wrongOrder), "escape-then-truncate would have sliced &amp; in half");
  });

  it("escapes a comment's author and body, and the todo title it names, in recent activity", () => {
    const project = seedProject("escape-activity");
    const todo = seedTodo(project, { title: XSS });
    db.prepare(
      "INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, ?, ?, datetime('now'))",
    ).run(todo, XSS, XSS);
    const html = renderDashboard(project);
    assert.ok(
      !html.includes(XSS),
      "raw <script> in a comment's author, body, or the todo title it names must never appear unescaped",
    );
    // The todo's own title is ALSO escaped once more in the Open Todos
    // section above (already pinned by its own test), so counting over the
    // WHOLE page would overcount by one. Activity is the last section
    // rendered, so slicing from its id to the end isolates it.
    const activityHtml = html.slice(html.indexOf('id="section-activity"'));
    assert.equal(
      (activityHtml.match(new RegExp(XSS_ESCAPED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length,
      3,
      "author, body, and todo title must each be escaped independently within the activity section",
    );
  });

  it("truncates a comment body whole, THEN escapes it - never the reverse", () => {
    const project = seedProject("escape-comment-truncate-order");
    const todo = seedTodo(project, { title: "truncate order todo" });
    const raw = "x".repeat(198) + "&" + "y".repeat(50); // longer than the 200-char cap, "&" straddles it
    db.prepare(
      "INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'user:test', ?, datetime('now'))",
    ).run(todo, raw);
    const html = renderDashboard(project);
    const correctOrder = (raw.slice(0, 200) + "…").replace(/&/g, "&amp;");
    const wrongOrder = raw.replace(/&/g, "&amp;").slice(0, 200) + "…";
    assert.ok(html.includes(correctOrder), "truncate-then-escape must produce a whole, unbroken entity");
    assert.ok(!html.includes(wrongOrder), "escape-then-truncate would have sliced &amp; in half");
  });

  it("escapes the project's own name, in both the <title> and the <h1>", () => {
    const project = seedProject(XSS);
    const html = renderDashboard(project);
    assert.ok(!html.includes(XSS), "a raw <script> in the project name must never appear unescaped");
    assert.equal((html.match(/hive dashboard - &lt;script&gt;alert\(1\)&lt;\/script&gt;/g) || []).length, 2);
  });
});

describe("renderDashboard: self-contained and read-only", () => {
  it("has no external CDN, font, or script references, no form, and no data-entry input", () => {
    const project = seedProject("selfcontained-test");
    seedPad(project, "board", "board content");
    const html = renderDashboard(project);
    assert.ok(!/https?:\/\//.test(html), "no external URL of any kind may appear");
    assert.ok(!/<link\b/.test(html), "no external stylesheet or font link");
    assert.ok(!/<script[^>]+src=/.test(html), "no externally-sourced script");
    assert.ok(!/<form\b/i.test(html), "the dashboard is read-only: no forms");
    // The Live toggle (checkbox, see the live-toggle describe block below)
    // is the one deliberate exception: read-only means nothing here writes
    // back to the STORE, and a display preference kept in sessionStorage
    // never does. So the bar narrows from "no <input> at all" to "no
    // data-entry <input> - every <input> present must be the toggle
    // checkbox and nothing else".
    const inputs = [...html.matchAll(/<input\b[^>]*>/gi)];
    assert.equal(inputs.length, 1, "exactly one <input> may appear: the Live toggle");
    assert.match(inputs[0][0], /type="checkbox"/, "the one permitted input must be a checkbox, not data-entry");
    assert.match(inputs[0][0], /id="live-toggle"/);
  });

  it("carries no <meta http-equiv=\"refresh\"> tag - superseded by SCRIPT's own clearable timer", () => {
    // meta refresh is scheduled by the browser at PARSE TIME; removing the
    // tag after the fact does not cancel it, which is exactly why the Live
    // toggle could not have been built on top of it. Checked as the exact
    // literal tag, not a loose regex: SCRIPT's own comment mentions
    // "<meta http-equiv=\"refresh\">" by name (explaining what it replaced),
    // and that comment text is itself embedded verbatim inside the page's
    // <script> block - a substring match on the tag name alone would false-
    // positive on prose, never on a real emitted tag.
    const project = seedProject("no-meta-refresh-test");
    const html = renderDashboard(project);
    assert.ok(!html.includes('<meta http-equiv="refresh" content="10">'));
  });
});

describe("renderDashboard: the Live toggle (Chris's follow-up request)", () => {
  it("the checkbox carries `checked` by default in the server-rendered markup, for a reader with no JavaScript at all", () => {
    const project = seedProject("live-toggle-markup-default-test");
    const html = renderDashboard(project);
    assert.ok(html.includes('<input type="checkbox" id="live-toggle" role="switch" checked>'));
  });

  it("states plainly, near the toggle, that turning it off does not stop the scheduler", () => {
    const project = seedProject("live-toggle-note-test");
    const html = renderDashboard(project);
    assert.ok(
      html.includes("Turning Live off stops this page from reloading; the scheduler keeps the file itself up to date either way"),
    );
  });

  it("defaults Live ON with no stored preference, arming the reload timer", () => {
    const project = seedProject("live-toggle-default-on-behavior-test");
    const html = renderDashboard(project);
    const env = makeFakeToggleEnv(undefined); // fresh session, nothing in sessionStorage yet
    runToggleScript(extractScript(html), env);
    assert.equal(env.checkbox.checked, true, "the checkbox must read checked with no stored preference");
    assert.equal(env.getArmedCount(), 1, "the reload timer must be armed when Live is ON");
  });

  it("Live OFF (stored) arms no reload timer at all", () => {
    const project = seedProject("live-toggle-off-behavior-test");
    const html = renderDashboard(project);
    const env = makeFakeToggleEnv({ live: false });
    runToggleScript(extractScript(html), env);
    assert.equal(env.checkbox.checked, false);
    assert.equal(env.getArmedCount(), 0, "no timer may be armed when Live is OFF");
  });

  it("toggling the checkbox off persists the choice and clears the armed timer", () => {
    const project = seedProject("live-toggle-change-event-test");
    const html = renderDashboard(project);
    const env = makeFakeToggleEnv(undefined);
    runToggleScript(extractScript(html), env);
    assert.equal(env.getArmedCount(), 1, "precondition: ON by default, one timer armed already");

    env.checkbox.checked = false;
    env.checkbox.listeners.change();

    assert.equal(env.getClearedCount(), 1, "toggling off must clear the armed timer");
    const stored = JSON.parse(env.getSessionData()["hive-dashboard-state"]);
    assert.equal(stored.live, false, "the OFF choice must be persisted to sessionStorage, alongside scroll/section state");
  });

  it("OFF persists across a reload - a second script run picks up the first run's stored choice and stays off", () => {
    const project = seedProject("live-toggle-persist-across-reload-test");
    const html = renderDashboard(project);
    const scriptSrc = extractScript(html);

    const first = makeFakeToggleEnv(undefined);
    runToggleScript(scriptSrc, first);
    first.checkbox.checked = false;
    first.checkbox.listeners.change();
    const persisted = JSON.parse(first.getSessionData()["hive-dashboard-state"]);

    // A second, independent script execution reading the SAME sessionStorage
    // state - simulating exactly what a reload does.
    const second = makeFakeToggleEnv(persisted);
    runToggleScript(scriptSrc, second);

    assert.equal(second.checkbox.checked, false, "the reload must restore Live OFF from the prior run's stored state");
    assert.equal(second.getArmedCount(), 0, "the restored OFF state must not arm a timer either");
  });

  it("the generated-at stamp reads 'paused, generated ...' when OFF, and the normal refresh sentence when ON", () => {
    const project = seedProject("live-toggle-stamp-test");
    const html = renderDashboard(project);
    const scriptSrc = extractScript(html);

    const on = makeFakeToggleEnv(undefined);
    runToggleScript(scriptSrc, on);
    assert.ok(on.stampEl.textContent.startsWith("generated "));
    assert.ok(on.stampEl.textContent.includes("refreshes every 10s"));

    const off = makeFakeToggleEnv({ live: false });
    runToggleScript(scriptSrc, off);
    assert.ok(off.stampEl.textContent.startsWith("paused, generated "));
    assert.ok(!off.stampEl.textContent.includes("refreshes every 10s"));
  });

  it("carries a real focus-visible outline on the toggle, reusing the page's existing accent token", () => {
    const project = seedProject("live-toggle-focus-test");
    const html = renderDashboard(project);
    assert.ok(/\.live-toggle input\[type="checkbox"\]:focus-visible\s*{\s*outline:/.test(html));
  });
});

describe("renderDashboard: every collapsed section still says something, via a count in its summary", () => {
  // Chris's own framing: a closed section that tells you nothing is just a
  // wall of chrome. Each of these seeds real data and checks the count in
  // that section's OWN summary line (isolated the same way the pads-section
  // tests isolate their section, to avoid matching a number that happens to
  // appear elsewhere on the page).
  function summaryOf(html, sectionId) {
    const start = html.indexOf(`id="section-${sectionId}"`);
    assert.ok(start >= 0, `section-${sectionId} must exist`);
    const summaryStart = html.indexOf("<summary", start);
    const summaryEnd = html.indexOf("</summary>", summaryStart);
    return html.slice(summaryStart, summaryEnd);
  }

  it("todos: N open, N blocked", () => {
    const project = seedProject("count-todos-test");
    const blocker = seedTodo(project, { title: "blocker" });
    const blocked = seedTodo(project, { title: "blocked" });
    blockOn(blocked, blocker);
    seedTodo(project, { title: "a third open todo" });
    const html = renderDashboard(project);
    assert.ok(summaryOf(html, "todos").includes("3 open, 1 blocked"));
  });

  it("agents: N running", () => {
    const project = seedProject("count-agents-test");
    seedAgent(project, { name: "a", actorId: "agent:count-a" });
    seedAgent(project, { name: "b", actorId: "agent:count-b" });
    const html = renderDashboard(project);
    assert.ok(summaryOf(html, "agents").includes("2 running"));
  });

  it("wakes: N pending", () => {
    const project = seedProject("count-wakes-test");
    seedWake(project, { body: "one", dueInSeconds: 60 });
    seedWake(project, { body: "two", dueInSeconds: 120 });
    const html = renderDashboard(project);
    assert.ok(summaryOf(html, "wakes").includes("2 pending"));
  });

  it("activity: N recent", () => {
    const project = seedProject("count-activity-test");
    const todo = seedTodo(project, { title: "activity count todo" });
    db.prepare(
      "INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'user:test', 'a comment', datetime('now'))",
    ).run(todo);
    const html = renderDashboard(project);
    assert.ok(summaryOf(html, "activity").includes("1 recent"));
  });

  it("pads: N pads (board excluded from the count)", () => {
    const project = seedProject("count-pads-test");
    seedPad(project, "board", "excluded from this count");
    seedPad(project, "one", "content");
    seedPad(project, "two", "content");
    const html = renderDashboard(project);
    assert.ok(summaryOf(html, "pads").includes("2 pads"));
  });

  it("board: revision and local update time", () => {
    const project = seedProject("count-board-test");
    seedPad(project, "board", "content");
    const html = renderDashboard(project);
    assert.ok(summaryOf(html, "board").includes("rev 1"));
    assert.ok(summaryOf(html, "board").includes("updated"));
  });

  it("throughput: completed 7d and current backlog", () => {
    const project = seedProject("count-throughput-test");
    const id = seedTodo(project, { title: "done today" });
    db.prepare("UPDATE todos SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(id);
    seedTodo(project, { title: "still open" });
    const html = renderDashboard(project);
    const summary = summaryOf(html, "throughput");
    assert.ok(summary.includes("1 completed 7d"));
    assert.ok(summary.includes("1 backlog now"));
  });
});

describe("renderDashboard: wakes carry a live/warn status, matching held state", () => {
  it("an ordinary pending wake reads live", () => {
    const project = seedProject("wake-status-live-test");
    seedWake(project, { body: "ordinary wake", dueInSeconds: 60 });
    const html = renderDashboard(project);
    assert.ok(html.includes('<span class="status status-live">live</span> pending #'));
  });

  it("a held wake reads warn, not live", () => {
    const project = seedProject("wake-status-held-test");
    const { id } = seedWake(project, { body: "stuck wake", dueInSeconds: 60 });
    db.prepare("UPDATE timers SET held_at = datetime('now'), held_reason = 'test hold' WHERE id = ?").run(id);
    const html = renderDashboard(project);
    assert.ok(html.includes('<span class="status status-warn">warn</span> held #'));
    assert.ok(!html.includes('<span class="status status-live">live</span> pending #'));
  });
});

describe("renderDashboard: the type split - prose for human-written text, mono (the default) for data", () => {
  it("wraps a todo title in .prose but leaves the agent name and status word unwrapped (data)", () => {
    const project = seedProject("type-split-test");
    seedTodo(project, { title: "a human-written title" });
    seedAgent(project, { name: "identifier-worker", actorId: "agent:type-split", agentState: "idle" });
    const html = renderDashboard(project);
    assert.ok(html.includes('<span class="prose">a human-written title</span>'));
    assert.ok(
      !html.includes('<span class="prose">identifier-worker</span>'),
      "an agent name is an identifier, not prose - it must stay in the default mono font",
    );
  });

  it("wraps a wake body and a comment body in .prose", () => {
    const project = seedProject("type-split-wake-comment-test");
    seedWake(project, { body: "a human-written wake body", dueInSeconds: 60 });
    const todo = seedTodo(project, { title: "commented todo" });
    db.prepare(
      "INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, 'user:test', 'a human-written comment', datetime('now'))",
    ).run(todo);
    const html = renderDashboard(project);
    assert.ok(html.includes('<span class="prose">a human-written wake body</span>'));
    assert.ok(html.includes('<span class="prose">a human-written comment</span>'));
  });
});

describe("renderDashboard: color, motion and focus (visual redesign)", () => {
  it("defines a full light palette on :root and overrides it under prefers-color-scheme: dark, with an explicit body background", () => {
    const project = seedProject("color-tokens-test");
    const html = renderDashboard(project);
    assert.ok(/:root\s*{[^}]*--bg:/s.test(html), "light palette must be defined on :root");
    assert.ok(
      /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{[^}]*--bg:/s.test(html),
      "dark palette must override under prefers-color-scheme: dark",
    );
    assert.ok(/body\s*{[^}]*background:\s*var\(--bg\)/s.test(html), "body must set an explicit background");
  });

  it("maps status colors onto hive's own ok/warn/fail/live vocabulary, not an invented palette", () => {
    const project = seedProject("status-colors-test");
    const html = renderDashboard(project);
    for (const level of ["ok", "warn", "fail", "live"]) {
      assert.ok(html.includes(`--${level}:`), `token --${level} must be defined`);
      assert.ok(html.includes(`.status-${level}`), `a .status-${level} rule must exist`);
    }
  });

  it("respects prefers-reduced-motion", () => {
    const project = seedProject("reduced-motion-test");
    const html = renderDashboard(project);
    assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(html));
  });

  it("gives every <summary> a visible keyboard focus style", () => {
    const project = seedProject("focus-visible-test");
    const html = renderDashboard(project);
    assert.ok(/summary:focus-visible\s*{\s*outline:/.test(html));
  });
});

describe("renderDashboard: section headers render as tmux pane-border-status lines", () => {
  it("every top-level section summary carries the pane-border class and a trailing rule", () => {
    const project = seedProject("pane-border-test");
    const html = renderDashboard(project);
    assert.ok(html.includes('<summary class="pane-border">'));
    assert.ok(/summary\.pane-border::before\s*{\s*content:\s*"[^"]*─/.test(html), "the header rule must use a box-drawing dash, not invented chrome");
  });
});

// Step 2 (todo 309): the scheduler hook that writes renderDashboard()'s
// output to disk. seedProjectAt gives the project a REAL directory on disk -
// unlike seedProject's fake /scratch/... path above, which is fine for a
// pure renderDashboard() call but cannot hold a real hive.yml for the
// enable gate (setDashboardKey, below) or a real .claude/dashboard/.
function seedProjectAt(name) {
  const root = mkdtempSync(join(tmpdir(), `hive-dashboard-${name}-`));
  const id = db
    .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
    .get(name, root).id;
  return { id, root };
}

function indexPath(root) {
  return join(root, ".claude", "dashboard", "index.html");
}

// Chris's scope change (superseding plan-dashboard-v1's original directory
// switch): the enable gate is hive.yml's `dashboard` key, not the
// directory's own presence. Writes (or overwrites) hive.yml at the
// project's root with just this one key.
function setDashboardKey(root, value) {
  writeFileSync(join(root, "hive.yml"), `dashboard: ${value}\n`);
}

describe("the scheduler hook: enable gate is hive.yml's dashboard key (todo 309)", () => {
  it("writes nothing, and does not throw, when there is no hive.yml at all", async () => {
    const { id, root } = seedProjectAt("gate-no-yml");
    seedTodo(id, { title: "should not appear anywhere" });
    await assert.doesNotReject(() => tick(null));
    assert.ok(!statOrNull(indexPath(root)), "no file may be written with no hive.yml present");
  });

  it("writes nothing when the key is absent from an otherwise-real hive.yml", async () => {
    const { id, root } = seedProjectAt("gate-key-absent");
    seedTodo(id, { title: "should not appear anywhere" });
    writeFileSync(join(root, "hive.yml"), "placement: split\n");
    await tick(null);
    assert.ok(!statOrNull(indexPath(root)));
  });

  it("writes nothing when the key is explicitly false", async () => {
    const { id, root } = seedProjectAt("gate-false");
    seedTodo(id, { title: "should not appear anywhere" });
    setDashboardKey(root, false);
    await tick(null);
    assert.ok(!statOrNull(indexPath(root)));
  });

  it("never claims - never writes a dashboard_meta row at all - for a project the gate has already rejected", async () => {
    // The gate (hive.yml's dashboard key) must run BEFORE the claim, not
    // after. Claiming first means the claim's UPDATE succeeds once every
    // DASHBOARD_MIN_INTERVAL_SECONDS, forever, for every registered
    // project - including one that will never render anything - which is
    // a permanent periodic write to a WAL store shared by every hive
    // session on the machine. See
    // .claude/sessions/decisions/2026-08-05-simplify-can-move-a-line-across-a-guard.md:
    // the transferable argument is the same shape, moving a line ahead of
    // a guard pays nothing when safe and pays only when risky, and here it
    // pays most exactly where the work should never happen at all. This
    // test is the assertion that fails if a future pass reorders this
    // again the way one already did.
    const { id, root } = seedProjectAt("gate-precedes-claim");
    setDashboardKey(root, false);
    await tick(null);
    const meta = db.prepare("SELECT 1 FROM dashboard_meta WHERE project_id = ?").get(id);
    assert.equal(meta, undefined, "a disabled project must never get a dashboard_meta row or a claim write");
  });

  it("writes nothing on a malformed value, matching loadProjectYml's own parse-warning fallback", async () => {
    const { id, root } = seedProjectAt("gate-malformed");
    seedTodo(id, { title: "should not appear anywhere" });
    writeFileSync(join(root, "hive.yml"), "dashboard: yesplease\n");
    await assert.doesNotReject(() => tick(null));
    assert.ok(!statOrNull(indexPath(root)));
  });

  it("writes the file with no command typed, once dashboard: true is set - the positive control every negative control above needs to be able to fail against", async () => {
    const { id, root } = seedProjectAt("gate-true");
    seedTodo(id, { title: "should appear in the written file" });
    setDashboardKey(root, true);

    await tick(null);

    const written = readFileSync(indexPath(root), "utf8");
    assert.ok(written.includes("should appear in the written file"), "the file must be a real render, not a stub");
    // Live toggle replaced meta refresh (SCRIPT's own timer); the file must
    // still declare the Live control that stands in for it.
    assert.ok(written.includes('id="live-toggle"'));
  });

  it("creates .claude/dashboard/ itself the first time the key is true and the directory is missing - the key is now the switch, not the directory", async () => {
    const { id, root } = seedProjectAt("gate-creates-dir");
    seedTodo(id, { title: "first run" });
    setDashboardKey(root, true);
    assert.ok(!statOrNull(join(root, ".claude", "dashboard")), "precondition: the directory must not exist yet");

    await tick(null);

    assert.ok(statOrNull(join(root, ".claude", "dashboard")).isDirectory());
    assert.ok(readFileSync(indexPath(root), "utf8").includes("first run"));
  });
});

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

describe("the scheduler hook: rate-limited claim, not a lockfile (todo 309)", () => {
  it("does not rewrite the file on a second tick inside the claim window, even though the store is now dirty", async () => {
    const { id, root } = seedProjectAt("claim-window");
    setDashboardKey(root, true);
    await tick(null);
    const firstMtime = statSync(indexPath(root)).mtimeMs;

    seedTodo(id, { title: "added inside the claim window" });
    await tick(null);

    const secondMtime = statSync(indexPath(root)).mtimeMs;
    assert.equal(secondMtime, firstMtime, "a second attempt inside the 5s claim window must not rewrite the file");
    const content = readFileSync(indexPath(root), "utf8");
    assert.ok(!content.includes("added inside the claim window"), "the un-rewritten file must not show the later edit");
  });

  it("picks up a real change once the claim window has passed", async () => {
    const { id, root } = seedProjectAt("claim-window-elapsed");
    setDashboardKey(root, true);
    await tick(null);

    seedTodo(id, { title: "added after the claim window elapsed" });
    // Rewind the claim's own bookkeeping rather than sleeping five real
    // seconds: the claim is a plain datetime comparison, so backdating
    // last_attempt_at exercises the exact same branch elapsed real time
    // would, deterministically and instantly.
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    const content = readFileSync(indexPath(root), "utf8");
    assert.ok(content.includes("added after the claim window elapsed"));
  });

  it("picks up an existing agent's state transition - an UPDATE to a row already on disk, not a new row", async () => {
    // The specific case a MAX(id)-only mark would miss: agent_state changes
    // in place on the same row, so nothing NEW is ever inserted. This is
    // exactly the residual the dirty-check redesign (src/db.ts's
    // dashboard_meta comment) exists to close.
    const { id, root } = seedProjectAt("claim-window-agent-state");
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, status, agent_state)
       VALUES (?, 'agent:claim-state', 'state-worker', 'claude', '/scratch', 'running', 'working')`,
    ).run(id);
    setDashboardKey(root, true);
    await tick(null);
    // Visual redesign: agent state carries a status word (live/ok/warn),
    // not a bare state name in its own tag - "working" reads as "live".
    assert.ok(readFileSync(indexPath(root), "utf8").includes('status-live">live</span> working'));

    db.prepare(
      "UPDATE agents SET agent_state = 'idle', state_changed_at = datetime('now') WHERE actor_id = 'agent:claim-state'",
    ).run();
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    assert.ok(
      readFileSync(indexPath(root), "utf8").includes('status-ok">ok</span> idle'),
      "the state transition must be picked up",
    );
  });
});

describe("the scheduler hook: dirty check does not regenerate an unchanged store (todo 309)", () => {
  it("skips the write when nothing changed, even once the claim window has elapsed", async () => {
    const { id, root } = seedProjectAt("dirty-check-clean");
    setDashboardKey(root, true);
    await tick(null);
    const firstMtime = statSync(indexPath(root)).mtimeMs;

    // A real, forced gap before the second tick: mtimeMs is only convincing
    // evidence of "no write happened" if a write in that window would
    // provably have produced a DIFFERENT mtime. Without this, a broken dirty
    // check that rewrites unconditionally could still land within the same
    // instant and pass by coincidence (test/CLAUDE.md's own back-to-back-
    // backupNow() lesson, applied here).
    await new Promise((resolve) => setTimeout(resolve, 50));

    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    const secondMtime = statSync(indexPath(root)).mtimeMs;
    assert.equal(secondMtime, firstMtime, "an elapsed claim window alone must not force a rewrite of an unchanged store");
  });
});

describe("the scheduler hook: content hash closes the old column-mark's blind spots (counselors, findings 2/3)", () => {
  it("picks up a wake_update-style body edit alone, with no timer column changing", async () => {
    const { id, root } = seedProjectAt("dirty-check-wake-body-edit");
    const { id: wakeId } = seedWake(id, { body: "original wake body", dueInSeconds: 3600 });
    setDashboardKey(root, true);
    await tick(null);
    assert.ok(readFileSync(indexPath(root), "utf8").includes("original wake body"));

    // The old column-mark watched MAX(id)/MAX(due_at)/MAX(fired_at)/
    // MAX(cancelled_at) on timers - a body-only UPDATE (wake_update with no
    // delay_seconds) touches none of them, so this edit used to stay
    // invisible until an unrelated wake changed.
    db.prepare("UPDATE timers SET body = ? WHERE id = ?").run("edited wake body", wakeId);
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    assert.ok(
      readFileSync(indexPath(root), "utf8").includes("edited wake body"),
      "a body-only wake edit must be picked up",
    );
  });

  it("picks up an agent_rename-style name change alone, with no timestamp column to move", async () => {
    // agent_rename's UPDATE (src/spawn.ts) writes agents.name with no
    // timestamp at all, so nothing in the old mark ever watched it.
    const { id, root } = seedProjectAt("dirty-check-agent-rename");
    const agentId = seedAgent(id, { name: "old-name", actorId: "agent:rename-1" });
    setDashboardKey(root, true);
    await tick(null);
    assert.ok(readFileSync(indexPath(root), "utf8").includes("old-name"));

    db.prepare("UPDATE agents SET name = ? WHERE id = ?").run("new-name", agentId);
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    const content = readFileSync(indexPath(root), "utf8");
    assert.ok(content.includes("new-name"), "a name-only agent rename must be picked up");
    assert.ok(!content.includes("old-name"));
  });

  it("picks up a pad_delete of the board pad, even when another pad in the project holds a later updated_at", async () => {
    const { id, root } = seedProjectAt("dirty-check-pad-delete");
    seedPad(id, "board", "the board pad content");
    setDashboardKey(root, true);
    await tick(null);
    assert.ok(readFileSync(indexPath(root), "utf8").includes("the board pad content"));

    // A second pad, seeded AFTER the board pad, so its own updated_at is
    // later - the exact shape that left the old MAX(updated_at)-based mark
    // unchanged after a hard DELETE of the board pad (pad_delete has no
    // soft-delete flag; MAX(updated_at) stays monotonic across the DELETE).
    seedPad(id, "other", "unrelated pad");
    db.prepare("DELETE FROM scratchpads WHERE project_id = ? AND name = 'board'").run(id);
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    const content = readFileSync(indexPath(root), "utf8");
    assert.ok(!content.includes("the board pad content"), "a deleted board pad must not go on rendering");
    assert.ok(content.includes('No pad named "board"'), "the page must say plainly that the board pad is gone");
  });

  it("regenerates index.html after it is deleted from disk, even though the store itself has not changed", async () => {
    const { id, root } = seedProjectAt("dirty-check-deleted-file");
    seedTodo(id, { title: "must reappear after deletion" });
    setDashboardKey(root, true);
    await tick(null);
    assert.ok(statOrNull(indexPath(root)));

    // .gitignore:10 makes .claude/* ignored, so `git clean -xdf` (routine
    // after a lane) removes this file with no store change alongside it.
    rmSync(indexPath(root));
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    assert.ok(
      readFileSync(indexPath(root), "utf8").includes("must reappear after deletion"),
      "the file must be rewritten even though last_mark still matches the unchanged store",
    );
  });
});

describe("the scheduler hook: the throughput chart and pads section must not defeat the content hash", () => {
  // The lead's own warning on this follow-up round: the chart and pads
  // sections must not sneak a per-render value into the hashed content, or
  // the dirty check writes every 5 seconds forever - the exact failure this
  // page's own "generated at" stamp is already deliberately excluded from
  // hashing to avoid (buildDashboard's comment in src/dashboard.ts). This is
  // the same shape as the existing "skips the write when nothing changed"
  // test above, run again with real chart data (a completed todo, an open
  // todo) and a real extra pad present, so both new sections are actually
  // exercised rather than rendering their empty states.
  it("does not rewrite the file on a second unclaimed-window tick, with chart data and an extra pad both present", async () => {
    const { id, root } = seedProjectAt("hash-stability-chart-pads");
    seedTodo(id, { title: "an open todo" });
    const doneId = seedTodo(id, { title: "a done todo" });
    db.prepare("UPDATE todos SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(doneId);
    seedPad(id, "notes", "some notes, not the board");
    setDashboardKey(root, true);
    await tick(null);
    const firstMtime = statSync(indexPath(root)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 50));
    db.prepare(
      "UPDATE dashboard_meta SET last_attempt_at = datetime('now', '-10 seconds') WHERE project_id = ?",
    ).run(id);
    await tick(null);

    const secondMtime = statSync(indexPath(root)).mtimeMs;
    assert.equal(
      secondMtime,
      firstMtime,
      "an unchanged store must not rewrite the file just because the chart or pads sections were added to the page",
    );
  });
});

describe("the scheduler hook: output directory must never escape the project root (counselors P1)", () => {
  it("refuses to write when .claude/dashboard already exists as a symlink pointing outside the project", async () => {
    const { id, root } = seedProjectAt("path-escape-existing-symlink");
    const outside = mkdtempSync(join(tmpdir(), "hive-dashboard-outside-"));
    mkdirSync(join(root, ".claude"), { recursive: true });
    symlinkSync(outside, join(root, ".claude", "dashboard"));
    setDashboardKey(root, true);
    seedTodo(id, { title: "must never leave the project root" });

    await assert.doesNotReject(() => tick(null));

    assert.ok(
      !statOrNull(join(outside, "index.html")),
      "the symlink's real target outside the project must never receive a write",
    );
    const meta = db.prepare("SELECT 1 FROM dashboard_meta WHERE project_id = ?").get(id);
    assert.equal(meta, undefined, "an escaping project must never get a dashboard_meta row or a claim write either");
  });

  it("refuses even when .claude/dashboard does not exist yet, but .claude itself is a symlink pointing outside", async () => {
    const { id, root } = seedProjectAt("path-escape-ancestor-symlink");
    const outside = mkdtempSync(join(tmpdir(), "hive-dashboard-outside-ancestor-"));
    symlinkSync(outside, join(root, ".claude"));
    setDashboardKey(root, true);
    seedTodo(id, { title: "must never leave the project root" });

    await assert.doesNotReject(() => tick(null));

    assert.ok(
      !statOrNull(join(outside, "dashboard")),
      "no directory may be created inside the symlinked ancestor before the escape is even detected",
    );
  });

  it("still writes normally for an ordinary project with no symlink involved", async () => {
    const { id, root } = seedProjectAt("path-no-escape-control");
    setDashboardKey(root, true);
    seedTodo(id, { title: "ordinary project must still work" });

    await tick(null);

    assert.ok(readFileSync(indexPath(root), "utf8").includes("ordinary project must still work"));
  });
});

describe("the scheduler hook: a broken generator must not take the scheduler down (todo 309)", () => {
  it("survives a write failure for one project, and does not corrupt or half-write the file", async () => {
    const { id, root } = seedProjectAt("write-failure");
    seedTodo(id, { title: "should never reach disk" });
    setDashboardKey(root, true);
    const dashboardDir = join(root, ".claude", "dashboard");
    mkdirSync(dashboardDir, { recursive: true });
    // Occupy the exact temp-file path the writer will use with a directory
    // instead of a file. writeFileSync onto an existing directory throws
    // EISDIR unconditionally - portable, and unlike a permission-bit trick,
    // not silently bypassed when the suite happens to run as root.
    mkdirSync(join(dashboardDir, `.index.html.tmp-${process.pid}`));

    await assert.doesNotReject(() => tick(null), "a write failure for one project must not escape the tick");

    assert.ok(!statOrNull(indexPath(root)), "a failed write must never leave a partial or stale file behind");
    const meta = db.prepare("SELECT last_attempt_at, last_mark FROM dashboard_meta WHERE project_id = ?").get(id);
    assert.ok(meta.last_attempt_at, "the claim itself must still be recorded - the failure is in the write, not the claim");
    assert.equal(meta.last_mark, null, "last_mark must stay unset: the write never actually completed");
  });

  it("still generates a second project's dashboard in the same tick after the first one's write failed", async () => {
    const broken = seedProjectAt("write-failure-sibling-broken");
    const healthy = seedProjectAt("write-failure-sibling-healthy");
    seedTodo(healthy.id, { title: "sibling project should still render" });
    setDashboardKey(broken.root, true);
    setDashboardKey(healthy.root, true);
    const brokenDashboardDir = join(broken.root, ".claude", "dashboard");
    mkdirSync(brokenDashboardDir, { recursive: true });
    mkdirSync(join(brokenDashboardDir, `.index.html.tmp-${process.pid}`));

    await tick(null);

    assert.ok(!statOrNull(indexPath(broken.root)), "the broken project must still have no file");
    const healthyContent = readFileSync(indexPath(healthy.root), "utf8");
    assert.ok(healthyContent.includes("sibling project should still render"));
  });

  it("cleans up its own temp file when the rename fails, rather than leaving it behind", async () => {
    // Distinct from the EISDIR case above, which pre-occupies the TEMP path
    // and so never gets far enough to create a real temp file at all. This
    // occupies the TARGET instead: writeFileSync to the temp path succeeds
    // for real, then renameSync onto an existing directory fails (POSIX
    // rename refuses a file-onto-directory rename), which is the actual
    // shape that can strand a temp file if the failure path does not clean
    // up after itself.
    const { id, root } = seedProjectAt("write-failure-temp-cleanup");
    seedTodo(id, { title: "irrelevant" });
    setDashboardKey(root, true);
    const dashboardDir = join(root, ".claude", "dashboard");
    mkdirSync(dashboardDir, { recursive: true });
    mkdirSync(indexPath(root)); // occupy index.html itself as a directory

    await assert.doesNotReject(() => tick(null));

    const leftoverTemp = statOrNull(join(dashboardDir, `.index.html.tmp-${process.pid}`));
    assert.equal(leftoverTemp, null, "a failed rename must not leave its temp file behind");
  });
});

describe("the scheduler hook: project scoping (todo 309)", () => {
  it("writes only the project whose hive.yml enables it, never a sibling's", async () => {
    const enabled = seedProjectAt("scoping-enabled");
    const disabled = seedProjectAt("scoping-disabled");
    seedTodo(enabled.id, { title: "enabled project todo" });
    seedTodo(disabled.id, { title: "disabled project todo" });
    setDashboardKey(enabled.root, true);

    await tick(null);

    const content = readFileSync(indexPath(enabled.root), "utf8");
    assert.ok(content.includes("enabled project todo"));
    assert.ok(!content.includes("disabled project todo"), "one project's file must never carry another's data");
    assert.ok(!statOrNull(indexPath(disabled.root)), "the disabled project must have no file at all");
  });
});
