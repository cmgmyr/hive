import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  failureCount,
  isolateTmux,
  liveAgentRow,
  McpClient,
  runCli,
  scratchDirs,
  warningCount,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the spawn receipt tests");

const dirs = scratchDirs();

process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

const cliOpts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const ymlPath = join(dirs.projectDir, "hive.yml");
const BAD_LAYOUT = "layout: main-verticle\n";

describe("agent_spawn config warnings", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let mcp;
  let projectId;

  before(async () => {
    const init = await runCli(["init"], cliOpts);
    assert.equal(init.code, 0, init.stderr);
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    projectId = (await mcp.call("whoami")).project.id;
  });

  after(async () => {
    await mcp?.close();
    cleanup(sessionName());
  });

  const spawn = (name) => mcp.call("agent_spawn", { name, command: "sleep", extra_args: ["600"] });

  it("reports a bad layout in the receipt and still spawns", async () => {
    writeFileSync(ymlPath, BAD_LAYOUT);
    const receipt = await spawn("warned");
    assert.ok(receipt.agent_id > 0, "the spawn must not fail on a recoverable config problem");
    await liveAgentRow(mcp, "warned");
    assert.equal(receipt.config_warnings.length, 1);
    assert.match(receipt.config_warnings[0], /layout must be one of/);
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });

  it("omits config_warnings when hive.yml parses clean", async () => {
    writeFileSync(ymlPath, "layout: main-vertical\n");
    const receipt = await spawn("clean");
    await liveAgentRow(mcp, "clean");
    assert.ok(
      !("config_warnings" in receipt),
      `slim receipts: the key must be absent, got ${JSON.stringify(receipt.config_warnings)}`,
    );
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });

  it("omits config_warnings when there is no hive.yml at all", async () => {
    unlinkSync(ymlPath);
    const receipt = await spawn("bare");
    await liveAgentRow(mcp, "bare");
    assert.ok(!("config_warnings" in receipt));
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
  });
});

describe("hive doctor config warnings", () => {
  const doctorDirs = scratchDirs();
  const doctorOpts = { cwd: doctorDirs.projectDir, dataDir: doctorDirs.dataDir, tmp: doctorDirs.tmp };
  const doctorYml = join(doctorDirs.projectDir, "hive.yml");

  let noYml;
  let broken;

  before(async () => {
    const init = await runCli(["init"], doctorOpts);
    assert.equal(init.code, 0, init.stderr);
    noYml = await runCli(["doctor"], doctorOpts);
    writeFileSync(doctorYml, BAD_LAYOUT);
    broken = await runCli(["doctor"], doctorOpts);
  });

  it("says nothing about hive.yml when there is none", () => {

    assert.doesNotMatch(noYml.stdout, /hive\.yml/);
  });

  it("reports a malformed hive.yml", () => {
    assert.match(broken.stdout, /warn {2}hive\.yml: layout must be one of/);
  });

  it("does not count a warning as a failed check", () => {

    assert.equal(failureCount(broken.stdout), failureCount(noYml.stdout));

    assert.equal(warningCount(broken.stdout) - warningCount(noYml.stdout), 1);
  });

  it("says nothing when hive.yml parses clean", async () => {
    writeFileSync(doctorYml, "layout: main-vertical\n");
    const { stdout } = await runCli(["doctor"], doctorOpts);

    assert.doesNotMatch(stdout, /warn {2}hive\.yml/);
  });
});
