import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { McpClient, isolateTmux, liveAgentRow, runCli, scratchDirs } from "./helpers.mjs";

// Issue #63's fix round: agent_spawn's own MCP tools resolve a worker's
// project from its agents-row pin (src/context.ts's agentProjectPin), but
// cmdTodos, cmdTodo and cmdStatusline (src/cli.ts) resolved by cwd alone -
// findProjectForCwd, ignoring the pin entirely. One pane could answer two
// ways: the MCP tools honoring the brief, the CLI commands run in the same
// pane's shell resolving to whatever the cwd happens to be. No test in the
// suite ran any CLI command with a pin set, which is how that was missed.
const { hasTmux, cleanup } = isolateTmux("the CLI project-pin tests");

// Issue #27's L4 fix round R6, todo 170 (counselors opus F6). Needed only by
// the duplicate-actor_id describe block below, which seeds rows directly
// rather than through a real spawn.
const dbDirs = scratchDirs();
process.env.HIVE_DATA_DIR = dbDirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();

// mkdtempSync's prefix argument lands literally in the path, so matching an
// unregistered directory's own path back out of an error message needs
// escaping - the same rule test/spawn-cwd-scope.test.mjs's namedAs() exists
// for.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe(
  "CLI commands consult the same project pin agent_spawn's own tools honor",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const dirs = scratchDirs();
    let mcp;
    let actorId;
    let todoId;

    before(async () => {
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
      await mcp.start();
      const todo = await mcp.call("todo_create", { title: "pinned-project-todo-cli63" });
      todoId = todo.todo_id;
      // A REAL running agents row, via a real spawn - this is the exact row
      // agentProjectPin() looks up, not a hand-inserted stand-in, so it also
      // proves launchAgent's own env (HIVE_AGENT_ID, HIVE_PROJECT_LOCK) is
      // what a CLI command run from that worker's pane would actually see.
      const receipt = await mcp.call("agent_spawn", {
        name: "cli-pin-worker-63",
        command: "sleep",
        extra_args: ["600"],
      });
      actorId = receipt.actor_id;
      await liveAgentRow(mcp, "cli-pin-worker-63");
    });

    after(async () => {
      await mcp.call("agent_close", { name: "cli-pin-worker-63" });
      await mcp.close();
      cleanup();
    });

    // A cwd that names NOTHING, deliberately: findProjectForCwd() alone
    // would return null here (silent, D5), so any output at all is already
    // proof the pin - not the cwd - decided the answer.
    const unregisteredDir = (name) => mkdtempSync(join(dirs.tmp, `unreg-cli63-${name}-`));

    it("hive todos, run from an unregistered cwd carrying the worker's pin, shows the pinned project's todo", async () => {
      const { code, stdout } = await runCli(["todos", "--all"], {
        cwd: unregisteredDir("todos"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      assert.match(stdout, /pinned-project-todo-cli63/);
    });

    it("hive todo <id>, same env, resolves the pinned project's todo detail", async () => {
      const { code, stdout } = await runCli(["todo", String(todoId)], {
        cwd: unregisteredDir("todo"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      assert.match(stdout, /pinned-project-todo-cli63/);
    });

    it("hive statusline, same env, reports the pinned project's state instead of staying silent for the unregistered cwd", async () => {
      const { code, stdout } = await runCli(["statusline"], {
        cwd: unregisteredDir("statusline"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      // cmdStatusline prints nothing for a project with no live state, and
      // nothing at all for no project (its own doc comment) - a plain cwd
      // resolution here would hit exactly that silent path. The pinned
      // project has a running agent (the worker itself) and an open todo,
      // so non-empty output is already proof the pin won.
      assert.notEqual(stdout.trim(), "");
    });

    it("hive todos still resolves by cwd, unaffected, when no pin is set - the control for the three cases above", async () => {
      const { code, stdout } = await runCli(["todos"], {
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: {},
      });
      assert.equal(code, 0);
      assert.match(stdout, /pinned-project-todo-cli63/);
    });

    it("(finding 6) a pinned command run in an unregistered cwd with NO pin set registers no project - the MUST NEVER REGISTER property pinnedOrCwdProject's own comment asserts", async () => {
      // The false-green counselors run 9 found: swap pinnedOrCwdProject's
      // body for `getProject(effectiveProjectId())!` - the REGISTERING
      // version - and every other test in this file stays green, because the
      // pin wins before registration in the first three cases, the fourth
      // case's cwd is already registered, and the fifth still throws. None of
      // them exercise the one case that distinguishes the two functions: an
      // unregistered cwd with no pin at all, where the registering version
      // creates a project and the non-registering one returns null. Assert
      // the count, not the output - a project registering silently is the
      // bug's signature, same rule as (m) in spawn-cwd-scope.test.mjs.
      const before = (await mcp.call("project_list")).projects.length;
      const { code, stdout } = await runCli(["todos"], {
        cwd: unregisteredDir("finding6"),
        dataDir: dirs.dataDir,
        env: {},
      });
      assert.equal(code, 0);
      assert.equal(stdout.trim(), "");
      const after = (await mcp.call("project_list")).projects.length;
      assert.equal(after, before);
    });

    it("a bad pin (row missing) prints a clean message, not a raw node stack trace, and exits non-zero", async () => {
      const { code, stdout, stderr } = await runCli(["todos"], {
        cwd: unregisteredDir("badpin"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "agent:cli63-missing", HIVE_PROJECT_LOCK: "1" },
      });
      assert.notEqual(code, 0);
      assert.match(stdout, /names no agents row/);
      // (finding 4) "restart it" is not an actionable remedy here: HIVE_AGENT_ID
      // and HIVE_PROJECT_LOCK live in the pane's own env (tmux -e), not the
      // process's, and survive a restart in the same pane. The message must
      // name the env to unset, or this failure has no escape a human can act
      // on from inside the pane that hit it.
      assert.match(stdout, /unset HIVE_AGENT_ID/);
      // A raw uncaught exception prints its own trace to stderr with these
      // markers; their absence is what "clean message" actually means here,
      // not just that stdout also happened to carry a nicer string.
      // IMMUNE to generated data, and more strongly than that: cmdTodos's
      // bad-pin path throws out of agentProjectPin() before ever reaching
      // resolveProjectAndNotify (src/cli.ts), the ONLY call site that writes
      // to stderr for a CLI command (a registration notice, which is the one
      // place a generated project path can land in output at all) - so
      // stderr here is always the empty string, not merely a string these
      // four alternates happen not to match. A future caller that reaches
      // this assertion through a path where stderr is non-empty would
      // inherit an unexamined assumption, not a bug this comment already
      // covers.
      assert.doesNotMatch(stderr, /at Object|at process|node:internal|Error:\s*\n\s*at /);
    });

    it("(finding 3) hive statusline stays silent and exits 0 on a bad pin, honoring its own 'prints nothing' contract", async () => {
      // cmdStatusline's own doc comment: "Prints nothing outside a registered
      // project... status lines run in every directory a session opens." A
      // status line redraws on every prompt, so the same loud failure that is
      // correct for `hive todos` (a human runs it once, on purpose) would
      // print the pin error on every single render if it reached here
      // unguarded.
      const { code, stdout, stderr } = await runCli(["statusline"], {
        cwd: unregisteredDir("statusline-badpin"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "agent:cli63-missing-statusline", HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 0);
      assert.equal(stdout.trim(), "");
      assert.equal(stderr.trim(), "");
    });

    it("(finding 2a) a path argument matching the pin is a no-op - a locked session still resolves the same project it was already going to", async () => {
      // cwd is deliberately NOT the pinned project, so a pass here proves the
      // PATH argument (not cwd) drove the resolution. Asserting on the
      // "no profile" message rather than exit code alone: a wrongly-always-
      // refusing implementation would also exit 1, so the message text -
      // "no profile" and not "locked to project" - is what actually
      // distinguishes "reached normal resolution" from "refused".
      const { code, stdout } = await runCli(["runbook", dirs.projectDir], {
        cwd: unregisteredDir("finding2a-cwd"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.equal(code, 1);
      assert.match(stdout, /This project has no profile/);
      assert.doesNotMatch(stdout, /locked to project/);
    });

    it("(finding 2b) a path argument that disagrees with the pin REFUSES, naming both, and registers no project", async () => {
      // The false-green shape this shares with finding 1 and finding 6:
      // refusing is only half proven without checking that the refusal
      // branch didn't register a project for the path on its way to
      // refusing. Assert the count, not just the throw.
      const before = (await mcp.call("project_list")).projects.length;
      const elsewhere = unregisteredDir("finding2b");
      const { code, stdout } = await runCli(["runbook", elsewhere], {
        cwd: unregisteredDir("finding2b-cwd"),
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
      });
      assert.notEqual(code, 0);
      assert.match(stdout, /locked to project \d+/);
      assert.match(stdout, new RegExp(escapeRegex(elsewhere)));
      assert.match(stdout, /no registered project/);
      assert.match(stdout, /Unset HIVE_AGENT_ID and HIVE_PROJECT_LOCK/);
      const after = (await mcp.call("project_list")).projects.length;
      assert.equal(after, before);
    });

    it("(finding 2c) control: an UNLOCKED session with a path argument is unaffected - it still registers an unregistered path exactly as before", async () => {
      // Proves the change is scoped to locked sessions: without this, a fix
      // that accidentally made resolveProject refuse or no-op for EVERY path
      // argument (not just a locked, disagreeing one) would pass 2a/2b and
      // still be wrong.
      const before = (await mcp.call("project_list")).projects.length;
      const fresh = unregisteredDir("finding2c");
      const { code, stdout } = await runCli(["runbook", fresh], {
        cwd: unregisteredDir("finding2c-cwd"),
        dataDir: dirs.dataDir,
        env: {},
      });
      assert.equal(code, 1);
      assert.match(stdout, /This project has no profile/);
      const after = (await mcp.call("project_list")).projects.length;
      assert.equal(after, before + 1);
    });
  },
);

// Issue #27's L4 fix round R6, todo 170 (counselors opus F6). Decision 2's
// closed-row actor_id reuse (the lead's own identity-survives-a-restart
// mechanism) means actor_id stopped being unique across agents ROWS: one
// closed row and one running row can now legitimately share it.
// agentProjectPin's SELECT had no ORDER BY, so which row's project_id it
// returned was whatever SQLite's query plan reached first - unreachable for
// a lead TODAY only because a lead's own env carries no HIVE_PROJECT_LOCK=1
// (todo 167 in this same round), but the mechanism (two rows, one actor_id)
// is real and this guard should not depend on that staying true.
describe("agentProjectPin resolves the RUNNING row when actor_id names two (issue #27's L4 fix round R6, todo 170)", () => {
  it("returns the running row's project, not a closed row sharing the same actor_id", async () => {
    const actorId = "dup-actor-170";
    const closedProject = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("dup-actor-closed-project", mkdtempSync(join(dbDirs.tmp, "dup-actor-closed-")));
    const runningProject = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("dup-actor-running-project", mkdtempSync(join(dbDirs.tmp, "dup-actor-running-")));
    // Lower rowid, closed - exactly the row a bare `.get()` with no ORDER BY
    // tends to reach first in practice, per the finding.
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'closed-half', '', 'sleep', '/tmp', 'agent', 'closed')`,
    ).run(closedProject.id, actorId);
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, 'running-half', '', 'sleep', '/tmp', 'agent', 'running')`,
    ).run(runningProject.id, actorId);
    db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'closed-project-todo-170')").run(closedProject.id);
    db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'running-project-todo-170')").run(runningProject.id);

    const unregisteredCwd = mkdtempSync(join(dbDirs.tmp, "dup-actor-cwd-"));
    const { code, stdout } = await runCli(["todos", "--all"], {
      cwd: unregisteredCwd,
      dataDir: dbDirs.dataDir,
      env: { HIVE_AGENT_ID: actorId, HIVE_PROJECT_LOCK: "1" },
    });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /running-project-todo-170/, "must resolve to the RUNNING row's project");
    // IMMUNE to generated data: "closed-project-todo-170" is a hard-coded
    // literal this test itself INSERTed as the todo's title two lines above
    // it, not a scratch path or any other value hive generated. It can only
    // appear in stdout by naming the actual todo it identifies, which is
    // exactly the regression this line exists to catch.
    assert.doesNotMatch(stdout, /closed-project-todo-170/, "must not resolve to the closed row's project");
  });
});
