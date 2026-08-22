import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

isolateTmux("the crew teardown record tests");
clearHiveEnv();

const { dataDir, projectDir, tmp } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;

const opts = {
  cwd: projectDir,
  env: {
    HIVE_DATA_DIR: dataDir,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    CLAUDE_CONFIG_DIR: join(tmp, "claude-config"),
  },
};

await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { janitor, sightingMaxAgeMs, SIGHTING_MAX_AGE_MS } = await import("../dist/scheduler.js");
const { TEARDOWN_LOG, TEARDOWN_MAX_RECORDS } = await import("../dist/teardown.js");
migrate();

writeFileSync(join(projectDir, "hive.yml"), "profile: orchestration\n");
const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);

const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id;

const EMPTY = { panes: new Set(), windows: new Set(), serverAnswered: true };
const logPath = join(dataDir, TEARDOWN_LOG);

function seed(name, pane, { kind = "agent", age = "-60 seconds", changed = "-60 seconds", sessionId, inProject } = {}) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind,
          agent_state, state_changed_at, pane_pid, session_id, created_at)
       VALUES (?, ?, ?, ?, '', 'claude', ?, 'running', ?, 'working', datetime('now', ?), '4242', ?,
          datetime('now', ?))
       RETURNING id`,
    )
    .get(
      inProject ?? project,
      `agent:${name}`,
      name,
      pane,
      join(tmp, `wt-${name}`),
      kind,
      changed,
      sessionId ?? `sid-${name}`,
      age,
    ).id;
}

const otherProject = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("neighbour", join(tmp, "neighbour")).id;

const records = () =>
  existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

const statusOf = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;

function reset() {
  db.exec("DELETE FROM agents;");
  if (existsSync(logPath)) writeFileSync(logPath, "");
}

describe("a crew teardown leaves a breadcrumb outside the server that died", () => {
  it("reports an INFERRED window while no tick of this process has ever seen the socket alive", () => {
    reset();
    seed("first-gone", "%7001");

    const result = janitor(EMPTY);

    assert.equal(result.closed_agents, 1);
    const [record] = records();
    assert.equal(record.window.basis, "inferred", "a bound nobody witnessed must never be labelled observed");
    assert.equal(
      record.window.from,
      record.crew[0].last_evidence_at,
      "an inferred bound starts at the newest evidence in the store, which is the only floor available",
    );
    assert.ok(record.window.width_seconds >= 60, `a 60s-old row gives a >=60s window; got ${record.window.width_seconds}`);
  });

  it("carries the lead that died beside the workers, and sweeps only the workers", () => {
    reset();
    const alpha = seed("alpha", "%7010");
    const beta = seed("beta", "%7011");
    const lead = seed("crew-lead", "%7012", { kind: "lead" });

    const result = janitor(EMPTY);

    assert.equal(result.closed_agents, 2, "the janitor sweeps workers only");
    assert.equal(statusOf(lead), "running", "sweeping lead rows is a different behaviour and not this lane's");
    const [record] = records();
    assert.deepEqual(
      record.crew.map((m) => [m.name, m.swept]).sort(),
      [
        ["alpha", true],
        ["beta", true],
        ["crew-lead", false],
      ],
      "the lead is the casualty the janitor's own query would omit, so the roster reads it separately",
    );
    assert.equal(record.attribution, "not attributed");
    assert.equal(statusOf(alpha), "closed");
    assert.equal(statusOf(beta), "closed");
  });

  it("records each worker's session id, so the resume survives the crew", () => {
    reset();
    seed("resumable", "%7020", { sessionId: "sid-abc-123" });

    janitor(EMPTY);

    assert.equal(records()[0].crew[0].session_id, "sid-abc-123");
    assert.match(records()[0].crew[0].cwd, /wt-resumable$/);
  });

  it("writes nothing when the probe failed, so a wedged server is never read as a dead one", () => {
    reset();
    const agent = seed("wedged", "%7030");

    const result = janitor(null);

    assert.equal(result.probed, false);
    assert.equal(records().length, 0, "an unanswered probe is not evidence of a death");
    assert.equal(statusOf(agent), "running");
  });

  it("writes nothing when the server is alive and one pane went", () => {
    reset();
    const gone = seed("solo-exit", "%7040");
    const alive = seed("still-here", "%7041");

    const result = janitor({ panes: new Set(["%7041"]), windows: new Set(), serverAnswered: true });

    assert.equal(result.closed_agents, 1, "the ordinary sweep still happens");
    assert.equal(statusOf(gone), "closed");
    assert.equal(statusOf(alive), "running");
    assert.equal(records().length, 0, "one pane closing is not a teardown, and a noisy record is a useless one");
  });

  it("reports an OBSERVED window bounded by its own sighting when a tick saw the socket alive", () => {
    reset();
    seed("watched", "%7050");

    janitor({ panes: new Set(["%7050"]), windows: new Set(), serverAnswered: true });
    const result = janitor(EMPTY);

    assert.equal(result.closed_agents, 1);
    const [record] = records();
    assert.equal(record.window.basis, "observed");
    assert.ok(
      record.window.from > record.crew[0].last_evidence_at,
      "a sighting is only worth reporting when it is newer than what the store already knew",
    );
    assert.ok(record.window.width_seconds < 60, `a witnessed death is bounded by a tick; got ${record.window.width_seconds}`);
  });

  it("writes nothing when tmux is not installed, so an unset PATH cannot manufacture an incident", () => {
    reset();
    const agent = seed("no-tmux-binary", "%7110");

    const result = janitor({ panes: new Set(), windows: new Set(), serverAnswered: false });

    assert.equal(result.closed_agents, 1, "the sweep still happens - only the RECORD is gated");
    assert.equal(statusOf(agent), "closed");
    assert.equal(records().length, 0, "nobody answered, so nothing was observed and nothing is claimed");
  });

  it("falls back to an inferred window when its own sighting is too old to belong to this server", () => {
    reset();
    seed("stale-sighting", "%7120");

    janitor({ panes: new Set(["%7120"]), windows: new Set(), serverAnswered: true });
    process.env.HIVE_TEARDOWN_SIGHTING_MAX_AGE_MS = "0";
    try {
      janitor(EMPTY);
    } finally {
      delete process.env.HIVE_TEARDOWN_SIGHTING_MAX_AGE_MS;
    }

    assert.equal(
      records()[0].window.basis,
      "inferred",
      "a socket path outlives the server on it, so an old sighting cannot bound THIS death",
    );
  });

  it("clamps the sighting override so no value of it can buy an OBSERVED the process did not earn", () => {
    const cases = [
      ["0", 0],
      ["1000", 1000],
      [String(SIGHTING_MAX_AGE_MS), SIGHTING_MAX_AGE_MS],
      ["600000", SIGHTING_MAX_AGE_MS],
      ["99999999", SIGHTING_MAX_AGE_MS],
      ["not-a-number", SIGHTING_MAX_AGE_MS],
    ];
    try {
      for (const [set, expected] of cases) {
        process.env.HIVE_TEARDOWN_SIGHTING_MAX_AGE_MS = set;
        assert.equal(sightingMaxAgeMs(), expected, `override ${set} must never LENGTHEN the bound`);
      }
    } finally {
      delete process.env.HIVE_TEARDOWN_SIGHTING_MAX_AGE_MS;
    }
    assert.equal(sightingMaxAgeMs(), SIGHTING_MAX_AGE_MS, "unset falls back to the default");
  });

  it("records each crew member's project, so a reader can tell whose casualty it is", () => {
    reset();
    seed("ours", "%7130");
    seed("theirs", "%7131", { inProject: otherProject });

    janitor(EMPTY);

    const byName = Object.fromEntries(records()[0].crew.map((m) => [m.name, m.project_id]));
    assert.equal(byName.ours, project);
    assert.equal(byName.theirs, otherProject);
  });

  it("keeps the newest records and drops the oldest at the cap, leaving no staging file behind", () => {
    reset();
    const line = (n) =>
      JSON.stringify({
        detected_at: `2026-01-01 00:00:${String(n).padStart(2, "0")}`,
        socket: "/s",
        trigger: "t",
        attribution: "not attributed",
        window: { from: "2026-01-01 00:00:00", to: "2026-01-01 00:00:01", basis: "inferred", width_seconds: 1 },
        crew: [],
      });
    writeFileSync(logPath, `${Array.from({ length: TEARDOWN_MAX_RECORDS }, (_, i) => line(i)).join("\n")}\n`);
    seed("overflow", "%7140");

    janitor(EMPTY);

    const all = records();
    assert.equal(all.length, TEARDOWN_MAX_RECORDS, "the cap holds");
    assert.equal(all.at(-1).crew[0].name, "overflow", "the newest record is the one just written");
    assert.equal(all[0].detected_at, "2026-01-01 00:00:01", "the OLDEST record is the one dropped");
    assert.equal(existsSync(`${logPath}.trimming`), false, "the rename must leave no staging file behind");
  });

  it("files no second obituary for a crew it has already swept", () => {
    reset();
    seed("contested", "%7060");

    assert.equal(janitor(EMPTY).closed_agents, 1);
    assert.equal(janitor(EMPTY).closed_agents, 0, "the second sweep finds nothing running, which is the mechanism");

    assert.equal(records().length, 1);
  });
});

describe("hive doctor pulls the breadcrumb, since nobody was alive to be told", () => {
  it("names the dead crew, its resume route and what actually perishes, and claims no killer", async () => {
    reset();
    seed("ghost", "%7070", { sessionId: "sid-ghost-9" });
    janitor(EMPTY);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /warn {2}crew teardown: 1 of this project's pane\(s\) went with the tmux server at [^\n]*not attributed\./, stdout);
    assert.match(stdout, /still closed and resumable: ghost \(agent_resume\(agent_id: \d+\)\)/, stdout);
    assert.match(
      stdout,
      /The recorded session id does not expire; its transcript and its cwd can\./,
      "the true perishability sentence replaces the 7-day one this todo originally asked for",
    );
    assert.match(stdout, /hive records who WAS there, never who killed it/, stdout);
  });

  it("survives a record it did not write, since this is what people run once things are broken", async () => {
    reset();
    seed("ghost3", "%7090", { sessionId: "sid-ghost-3" });
    janitor(EMPTY);
    const good = readFileSync(logPath, "utf8");
    // The third line is the one two independent passes found: a PERFECT top level whose crew member
    // is null, which survived an Array.isArray check and threw out of the expression doctor runs.
    const nullMember = JSON.stringify({
      detected_at: "2027-01-01 00:00:00",
      socket: "/s",
      trigger: "t",
      attribution: "not attributed",
      window: { from: "2027-01-01 00:00:00", to: "2027-01-01 00:00:01", basis: "inferred", width_seconds: 1 },
      crew: [null],
    });
    writeFileSync(logPath, `${good}not json at all\n{"detected_at":"2026-01-01 00:00:00"}\n${nullMember}\n`);

    const { stdout, code } = await runCli(["doctor"], opts);

    assert.equal(code === 0 || code === 1, true, "doctor still ran");
    assert.match(
      stdout,
      /crew teardown: 1 of this project's pane\(s\)/,
      `a malformed line must cost that record and not the report; got: ${stdout}`,
    );
  });

  it("will not name a casualty by row id alone, since a restore can roll the store back under the record", async () => {
    reset();
    const dead = seed("rolled-back", "%7100", { sessionId: "sid-rolled" });
    janitor(EMPTY);
    // What a restore-then-respawn leaves behind: the record's id is live again, under someone else.
    db.prepare("UPDATE agents SET actor_id = ?, name = ? WHERE id = ?").run("agent:someone-else", "someone-else", dead);

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      stdout,
      /crew teardown/,
      `the row id is not the identity, and a confident wrong owner is worse than none; got: ${stdout}`,
    );
  });

  it("counts another project's casualties without naming any of them", async () => {
    reset();
    seed("mine", "%7200", { sessionId: "sid-mine" });
    seed("not-mine", "%7201", { inProject: otherProject, sessionId: "sid-not-mine" });
    janitor(EMPTY);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /crew teardown: 1 of this project's pane\(s\)/, stdout);
    assert.match(
      stdout,
      /1 further pane\(s\) on that socket died with it, belonging to other projects/,
      "the death crossing projects is the most important fact about these incidents and must survive",
    );
    assert.doesNotMatch(stdout, /not-mine/, `another project's worker must not be named: ${stdout}`);
    assert.doesNotMatch(stdout, /wt-not-mine/, `another project's cwd must not cross the boundary: ${stdout}`);
    assert.doesNotMatch(stdout, /sid-not-mine/, `another project's session id must not cross: ${stdout}`);
  });

  it("is not silenced by an unrelated project starting a crew of its own", async () => {
    reset();
    seed("still-dead", "%7210", { sessionId: "sid-still-dead" });
    janitor(EMPTY);
    seed("neighbours-new-worker", "%7211", { inProject: otherProject, age: "0 seconds", changed: "0 seconds" });

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(
      stdout,
      /still closed and resumable: still-dead/,
      `another project moving on says nothing about this one; got: ${stdout}`,
    );
  });

  it("reports every crew when the settle window splits one death across two records", async () => {
    reset();
    const early = seed("early-bird", "%7220", { sessionId: "sid-early" });
    janitor(EMPTY);
    // The 15s settle window skips a just-spawned row, so the next tick files its own record.
    const late = seed("late-arrival", "%7221", { age: "-60 seconds", sessionId: "sid-late" });
    janitor(EMPTY);

    assert.equal(records().length, 2, "two ticks, two records - the split this pins is real");
    assert.equal(statusOf(early), "closed");
    assert.equal(statusOf(late), "closed");

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /still closed and resumable: early-bird/, `the FIRST record's crew must not vanish: ${stdout}`);
    assert.match(stdout, /still closed and resumable: late-arrival/, `the second record's crew too: ${stdout}`);
  });

  it("goes quiet once a replacement crew has been started", async () => {
    reset();
    seed("ghost2", "%7080");
    janitor(EMPTY);
    seed("the-next-one", "%7081", { age: "0 seconds", changed: "0 seconds" });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(stdout, /crew teardown/, `a record you have already moved past is history, not a warning: ${stdout}`);
  });
});
