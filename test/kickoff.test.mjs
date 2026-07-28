import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { KICKOFF, McpClient, runCli, runNode, scratchDirs } from "./helpers.mjs";

// The SessionStart hook fires in every directory on the machine, so most of
// what it does is decline. Each gate is tested rejecting on its own, with
// --explain turning the silence into a readable reason.
const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const kickoff = (args = [], o = opts) => runNode(KICKOFF, args, o);

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });

const yml = (body, dir = dirs.projectDir) => writeFileSync(join(dir, "hive.yml"), body);

function fired(stdout) {
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  return payload.hookSpecificOutput;
}

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
