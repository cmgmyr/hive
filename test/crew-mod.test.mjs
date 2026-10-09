import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";
import { ago, buildCrewView, failedView, readCrew } from "../claude-plugin/crew/model.mjs";

const { cleanup } = isolateTmux("the crew mod model tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();
after(() => cleanup(sessionName()));

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

const activity = (o = {}) => ({ label: "editing", since: "2026-10-08T11:58:00.000Z", lower_bound: false, ...o });
const worker = (o = {}) => ({
  id: 7, name: "w7", model: "opus", harness: "claude", state: "working",
  created_at: "2026-10-08T10:00:00.000Z", state_changed_at: "2026-10-08T11:50:00.000Z", session_id: "s1",
  age_seconds: 7200, activity: activity(), context_fill: { used_tokens: 1, window_tokens: 2, used_percent: 41.4 },
  your_turn: false, commits_ahead: null, ...o,
});
const lane = (todo, w) => ({ todo, worker: w });
const todoOf = (id, slug) => ({ id, slug, status: "in_progress" });
const snapshot = (o = {}) => ({
  schema_version: 1, project: { id: 1, name: "proj" }, read_at: "2026-10-08T12:00:00.000Z",
  lanes: [], needs_you: [], wakes: { pending: 0, next: null, watching: [], watched_worker_ids: [] }, context_checkpoint_percent: null, ...o,
});
const runOk = (snap) => async () => ({ exitCode: 0, stdout: JSON.stringify(snap), stderr: "" });

describe("readCrew", () => {
  it("one crew argv read validates schema and reports failures", async () => {
    const calls = [];
    const run = async (argv, init) => {
      calls.push([argv, init]);
      return { exitCode: 0, stdout: JSON.stringify(snapshot()), stderr: "" };
    };
    assert.equal((await readCrew(run, "/some/cwd")).schema_version, 1);
    assert.deepEqual(calls, [[["hive", "crew", "--json"], { cwd: "/some/cwd", timeoutMs: 4000 }]]);

    await assert.rejects(readCrew(runOk(snapshot({ schema_version: 2 })), "/c"), /schema 2 is not 1/);
    await assert.rejects(readCrew(runOk({ ...snapshot(), lanes: null }), "/c"), /missing lanes/);
    await assert.rejects(readCrew(async () => ({ exitCode: 0, stdout: "not json", stderr: "" }), "/c"), /invalid JSON/);
    await assert.rejects(
      readCrew(async () => ({ exitCode: 1, stdout: "", stderr: "\nhive crew: unknown project\nmore" }), "/c"),
      /exit 1: hive crew: unknown project/,
    );
    await assert.rejects(readCrew(async () => ({ exitCode: 2, stdout: "", stderr: "" }), "/c"), /^Error: exit 2$/);
    await assert.rejects(readCrew(async () => { throw new Error("timed out"); }, "/c"), /did not answer: timed out/);
  });

  it("real hive crew --json over staffed unstaffed wake and needs-you shapes builds a view whose fixtures share its key sets", async () => {
    const project = addProject(dirs.projectDir, "mod-proj");
    const todo = (slug, status, tags = "[]") =>
      db.prepare("INSERT INTO todos (project_id, title, status, slug, tags) VALUES (?, ?, ?, ?, ?) RETURNING id").get(project.id, slug, status, slug, tags).id;
    const laneId = todo("real lane", "in_progress");
    todo("bare lane", "in_progress");
    todo("ask human", "open", '["needs-human"]');
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, agent_state, model, todo_id)
       VALUES (?, 'agent:real', 'real-w', '%999', 'claude', ?, 'agent', 'running', 'working', 'opus', ?)`,
    ).run(project.id, dirs.projectDir, laneId);
    const wake = db.prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, due_at, deliver_actor, deliver_pane, watch_scope, max_wait_at)
       VALUES (?, 'lead', ?, ?, ?, 'lead', '%0', ?, ?)`,
    );
    wake.run(project.id, "check the lane", "delay", "2099-01-01 00:00:00", null, null);
    wake.run(project.id, "standing watch", "idle_any", null, "project", "2099-01-01 00:00:00");
    const run = async (argv, init) => {
      const r = await runCli(argv.slice(1), { cwd: init.cwd, dataDir: dirs.dataDir, tmp: dirs.tmp });
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    };
    const real = await readCrew(run, dirs.projectDir);
    const view = buildCrewView(real, null, Date.now());
    assert.equal(view.header.split(" · ").slice(0, 2).join(" · "), "mod-proj · 1 worker");
    assert.deepEqual(view.rows.map((r) => [r.id, r.slug]), [[String(laneId), "real lane"], [String(laneId + 1), "bare lane"]]);
    assert.match(view.rows[0].detail, /^opus · /);
    assert.equal(view.rows[1].detail, "unstaffed");
    assert.deepEqual(view.needsYou, [{ id: String(laneId + 2), slug: "ask human" }]);
    assert.match(view.footer[0].text, /^next in \d+[hm]\d*m?: check the lane$/);
    assert.match(view.footer[1].text, /^watching: all workers · standing · until \d\d:\d\d$/);

    const keys = (o) => Object.keys(o).sort();
    const fixture = snapshot({ lanes: [lane(todoOf(1, "t"), worker())], needs_you: [{ id: 1, slug: "s" }], wakes: { pending: 1, next: { id: 1, label: "l", due_at: null, generated: false, held: null }, watching: [{ id: 2, label: "w", kind: "idle_any", scope: "project", max_wait_at: null }], watched_worker_ids: [] } });
    const staffed = real.lanes.find((l) => l.worker);
    assert.deepEqual(keys(fixture), keys(real));
    assert.deepEqual(keys(fixture.project), keys(real.project));
    assert.deepEqual(keys(fixture.lanes[0]), keys(staffed));
    assert.deepEqual(keys(fixture.lanes[0].todo), keys(staffed.todo));
    assert.deepEqual(keys(fixture.lanes[0].worker), keys(staffed.worker));
    assert.deepEqual(keys(fixture.lanes[0].worker.activity), keys(staffed.worker.activity));
    assert.deepEqual(keys(fixture.needs_you[0]), keys(real.needs_you[0]));
    assert.deepEqual(keys(fixture.wakes), keys(real.wakes));
    assert.deepEqual(keys(fixture.wakes.next), keys(real.wakes.next));
    assert.deepEqual(keys(fixture.wakes.watching[0]), keys(real.wakes.watching[0]));
  });
});

describe("buildCrewView", () => {
  it("two-line rows retain id model activity timing age and ctx", () => {
    const view = buildCrewView(snapshot({ lanes: [lane(todoOf(1798, "crew mod"), worker({ commits_ahead: 3 }))] }), null, NOW);
    assert.deepEqual(view.rows[0], {
      key: "w7", color: "green", id: "1798", slug: "crew mod", detail: "opus · editing 2m · ctx 41% · 2h0m · +3 commits",
      parts: [{ text: "opus · editing 2m · " }, { text: "ctx 41%", amber: false }, { text: " · 2h0m · +3 commits" }],
    });
    assert.equal(ago(59), "59s");
    assert.equal(ago(-5), "0s");
  });

  it("unstaffed duplicate todo and unlinked workers stay distinct", () => {
    const view = buildCrewView(
      snapshot({
        lanes: [
          lane(todoOf(5, "shared"), worker({ id: 1, name: "a", session_id: "x" })),
          lane(todoOf(5, "shared"), worker({ id: 2, name: "b", session_id: "y" })),
          lane(null, worker({ id: 3, name: "loose", session_id: "z", model: null, harness: "codex" })),
          lane(todoOf(9, "nobody"), null),
        ],
      }),
      null,
      NOW,
    );
    assert.deepEqual(view.rows.map((r) => r.key), ["w1", "w2", "w3", "t9"]);
    assert.equal(view.rows[2].id, "--");
    assert.equal(view.rows[2].slug, "loose unlinked");
    assert.match(view.rows[2].detail, /^codex · /);
    assert.equal(view.rows[3].detail, "unstaffed");
    assert.equal(view.rows[3].color, "gray");
    assert.equal(view.header, "proj · 3 workers");
  });

  it("renders a pad link without showing a todo id", () => {
    const view = buildCrewView(
      snapshot({ lanes: [lane(null, worker({ id: 4, name: "pad-worker" }))].map((entry) => ({ ...entry, pad: "shared board" })) }),
      null,
      NOW,
    );
    assert.equal(view.rows[0].id, "--");
    assert.equal(view.rows[0].slug, "pad shared board");
  });

  it("threshold your-turn watch and metric tokens follow JSON evidence", () => {
    const view = buildCrewView(
      snapshot({
        context_checkpoint_percent: 40,
        lanes: [
          lane(todoOf(1, "hot"), worker({ id: 1 })),
          lane(todoOf(2, "turn"), worker({ id: 2, state: "idle", your_turn: true, activity: activity({ label: "idle", since: null }), context_fill: null })),
          lane(todoOf(3, "dialog"), worker({ id: 3, state: "blocked", activity: activity({ label: "blocked", since: null }) })),
          lane(todoOf(4, "cool"), worker({ id: 4, context_fill: { used_tokens: 1, window_tokens: 9, used_percent: 39.9 }, state: "stopped" })),
        ],
        needs_you: [{ id: 12, slug: "decide" }],
        wakes: {
          pending: 2,
          next: { id: 3, label: "check lanes", due_at: "2026-10-08T12:05:00.000Z", generated: false, held: null },
          watching: [{ id: 4, label: "idle watch", kind: "idle_any", scope: "project", max_wait_at: null }],
          watched_worker_ids: [],
        },
      }),
      null,
      NOW,
    );
    const [hot, turn, dialog, cool] = view.rows;
    const amberOf = (row) => row.parts.find((p) => p.text.startsWith("ctx"))?.amber;
    assert.equal(amberOf(hot), true);
    assert.equal(amberOf(cool), false);
    assert.equal(turn.color, "yellow");
    assert.match(turn.detail, /^opus · your turn 10m · ctx \? · /);
    assert.equal(amberOf(turn), false);
    assert.equal(dialog.color, "red");
    assert.match(dialog.detail, /^opus · blocked ~0s · ctx 41% · /);
    assert.equal(cool.color, "gray");
    assert.deepEqual(view.needsYou, [{ id: "12", slug: "decide" }]);
    assert.deepEqual(view.footer, [{ text: "next in 5m: check lanes" }, { text: "watching: all workers · standing" }]);
    const none = buildCrewView(snapshot(), null, NOW);
    assert.deepEqual(none.footer, [{ text: "next: none" }]);
    assert.equal(view.header, "proj · 4 workers · 1 need you");
    assert.equal(none.header, "proj · 0 workers");
  });

  it("observed duration resets on session change", () => {
    const blocked = (session) =>
      snapshot({ lanes: [lane(todoOf(1, "l"), worker({ state: "blocked", session_id: session, activity: activity({ label: "blocked", since: null }) }))] });
    const first = buildCrewView(blocked("s1"), null, NOW);
    assert.equal(first.rows[0].detail.split(" · ")[1], "blocked ~0s");
    const later = buildCrewView(blocked("s1"), first, NOW + 90_000);
    assert.equal(later.rows[0].detail.split(" · ")[1], "blocked ~1m");
    const reset = buildCrewView(blocked("s2"), later, NOW + 120_000);
    assert.equal(reset.rows[0].detail.split(" · ")[1], "blocked ~0s");
    const bound = buildCrewView(
      snapshot({ lanes: [lane(todoOf(1, "l"), worker({ activity: activity({ lower_bound: true }) }))] }),
      later,
      NOW,
    );
    assert.equal(bound.rows[0].detail.split(" · ")[1], "editing >=2m");
  });
});

describe("next wake text", () => {
  const wakeOf = (label, due_at) => snapshot({ wakes: { pending: 1, next: { id: 1, label, due_at }, watching: [] } });
  const occurrences = (view, needle) => [view.header, ...view.footer.map((l) => l.text)].join("\n").split(needle).length - 1;

  it("next wake text appears exactly once across header and footer, in the footer, for wake-less and wake-bearing snapshots", () => {
    const wakeless = buildCrewView(snapshot({ needs_you: [{ id: 3, slug: "x" }] }), null, NOW);
    assert.deepEqual(wakeless.footer, [{ text: "next: none" }]);
    assert.equal(wakeless.header, "proj · 0 workers · 1 need you");
    assert.equal(occurrences(wakeless, "next"), 1);
    const bearing = buildCrewView(wakeOf("check the lane", "2026-10-08T12:00:30.000Z"), null, NOW);
    assert.deepEqual(bearing.footer, [{ text: "next in 30s: check the lane" }]);
    assert.equal(bearing.header, "proj · 0 workers");
    assert.equal(occurrences(bearing, "check the lane"), 1);
    const undated = buildCrewView(wakeOf("later", null), null, NOW);
    assert.deepEqual(undated.footer, [{ text: "next: later" }]);
    assert.equal(occurrences(undated, "later"), 1);
  });
});

describe("footer from structured wake fields", () => {
  const nextOf = (next) => buildCrewView(snapshot({ wakes: { pending: 1, next: { id: 1, label: "body line", due_at: "2026-10-08T12:00:00.000Z", generated: false, held: null, ...next }, watching: [] } }), null, NOW).footer[0].text;
  const watchOf = (watching, lanes = []) => buildCrewView(snapshot({ lanes, wakes: { pending: 0, next: null, watching } }), null, NOW).footer;
  const standing = { id: 2, label: "Standing watch over the crew. Prose body that must never be printed.", kind: "idle_any", scope: "project", max_wait_at: null };

  it("a generated notice reads crew notice and a held wake says held with its short reason never next in 0s", () => {
    assert.equal(nextOf({ generated: true, label: "Crew notice: w1 finished. Long prose." }), "next in 0s: crew notice");
    assert.equal(nextOf({ generated: true, held: "talking" }), "held (talking): crew notice");
    assert.equal(nextOf({ held: "typing" }), "held (typing): body line");
    assert.equal(nextOf({}), "next in 0s: body line");
  });

  it("a standing watch renders scope standing and until from max_wait_at never its body", () => {
    const text = watchOf([{ ...standing, max_wait_at: "2026-10-08T12:35:00.000Z" }])[1].text;
    const until = new Date("2026-10-08T12:35:00.000Z");
    const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    assert.equal(text, `watching: all workers · standing · until ${hhmm}`);
    assert.equal(watchOf([standing])[1].text, "watching: all workers · standing");
  });

  it("a pending one-shot idle wake covering a running worker is watched, so no unwatched line", () => {
    const lanes = [lane(todoOf(1, "t"), worker({ id: 7 }))];
    const view = (ids) => buildCrewView(snapshot({ lanes, wakes: { pending: 1, next: null, watching: [], watched_worker_ids: ids } }), null, NOW).footer;
    assert.equal(view([7]).some((l) => l.amber), false);
    assert.equal(view([9]).some((l) => l.amber), true);
    assert.equal(view([]).some((l) => l.amber), true);
  });

  it("running workers with no watch get an amber unwatched line and no workers or a watch get none", () => {
    const lanes = [lane(todoOf(1, "t"), worker())];
    assert.deepEqual(watchOf([], lanes)[1], { text: "unwatched: no standing watch on running workers", amber: true });
    assert.equal(watchOf([], []).length, 1);
    assert.equal(watchOf([standing], lanes).some((l) => l.amber), false);
  });
});

describe("failedView", () => {
  it("failed first read with no prior view says no data, never no lanes", () => {
    const first = failedView(null, "exit 1: boom");
    assert.equal(first.noData, true);
    assert.equal(first.error, "exit 1: boom");
    assert.deepEqual(first.rows, []);
    assert.equal(buildCrewView(snapshot(), first, NOW).noData, false);
    assert.equal(failedView(buildCrewView(snapshot(), null, NOW), "x").noData, false);
  });

  it("failed poll preserves last good rows", () => {
    const good = buildCrewView(snapshot({ lanes: [lane(todoOf(1, "kept"), worker())] }), null, NOW);
    const failed = failedView(good, "hive crew exited 1");
    assert.equal(failed.error, "hive crew exited 1");
    assert.deepEqual(failed.rows, good.rows);
    assert.equal(failed.header, good.header);
    assert.equal(failedView(null, "boom").rows.length, 0);
    assert.equal(buildCrewView(snapshot(), failed, NOW).error, "");
  });
});
