import assert from "node:assert/strict";
import { describe, it, after } from "node:test";

import { McpClient, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the todo CLI tests");
after(() => cleanupTmux());

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

    await mcp.call("todo_comment", { todo_id: open.todo_id, body: "a short handoff note" });
    return { open, blocker, blocked, done };
  } finally {
    await mcp.close();
  }
}

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

  it("renders a stored slug bracketed beside the id, and no bracket at all when unset (todo 586)", async () => {
    const dirs = scratchDirs();
    const { open } = await seed(dirs);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      await mcp.call("todo_update", { todo_id: open.todo_id, slug: "the open lane" });
    } finally {
      await mcp.close();
    }

    const { stdout } = await runCli(["todos"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, new RegExp(`#${open.todo_id}\\s+open\\s+\\S*\\s*\\[the open lane\\] Open dispatchable todo`));

    const blockerLine = stdout.split("\n").find((l) => l.includes("Blocker todo"));
    assert.doesNotMatch(blockerLine, /\[/, "a todo with no stored slug must not print a bracketed label");
  });

  it("prints nothing and exits clean in a directory with no hive project (D5)", async () => {
    const dirs = scratchDirs();

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
    await runCli(["pads"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    const { code, stdout } = await runCli(["todos"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(code, 0);
    assert.match(stdout, /No open todos in project/);
    assert.match(stdout, /Try --all/);
  });

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

    const defaultView = await runCli(["todos", "--tag", "issue-16"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.equal(defaultView.code, 0);
    assert.match(defaultView.stdout, /No open todos in project ".*" with tag "issue-16"\. Try --all\./);

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

  it("describes --all correctly in the empty message even when --status is also passed", async () => {
    const dirs = scratchDirs();
    await runCli(["pads"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    const { code, stdout } = await runCli(["todos", "--status", "completed", "--all"], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.equal(code, 0);

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

    assert.match(stdout, /agent:7/);
    assert.match(stdout, /user:/);

    assert.match(stdout, new RegExp("z".repeat(300)));

    const blockingLine = await runCli(["todo", String(blocker.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(blockingLine.stdout, /blocks:/);
    assert.match(blockingLine.stdout, new RegExp(`#${blocked.todo_id}\\b`));
  });

  it("renders a stored slug bracketed beside the id, and no bracket at all when unset (todo 586)", async () => {
    const dirs = scratchDirs();
    const { open, blocker } = await seed(dirs);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      await mcp.call("todo_update", { todo_id: open.todo_id, slug: "the open lane" });
    } finally {
      await mcp.close();
    }

    const labeled = await runCli(["todo", String(open.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(labeled.stdout, new RegExp(`^#${open.todo_id} \\[the open lane\\] Open dispatchable todo`, "m"));

    const bare = await runCli(["todo", String(blocker.todo_id)], {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
    });
    assert.match(bare.stdout, new RegExp(`^#${blocker.todo_id} Blocker todo`, "m"));
    assert.doesNotMatch(
      bare.stdout.split("\n")[0],
      /\[/,
      "a todo with no stored slug must not print a bracketed label on its header line",
    );
  });

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

    assert.match(stdout, /status open.*archived/);

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
