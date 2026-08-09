import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

import { McpClient, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
const { cleanup: cleanupTmux } = isolateTmux("the todo CLI tests");
after(() => cleanupTmux());

// Issue #16: hive todos / hive todo <id>. Data is seeded through the real MCP
// tools (todo_create/todo_update/todo_block/todo_comment), not raw SQL,
// so these tests exercise the actual write path the CLI's shared helpers
// (listTodoSummaries, getTodoDetail) then read back.
async function seed(dirs) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  try {
    const open = await mcp.call("todo_create", {
      title: "Open dispatchable todo",
      body: "the open todo's body",
      tags: ["issue-16"],
    });
    const blocker = await mcp.call("todo_create", { title: "Blocker todo" });
    const blocked = await mcp.call("todo_create", {
      title: "Blocked todo",
      tags: ["issue-5"],
    });
    await mcp.call("todo_block", { todo_id: blocked.todo_id, blocker_id: blocker.todo_id });
    const done = await mcp.call("todo_create", { title: "Completed todo" });
    await mcp.call("todo_update", { todo_id: done.todo_id, status: "completed" });

    // Two distinct actors on the same todo (D4), one comment long enough
    // that truncation at any fixed width would be visible (D6).
    await mcp.call("todo_comment", { todo_id: open.todo_id, body: "a short handoff note" });
    return { open, blocker, blocked, done };
  } finally {
    await mcp.close();
  }
}

// F1: every fixture above tops out at four todos, far short of
// listTodoSummaries' default limit of 50, so no test built on `seed()` can
// ever reach the truncation path. A fixture has to exceed the limit on
// purpose to test that a bound is reported rather than silently applied.
async function seedMany(dirs, count) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  try {
    for (let i = 0; i < count; i++) {
      await mcp.call("todo_create", { title: `many-${String(i).padStart(3, "0")}` });
    }
  } finally {
    await mcp.close();
  }
}

async function seedLongComment(dirs, todoId) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: "agent:7" } });
  await mcp.start();
  try {
    await mcp.call("todo_comment", { todo_id: todoId, body: "z".repeat(300) });
  } finally {
    await mcp.close();
  }
}

describe("hive todos", () => {
  it("defaults to open work, marks the blocked one, and leaves completed work out", async () => {
    const dirs = scratchDirs();
    await seed(dirs);

    const { code, stdout } = await runCli(["todos"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    assert.match(stdout, /Open dispatchable todo/);
    assert.match(stdout, /Blocked todo/);
    // The negative is the assertion that actually pins filtering: a command
    // that printed every todo regardless of status would still match the two
    // greps above.
    assert.doesNotMatch(stdout, /Completed todo/);

    const blockedLine = stdout.split("\n").find((l) => l.includes("Blocked todo"));
    const openLine = stdout.split("\n").find((l) => l.includes("Open dispatchable todo"));
    assert.match(blockedLine, /blocked/);
    assert.doesNotMatch(openLine, /blocked/);
  });

  it("--all includes completed work", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { stdout } = await runCli(["todos", "--all"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /Completed todo/);
    assert.match(stdout, /Open dispatchable todo/);
  });

  // #15: hive pads has no flag to surface an archived pad at all
  // (listActivePads is hardcoded to archived = 0) - hive todos follows the
  // same precedent. --all widens which STATUSES are shown; it does not
  // reach into archived_at, which stays MCP-only (todo_list's
  // include_archived), same as pad_list's own parameter.
  it("--all still excludes an archived todo, matching hive pads' own precedent", async () => {
    const dirs = scratchDirs();
    const { open } = await seed(dirs);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      await mcp.call("todo_archive", { todo_id: open.todo_id });
    } finally {
      await mcp.close();
    }

    const { stdout } = await runCli(["todos", "--all"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.doesNotMatch(stdout, /Open dispatchable todo/);
    // Counselors round on #15: "Blocked todo" alone as a positive control
    // would still pass if --all dropped every unblocked, active todo (a
    // much bigger bug than this test claims to guard). "Blocker todo" is
    // unblocked and was never archived, and "Completed todo" is only
    // visible under --all at all - both must still show.
    assert.match(stdout, /Blocker todo/);
    assert.match(stdout, /Blocked todo/);
    assert.match(stdout, /Completed todo/);
  });

  it("--status filters to exactly that status", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { stdout } = await runCli(["todos", "--status", "completed"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(stdout, /Completed todo/);
    assert.doesNotMatch(stdout, /Open dispatchable todo/);
    assert.doesNotMatch(stdout, /Blocked todo/);
  });

  it("--tag filters to one lane and excludes the rest", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { stdout } = await runCli(["todos", "--tag", "issue-5"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(stdout, /Blocked todo/);
    assert.doesNotMatch(stdout, /Open dispatchable todo/);
  });

  it("--all wins over --status when both are passed, rather than depending on argv order", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const first = await runCli(["todos", "--all", "--status", "completed"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    const second = await runCli(["todos", "--status", "completed", "--all"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    for (const { stdout } of [first, second]) {
      assert.match(stdout, /Open dispatchable todo/);
      assert.match(stdout, /Completed todo/);
      assert.match(stdout, /Blocked todo/);
    }
  });

  it("prints nothing and exits clean in a directory with no hive project (D5)", async () => {
    const dirs = scratchDirs();
    // No prior command has run here, so no project has ever been registered;
    // resolveProject() would silently create one, which is exactly the
    // behaviour D5 says to avoid.
    const { code, stdout, stderr } = await runCli(["todos"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });

  it("names what it did not show rather than truncating silently past the default limit", async () => {
    const dirs = scratchDirs();
    await seedMany(dirs, 55);
    const { code, stdout } = await runCli(["todos", "--all"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    const shown = stdout.split("\n").filter((l) => l.includes("many-")).length;
    // 50 is listTodoSummaries' own default limit, hard-coded here on
    // purpose: today's real behaviour is worth pinning, and a change to that
    // default should make this test fail loudly rather than quietly track it.
    assert.equal(shown, 50, `expected exactly 50 rows shown, got:\n${stdout}`);
    assert.match(stdout, /\.\.\.and 5 more not shown/);
  });

  it("rejects an unknown --status by name rather than reading as an empty result", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { code, stdout } = await runCli(["todos", "--status", "bogus"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.equal(code, 1);
    assert.match(stdout, /Unknown status "bogus"/);
    // The exact failure this test guards against: a broken implementation
    // that just filters on an unrecognized value would print this instead.
    assert.doesNotMatch(stdout, /No todos in project/);
  });

  it("rejects --status with no value rather than silently falling back to the default view", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { code, stdout } = await runCli(["todos", "--status"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 1);
    assert.match(stdout, /Usage: hive todos --status/);
    assert.doesNotMatch(stdout, /Open dispatchable todo/);
  });

  // F3: the same missing-value bug as --status, one flag over. Unlike
  // --status, an unrecognized --tag value is never an error (any string is a
  // legitimate tag, and "nothing carries it" is a real empty result), so only
  // the missing-value case needs a guard here.
  it("rejects --tag with no value rather than silently falling back to the default view", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { code, stdout } = await runCli(["todos", "--tag"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 1);
    assert.match(stdout, /Usage: hive todos --tag/);
    assert.doesNotMatch(stdout, /Open dispatchable todo/);
  });

  it("says so, cleanly, in a project with no todos", async () => {
    const dirs = scratchDirs();
    await runCli(["pads"], { cwd: dirs.projectDir, dataDir: dirs.dataDir }); // registers the project
    const { code, stdout } = await runCli(["todos"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    assert.match(stdout, /No open todos in project/);
    assert.match(stdout, /Try --all/);
  });

  // F4: the runbook's own convention (step 13) tags every lane's todos
  // issue-<N> so a FINISHED lane is easy to retrieve, and a finished lane is
  // by definition all-completed. So the default open/in_progress filter
  // hides exactly the todos that convention exists to make findable, and the
  // empty message has to say what it filtered on, not just name the project,
  // or "no todos" reads as false for a lane that is very much still there.
  it("names the filter in the empty case rather than flatly claiming the project has none", async () => {
    const dirs = scratchDirs();
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    let done;
    try {
      done = await mcp.call("todo_create", { title: "finished lane work", tags: ["issue-16"] });
      await mcp.call("todo_update", { todo_id: done.todo_id, status: "completed" });
    } finally {
      await mcp.close();
    }

    // The default view hides it: this is the exact false-negative the runbook's
    // tagging convention would hit on every completed lane.
    const defaultView = await runCli(["todos", "--tag", "issue-16"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(defaultView.code, 0);
    assert.match(defaultView.stdout, /No open todos in project ".*" with tag "issue-16"\. Try --all\./);

    // --all proves the todo genuinely exists and filtering itself is correct;
    // only the empty-view message was wrong.
    const allView = await runCli(["todos", "--all", "--tag", "issue-16"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(allView.stdout, /finished lane work/);

    const wrongStatus = await runCli(["todos", "--status", "open", "--tag", "issue-16"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(wrongStatus.stdout, /No open todos in project ".*" with tag "issue-16"\./);
  });

  // Caught by the automated review on commit 2ee8452: the empty message's
  // statusDesc checked `status` before `all`, so `--status --all` together
  // described a narrower filter ("completed") than the one that actually ran
  // (--all wins, so every status was searched). The real query already got
  // this precedence right; only the message computed it backwards.
  it("describes --all correctly in the empty message even when --status is also passed", async () => {
    const dirs = scratchDirs();
    await runCli(["pads"], { cwd: dirs.projectDir, dataDir: dirs.dataDir }); // registers the project, no todos
    const { code, stdout } = await runCli(["todos", "--status", "completed", "--all"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.equal(code, 0);
    // Must NOT narrate "completed" only: --all means every status was
    // actually searched, so the message must not name one narrower than that.
    // IMMUNE to generated data, but not "plainly": the message DOES carry a
    // generated value (project.name, basename() of scratchDirs()'
    // mkdtemp-random projectDir - e.g. "project-wBTbTT"). It cannot produce
    // this match only because of WHERE it lands: cmdTodos always writes
    // `No ${statusDesc}todos in project "${project.name}"...`, and this
    // whole test's premise is statusDesc === "" when --all wins, so the
    // random name sits after the fixed "todos in project \"" delimiter and
    // can never fuse with "No " to spell "No completed todos". A future
    // caller that moved the project name BEFORE statusDesc, or dropped the
    // delimiter between them, would inherit this exact bug.
    assert.doesNotMatch(stdout, /No completed todos/);
    assert.match(stdout, /No todos in project/);
  });
});

describe("hive todo <id>", () => {
  it("prints the full detail: body, blockers, blocking, and every comment untruncated with actor attribution", async () => {
    const dirs = scratchDirs();
    const { open, blocker, blocked } = await seed(dirs);
    await seedLongComment(dirs, open.todo_id);

    const { code, stdout } = await runCli(["todo", String(open.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.equal(code, 0);
    assert.match(stdout, /Open dispatchable todo/);
    assert.match(stdout, /the open todo's body/);
    // D4: a reader must be able to tell the lead's notes from a worker's.
    assert.match(stdout, /agent:7/);
    assert.match(stdout, /user:/);
    // D6: the whole point of this command is that comments are not cut off.
    // A test only checking that the comment appears at all would pass for a
    // command that truncates at, say, 200 chars; assert the full length.
    assert.match(stdout, new RegExp("z".repeat(300)));

    const blockingLine = await runCli(["todo", String(blocker.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(blockingLine.stdout, /blocks:/);
    assert.match(blockingLine.stdout, new RegExp(`#${blocked.todo_id}\\b`));
  });

  // #15: todo_get (and cmdTodo, its CLI wrapper) always reaches an archived
  // todo by id - that is the whole reason this is archive and not delete.
  it("still reaches an archived todo by id, hidden from hive todos as it is, and says so", async () => {
    const dirs = scratchDirs();
    const { open, blocker } = await seed(dirs);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      await mcp.call("todo_archive", { todo_id: open.todo_id });
    } finally {
      await mcp.close();
    }

    const { code, stdout } = await runCli(["todo", String(open.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.equal(code, 0);
    assert.match(stdout, /Open dispatchable todo/);
    assert.match(stdout, /the open todo's body/);
    // Counselors round on #15, P2: MCP todo_get exposes the archived axis;
    // the CLI was silently dropping it, so an archived open todo rendered
    // identically to an active one.
    assert.match(stdout, /status open.*archived/);

    // Positive control: an ordinary, un-archived todo must not print the
    // marker at all - a status line that always says "archived" would
    // still pass the assertion above.
    const active = await runCli(["todo", String(blocker.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.doesNotMatch(active.stdout, /archived/);
  });

  it("exits 1 with a usage line for an unknown id", async () => {
    const dirs = scratchDirs();
    await seed(dirs);
    const { code, stdout } = await runCli(["todo", "99999"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 1);
    assert.match(stdout, /No todo with id 99999/);
  });

  it("exits 1 with a usage line when no id is given", async () => {
    const dirs = scratchDirs();
    await runCli(["pads"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    const { code, stdout } = await runCli(["todo"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 1);
    assert.match(stdout, /Usage: hive todo/);
  });

  it("prints nothing and exits clean in a directory with no hive project (D5)", async () => {
    const dirs = scratchDirs();
    const { code, stdout, stderr } = await runCli(["todo", "1"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
  });
});
