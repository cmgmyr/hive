import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { firedSessionStart as fired, KICKOFF, McpClient, isolateTmux, runCli, runNode, scratchDirs } from "./helpers.mjs";

// The hook and the CLI both start hive, which probes tmux; isolate first.
const { cleanup: cleanupTmux } = isolateTmux("the kickoff tests");
after(() => cleanupTmux());

// The SessionStart hook fires in every directory on the machine, so most of
// what it does is decline. Each gate is tested rejecting on its own, with
// --explain turning the silence into a readable reason.
const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const kickoff = (args = [], o = opts) => runNode(KICKOFF, args, o);

// -c commit.gpgsign=false: these scratch commits exist only to give the repo a
// branch to read. Inheriting the developer's signing config makes the suite
// fail whenever their signing agent is locked, which has nothing to do with
// what is under test.
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "gpg.format=openpgp", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

const yml = (body, dir = dirs.projectDir) => writeFileSync(join(dir, "hive.yml"), body);

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
    // The hook runs on every session start everywhere; opening SQLite in
    // every unrelated directory is the cost this gate order exists to avoid.
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
    // hive.yml is committed. A teammate without the profile it names gets
    // silence, never an error.
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

  it("still fires on a lead checkout once the lead carries HIVE_AGENT_ID too", async () => {
    // Issue #27: `hive lead` now sets HIVE_AGENT_ID (lead:<id>) so the hook
    // has an actor to write against, which makes check 1's OLD rule -
    // "HIVE_AGENT_ID is set" means worker - true for a lead's own session for
    // the first time. HIVE_LEAD is what tells the two apart; this is the
    // regression the plan named as most likely to ship silently, so it is
    // asserted on the RENDERED payload, not a boolean.
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

  // Issue #27's L4 fix round, DECISION 7a. The check used to be truthiness
  // (`!process.env.HIVE_LEAD`), so HIVE_LEAD="0" - the one value a future
  // caller would most plausibly write meaning false - read as truthy and let
  // a worker past the gate that exists specifically to keep it from opening
  // the store at all. The only test covering this check before now was the
  // accepting HIVE_LEAD="1" case above; this is the rejecting one.
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

  // kickoff passes alive=null and never shells out to tmux (deliberately: it
  // runs on every session start and has to stay cheap), so the WORKERS header
  // must not read as a liveness check that already happened. Seeded with a
  // raw insert rather than agent_spawn, since kickoff's WORKERS query is a
  // plain SELECT with no tmux involved and this is the row shape it reads.
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
    // The header's wording is not the only thing that has to stay true: if
    // kickoff ever started passing a real tmux probe instead of alive=null,
    // the header text alone would not catch it, since deriveProvenance's
    // state stays a separate field from the string above it (counselors'
    // T3). tmux_target '%1' names no real pane on this isolated server, so a
    // real probe would render "gone" (src/stateProvenance.ts) - the seeded
    // row is the discriminator this assertion needs to be able to fail.
    assert.doesNotMatch(additionalContext, /gone/);
  });

  // Issue #27, step 5: confirming rather than assuming that the WORKERS
  // block's existing kind='agent' filter also excludes the lead's own row,
  // now that the lead has one. Zero production code changes here - the
  // filter was already there - this is the test that goes red if a future
  // change widens it.
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
    // The WORKERS line prints the row's NAME, not its actor_id - asserting on
    // actor_id here would pass even with kind='agent' dropped from the query,
    // since nothing in the rendered line ever carries actor_id at all.
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
    // Truncation must not eat the sections that come after the board.
    assert.match(out.additionalContext, /IN FLIGHT/);
    assert.match(out.additionalContext, /hive runbook/);
  });
});

describe("hive kickoff hive.yml warnings", () => {
  const warned = scratchDirs();
  const warnedOpts = { cwd: warned.projectDir, dataDir: warned.dataDir, tmp: warned.tmp };
  const warnedYml = (body) => writeFileSync(join(warned.projectDir, "hive.yml"), body);
  // A profile that exists plus a key that does not parse: the kickoff fires
  // and the warning has somewhere to land.
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
    // Registered without `hive init`, so the project has no board or runbook
    // pad and the digest has nothing but the warning to report.
    const mcp = new McpClient({ cwd: empty.projectDir, dataDir: empty.dataDir });
    await mcp.start();
    await mcp.call("whoami");
    await mcp.close();

    const { additionalContext } = fired((await runNode(KICKOFF, [], emptyOpts)).stdout);
    assert.match(additionalContext, /! hive\.yml: layout must be one of/);
    assert.match(additionalContext, /The store is empty for this project/);
  });

  it("reports them on --explain even when the kickoff declines", async () => {
    // The gate that matters: no profile means silence, and silence is the one
    // state where nothing else in the session would ever mention hive.yml.
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
