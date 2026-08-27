import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { firedSessionStart as fired, KICKOFF, McpClient, isolateTmux, runCli, runNode, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the kickoff tests");
after(() => cleanupTmux());

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const kickoff = (args = [], o = opts) => runNode(KICKOFF, args, o);

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "gpg.format=openpgp", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

const yml = (body, dir = dirs.projectDir) => writeFileSync(join(dir, "hive.yml"), body);

describe("the 'gone' negative assertion itself", () => {
  const CONTEXT_WITH_GONE_IN_THE_CWD_PATH =
    "WORKERS (per the store, NOT probed; agent_list to confirm they are alive)\n" +
    "  seeded [unknown (no record)] /private/tmp/hive-test-abgone/project-xyz123\n";

  it("ignores 'gone' inside the cwd path, which is what a scratch dir's random suffix can produce", () => {
    assert.match(CONTEXT_WITH_GONE_IN_THE_CWD_PATH, /gone/, "the old assertion really did match this");
    assert.doesNotMatch(CONTEXT_WITH_GONE_IN_THE_CWD_PATH, /seeded \[[^\]]*gone/);
  });

  it("still catches a real 'gone' state inside the bracket", () => {
    const withRealGone = "  seeded [gone] /private/tmp/hive-test-xxxxxx/project-yyyyyy\n";
    assert.match(withRealGone, /seeded \[[^\]]*gone/);
  });
});

describe("hive kickoff gates", () => {
  before(async () => {
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("says nothing in a directory with no hive.yml", async () => {
    const { code, stdout } = await kickoff(["--explain"], { ...opts, cwd: dirs.tmp });
    assert.equal(code, 0);
    assert.match(stdout, /silent \(no hive\.yml here\)/);
  });

  it("does not open a store for a directory it declines", async () => {

    const untouched = join(dirs.tmp, "no-store");
    mkdirSync(untouched, { recursive: true });
    const dataDir = join(untouched, "data");
    const { code } = await kickoff([], { ...opts, cwd: untouched, dataDir });
    assert.equal(code, 0);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(dataDir), false, "declining must not create the data dir");
  });

  it("says nothing when hive.yml names no profile", async () => {
    yml("placement: split\n");
    assert.match((await kickoff(["--explain"])).stdout, /silent \(no profile in hive\.yml\)/);
  });

  it("says nothing when the project chose profile: none", async () => {
    yml("profile: none\n");
    assert.match((await kickoff(["--explain"])).stdout, /silent \(no profile in hive\.yml\)/);
  });

  it("says nothing when the profile is not on this machine", async () => {

    yml("profile: chris-only\n");
    const { code, stdout } = await kickoff(["--explain"]);
    assert.equal(code, 0);
    assert.match(stdout, /silent \(profile "chris-only" is not on this machine\)/);
  });

  it("says nothing in a hive-spawned worker session", async () => {
    yml("profile: orchestration\n");
    const { stdout } = await kickoff(["--explain"], { ...opts, env: { HIVE_AGENT_ID: "agent:7" } });
    assert.match(stdout, /silent \(worker session/);
  });

  it("says nothing below the project root", async () => {
    const sub = join(dirs.projectDir, "packages", "api");
    mkdirSync(sub, { recursive: true });
    yml("profile: orchestration\n", sub);
    const { stdout } = await kickoff(["--explain"], { ...opts, cwd: sub });
    assert.match(stdout, /silent \(not a registered hive project root\)/);
  });

  it("fires on a lead checkout", async () => {
    yml("profile: orchestration\n");
    const { code, stdout } = await kickoff();
    assert.equal(code, 0);
    const out = fired(stdout);
    assert.match(out.additionalContext, /\[hive\] Project/);
    assert.match(out.additionalContext, /profile: orchestration/);
    assert.match(out.additionalContext, /BOARD/);
    assert.match(out.additionalContext, /hive runbook/);
    assert.match(out.initialUserMessage, /triage/i);
  });

  it("omits initialUserMessage for --codex, unlike the claude payload, because codex's SessionStart schema rejects the whole hook payload when that key is present (todo 567 comment 1864)", async () => {
    yml("profile: orchestration\n");

    const claudePayload = fired((await kickoff()).stdout);
    assert.ok(
      Object.hasOwn(claudePayload, "initialUserMessage"),
      "the claude payload must still carry initialUserMessage",
    );
    assert.match(claudePayload.initialUserMessage, /triage/i);

    const { code, stdout } = await kickoff(["--codex"]);
    assert.equal(code, 0);
    const codexPayload = fired(stdout);
    assert.match(codexPayload.additionalContext, /\[hive\] Project/, "the board must still reach a codex lead");
    assert.equal(
      Object.hasOwn(codexPayload, "initialUserMessage"),
      false,
      "initialUserMessage must be ABSENT, not just falsy - present-but-empty would still trip codex's " +
        "additionalProperties:false schema and silently drop the whole payload",
    );
  });

  it("still fires on a lead checkout once the lead carries HIVE_AGENT_ID too", async () => {

    yml("profile: orchestration\n");
    const { code, stdout } = await kickoff([], {
      ...opts,
      env: { HIVE_AGENT_ID: "lead:1", HIVE_LEAD: "1" },
    });
    assert.equal(code, 0);
    const out = fired(stdout);
    assert.match(out.additionalContext, /\[hive\] Project/);
    assert.match(out.additionalContext, /BOARD/);
    assert.match(out.initialUserMessage, /triage/i);
  });

  it("still says nothing for a worker whose HIVE_LEAD is set but not \"1\"", async () => {
    yml("profile: orchestration\n");
    const { stdout } = await kickoff(["--explain"], {
      ...opts,
      env: { HIVE_AGENT_ID: "agent:7", HIVE_LEAD: "0" },
    });
    assert.match(stdout, /silent \(worker session/);
  });

  it("reports live state: in-flight, ready, blocked, and wake-ups", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      const working = await mcp.call("todo_create", { title: "wire the parser" });
      await mcp.call("todo_update", { todo_id: working.todo_id, status: "in_progress" });
      const blocker = await mcp.call("todo_create", { title: "land the schema" });
      const blocked = await mcp.call("todo_create", { title: "depends on schema" });
      await mcp.call("todo_block", { todo_id: blocked.todo_id, blocker_id: blocker.todo_id });
    } finally {
      await mcp.close();
    }

    const { additionalContext } = fired((await kickoff()).stdout);
    assert.match(additionalContext, /IN FLIGHT/);
    assert.match(additionalContext, /wire the parser/);
    assert.match(additionalContext, /READY/);
    assert.match(additionalContext, /land the schema/);
    assert.match(additionalContext, /BLOCKED: 1 todo/);
    assert.doesNotMatch(additionalContext, /depends on schema/, "a blocked todo is not dispatchable work");
  });

  it("renders a stored slug beside the id in IN FLIGHT and READY, and shows only the title when unset (todo 586)", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    let labeled;
    let bare;
    try {
      labeled = await mcp.call("todo_create", { title: "wire the schema parser end to end" });
      await mcp.call("todo_update", { todo_id: labeled.todo_id, status: "in_progress", slug: "wire the parser" });
      bare = await mcp.call("todo_create", { title: "an unlabeled ready todo" });
    } finally {
      await mcp.close();
    }

    const { additionalContext } = fired((await kickoff()).stdout);
    assert.match(
      additionalContext,
      new RegExp(`#${labeled.todo_id} \\[wire the parser\\] wire the schema parser end to end`),
    );
    assert.match(additionalContext, new RegExp(`#${bare.todo_id} an unlabeled ready todo`));
    assert.doesNotMatch(
      additionalContext,
      new RegExp(`#${bare.todo_id} \\[`),
      "a todo with no stored slug must not get a bracketed label at all",
    );
  });

  it("keeps an archived todo out of IN FLIGHT and READY, and drops it from the BLOCKED count", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    let blockedId;
    try {
      const inFlight = await mcp.call("todo_create", { title: "archived in-flight lane" });
      await mcp.call("todo_update", { todo_id: inFlight.todo_id, status: "in_progress" });
      await mcp.call("todo_archive", { todo_id: inFlight.todo_id });

      const ready = await mcp.call("todo_create", { title: "archived ready lane" });
      await mcp.call("todo_archive", { todo_id: ready.todo_id });

      const blocker = await mcp.call("todo_create", { title: "archived-away blocker" });
      const blocked = await mcp.call("todo_create", { title: "archived blocked lane" });
      blockedId = blocked.todo_id;
      await mcp.call("todo_block", { todo_id: blocked.todo_id, blocker_id: blocker.todo_id });
    } finally {
      await mcp.close();
    }

    const before = fired((await kickoff()).stdout).additionalContext;
    assert.doesNotMatch(before, /archived in-flight lane/);
    assert.doesNotMatch(before, /archived ready lane/);
    const beforeCount = Number(/BLOCKED: (\d+) todo/.exec(before)?.[1] ?? 0);
    assert.ok(beforeCount >= 1, "the freshly-created, still-active blocked todo must be counted before archiving it");

    const mcp2 = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp2.start();
    try {
      await mcp2.call("todo_archive", { todo_id: blockedId });
    } finally {
      await mcp2.close();
    }

    const after = fired((await kickoff()).stdout).additionalContext;
    const afterCount = Number(/BLOCKED: (\d+) todo/.exec(after)?.[1] ?? 0);
    assert.equal(afterCount, beforeCount - 1, "archiving the blocked dependent must drop the BLOCKED count by exactly one");
  });

  it("names parked lanes, which no other line in the digest can see", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {

      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
             closed_at, parked_at, parked_branch)
           VALUES (?, 'agent:901', 'parked-lane', '', 'claude', ?, 'agent', 'closed',
             datetime('now'), datetime('now'), 'some-branch')`,
        )
        .run(projectId, dirs.projectDir);
      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, closed_at)
           VALUES (?, 'agent:902', 'finished-lane', '', 'claude', ?, 'agent', 'closed', datetime('now'))`,
        )
        .run(projectId, dirs.projectDir);
    } finally {
      store.close();
    }

    const { additionalContext } = fired((await kickoff()).stdout);
    assert.match(additionalContext, /PARKED: 1 lane\(s\)/, "one parked lane, not two closed rows");
    assert.match(additionalContext, /hive status/, "and it points at where the resume call actually is");
  });

  it("heads WORKERS as unprobed, not confirmed", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {
      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'agent:900', 'seeded', '%1', 'claude', ?, 'agent', 'running')`,
        )
        .run(projectId, dirs.projectDir);
    } finally {
      store.close();
    }

    const { additionalContext } = fired((await kickoff()).stdout);
    assert.match(additionalContext, /WORKERS \(per the store, NOT probed; agent_list to confirm they are alive\)/);
    assert.doesNotMatch(additionalContext, /agent_list confirms they are alive/);
    assert.match(additionalContext, /seeded/);

    assert.doesNotMatch(additionalContext, /seeded \[[^\]]*gone/);

    assert.match(additionalContext, /seeded \[unknown \(no record\)\]/);
  });

  it("says a worker awaiting its first assignment has not been given anything", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {

      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status,
             agent_state, state_changed_at, resumed_at)
           VALUES (?, 'agent:903', 'unbriefed', '%3', 'claude', ?, 'agent', 'running',
             'idle', datetime('now'), datetime('now'))`,
        )
        .run(projectId, dirs.projectDir);
      store
        .prepare(
          "INSERT INTO agent_state_log (actor_id, event, state, payload) VALUES ('agent:903', 'stop', 'idle', '{}')",
        )
        .run();
    } finally {
      store.close();
    }

    const { additionalContext } = fired((await kickoff()).stdout);
    assert.match(
      additionalContext,
      /unbriefed \[idle \(no assignment yet[^\]]*\)\]/,
      "the digest must say this worker has not been given anything",
    );

    assert.doesNotMatch(additionalContext, /unbriefed \[idle \(stop/);
  });

  it("excludes the lead's own row from WORKERS", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    const projectId = (await mcp.call("whoami")).project.id;
    await mcp.close();

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {
      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'agent:901', 'a-real-worker', '%2', 'claude', ?, 'agent', 'running')`,
        )
        .run(projectId, dirs.projectDir);
      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'lead:901', 'the-lead-itself', '%3', 'claude', ?, 'lead', 'running')`,
        )
        .run(projectId, dirs.projectDir);
    } finally {
      store.close();
    }

    const { additionalContext } = fired((await kickoff()).stdout);
    assert.match(additionalContext, /a-real-worker/, "the worker row must still render");

    assert.doesNotMatch(additionalContext, /the-lead-itself/, "the lead's own row must not appear as a worker");
  });

  it("stays inside the 10,000 character hook output cap", async () => {
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    try {
      const board = await mcp.call("pad_read", { name: "board" });
      await mcp.call("pad_write", {
        name: "board",
        pad_id: board.pad_id,
        content: `TODAY\n${"lane detail that nobody trimmed. ".repeat(2000)}`,
        expected_revision: board.revision,
      });
    } finally {
      await mcp.close();
    }

    const { stdout } = await kickoff();
    assert.ok(stdout.length < 10_000, `hook output must stay under the cap, got ${stdout.length}`);
    const out = fired(stdout);
    assert.match(out.additionalContext, /\[truncated\]/);

    assert.match(out.additionalContext, /IN FLIGHT/);
    assert.match(out.additionalContext, /hive runbook/);
  });
});

describe("hive kickoff hive.yml warnings", () => {
  const warned = scratchDirs();
  const warnedOpts = { cwd: warned.projectDir, dataDir: warned.dataDir, tmp: warned.tmp };
  const warnedYml = (body) => writeFileSync(join(warned.projectDir, "hive.yml"), body);

  const BROKEN = "profile: orchestration\nlayout: main-verticle\n";

  before(async () => {
    warnedYml(BROKEN);
    const init = await runCli(["init"], warnedOpts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("puts them in the digest, above the board", async () => {
    const { additionalContext } = fired((await runNode(KICKOFF, [], warnedOpts)).stdout);
    assert.match(additionalContext, /^! hive\.yml: layout must be one of/m);
    assert.ok(
      additionalContext.indexOf("! hive.yml:") < additionalContext.indexOf("BOARD"),
      "a warning below the board is the first thing a long board truncates away",
    );
  });

  it("keeps them when a long board fills the budget", async () => {
    const mcp = new McpClient({ cwd: warned.projectDir, dataDir: warned.dataDir });
    await mcp.start();
    try {
      const board = await mcp.call("pad_read", { name: "board" });
      await mcp.call("pad_write", {
        name: "board",
        pad_id: board.pad_id,
        content: `TODAY\n${"lane detail that nobody trimmed. ".repeat(2000)}`,
        expected_revision: board.revision,
      });
    } finally {
      await mcp.close();
    }

    const { stdout } = await runNode(KICKOFF, [], warnedOpts);
    const { additionalContext } = fired(stdout);
    assert.match(additionalContext, /\[truncated\]/, "the board must actually be hitting the cap");
    assert.match(additionalContext, /! hive\.yml: layout must be one of/);
  });

  it("still says the store is empty when a warning sits above it", async () => {
    const empty = scratchDirs();
    const emptyOpts = { cwd: empty.projectDir, dataDir: empty.dataDir, tmp: empty.tmp };
    writeFileSync(join(empty.projectDir, "hive.yml"), BROKEN);

    const mcp = new McpClient({ cwd: empty.projectDir, dataDir: empty.dataDir });
    await mcp.start();
    await mcp.call("whoami");
    await mcp.close();

    const { additionalContext } = fired((await runNode(KICKOFF, [], emptyOpts)).stdout);
    assert.match(additionalContext, /! hive\.yml: layout must be one of/);
    assert.match(additionalContext, /The store is empty for this project/);
  });

  it("reports them on --explain even when the kickoff declines", async () => {

    warnedYml("layout: main-verticle\n");
    const { code, stdout } = await runNode(KICKOFF, ["--explain"], warnedOpts);
    assert.equal(code, 0);
    assert.match(stdout, /! hive\.yml: layout must be one of/);
    assert.match(stdout, /silent \(no profile in hive\.yml\)/);
  });

  it("stays silent about a hive.yml it never parsed", async () => {
    const { stdout } = await runNode(KICKOFF, ["--explain"], { ...warnedOpts, cwd: warned.tmp });
    assert.match(stdout, /silent \(no hive\.yml here\)/);
    assert.doesNotMatch(stdout, /hive\.yml:/);
  });
});

describe("hive kickoff branch gate", () => {
  const repo = scratchDirs();
  const repoOpts = { cwd: repo.projectDir, dataDir: repo.dataDir, tmp: repo.tmp };

  before(async () => {
    git(repo.projectDir, "init", "-b", "feature/parser");
    git(repo.projectDir, "commit", "--allow-empty", "-m", "root");
    writeFileSync(join(repo.projectDir, "hive.yml"), "profile: orchestration\n");
    const init = await runCli(["init"], repoOpts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("declines a feature branch", async () => {
    const { stdout } = await runNode(KICKOFF, ["--explain"], repoOpts);
    assert.match(stdout, /silent \(branch "feature\/parser" is not a lead branch \(main, master\)\)/);
  });

  it("fires once the branch is a default lead branch", async () => {
    git(repo.projectDir, "checkout", "-b", "main");
    const { stdout } = await runNode(KICKOFF, [], repoOpts);
    assert.match(fired(stdout).additionalContext, /\[hive\] Project/);
  });

  it("honours a project's own lead_branches", async () => {
    writeFileSync(join(repo.projectDir, "hive.yml"), "profile: orchestration\nlead_branches: [trunk]\n");
    const declined = await runNode(KICKOFF, ["--explain"], repoOpts);
    assert.match(declined.stdout, /branch "main" is not a lead branch \(trunk\)/);

    git(repo.projectDir, "checkout", "-b", "trunk");
    const { stdout } = await runNode(KICKOFF, [], repoOpts);
    assert.match(fired(stdout).additionalContext, /\[hive\] Project/);
  });
});
