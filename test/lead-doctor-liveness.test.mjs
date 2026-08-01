import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { failureCount, isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

// Issue #27, L4 fix round, DECISION 3's other half: src/scheduler.ts's
// janitor now deliberately never closes a kind='lead' row on its own (see
// ensureLeadRow's comment, src/cli.ts), so a lead whose pane died would
// otherwise sit status='running' forever with nothing saying so. `hive
// doctor` gained the report that used to be the janitor's silent sweep.
//
// Issue #27's L4 fix round R7, todo 171. CI was red on this file from
// 103db7b onward: every test here asserted `out.code === 0`, and a GitHub
// runner installs only node and tmux, never claude, so doctor's own
// `check("claude", ...)` correctly FAILs and doctor correctly exits 1 -
// this is right product behaviour, not a bug. The exact mistake
// test/doctor-profile.test.mjs's own comment already names (counselors
// review on PR #47, finding 2, both seats independently): never assert
// doctor's absolute exit code, compare the failure count relative to a
// baseline taken on the SAME machine instead, via failureCount
// (test/helpers.mjs). Do not "fix" this by downgrading doctor's claude
// check to a warning - hive without claude is genuinely broken, and FAIL is
// the correct level; the bug was this file's assumption, not doctor's
// verdict.

// doctor runs the janitor, which reaches tmux; isolate first (test/CLAUDE.md).
const { hasTmux, cleanup } = isolateTmux("the lead doctor-liveness tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

let projectId;
let session;
let baseline;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
  session = sessionName(projectId);
  // No lead row exists yet - the baseline this file's failure-count deltas
  // are measured against, on whatever this machine's own check outcomes are
  // (claude present or not).
  baseline = await runCli(["doctor"], opts);
});

after(() => cleanup(session));

describe("hive doctor reports a lead row whose pane is not live", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("the no-lead-row baseline itself stays quiet about the lead", () => {
    assert.doesNotMatch(baseline.stdout, /lead:/, "nothing to report without a lead row");
  });

  it("warns when a running lead row's pane is not live", async () => {
    db.prepare(
      "INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, status) VALUES (?, 'lead', 'claude', ?, 'lead', 'lead:1', '%nonexistent-dead-pane', 'running')",
    ).run(projectId, dirs.projectDir);

    const out = await runCli(["doctor"], opts);
    assert.match(
      out.stdout,
      /warn {2}lead: the lead's row is running but its pane is not live/,
      "a dead-paned running lead row must be reported, not silently left alone",
    );
    assert.doesNotMatch(out.stdout, /FAIL {2}stale state/, "the janitor itself must not fail or close it");
    // A warn, not a FAIL: reporting a dead-paned lead must not move the
    // failure count on its own, on a machine that already fails the claude
    // check just as much as one that does not.
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
    // Issue #27's L4 fix round R10, todo 182 item 2 (opus F4). agent_close is
    // an MCP tool, not a `hive` CLI verb; this message used to say
    // "`agent_close` it" as if it were one, sending a human at a bare
    // terminal looking for a subcommand that does not exist.
    assert.match(
      out.stdout,
      /claude session connected to this project's hive MCP server/,
      "the remedy must say where agent_close actually lives, not just name it",
    );

    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  it("warns when a running lead row's tmux_target is EMPTY (todo 180)", async () => {
    // Issue #27's L4 fix round R10, todo 180. Before the fix, targetLive('')
    // read TRUE - tmux resolves an empty target to the CALLER's own current
    // session rather than erroring - so a '' lead row (the exact shape a
    // `hive lead` that dies between its INSERT and its CAS leaves behind,
    // src/cli.ts's ensureLeadRow) read as live forever: this warning never
    // fired, and agent_close refused to retire it.
    db.prepare(
      "INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, status) VALUES (?, 'lead', 'claude', ?, 'lead', 'lead:1', '', 'running')",
    ).run(projectId, dirs.projectDir);

    const out = await runCli(["doctor"], opts);
    assert.match(
      out.stdout,
      /warn {2}lead: the lead's row is running but its pane is not live/,
      "an empty tmux_target must be reported exactly like any other dead pane",
    );
    assert.doesNotMatch(out.stdout, /FAIL {2}stale state/, "the janitor itself must not fail or close it");
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));

    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  it("stays quiet when the lead row's pane is genuinely live", async () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude("sleep 600");
    const first = await runCli(["lead"], {
      ...opts,
      env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
    });
    assert.equal(first.code, 0, first.stderr);

    const out = await runCli(["doctor"], opts);
    assert.doesNotMatch(out.stdout, /lead:/, "a genuinely live lead must not be reported as dead");
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));

    const lead = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND kind = 'lead'").get(projectId);
    execFileSync("tmux", ["kill-window", "-t", lead.tmux_target], { stdio: "ignore" });
  });
});
