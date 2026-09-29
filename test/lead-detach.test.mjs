import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, tmux, tmuxSocketUnder } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("detached lead start");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { configHash } = await import("../dist/projectYml.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

const session = sessionName();
const fakeClaude = makeFakeClaude(dirs.tmp);
const claudePath = fakeClaude("sleep 600");
const cliOpts = (projectDir) => ({
  cwd: projectDir,
  dataDir: dirs.dataDir,
  tmp: dirs.tmp,
  env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
});

function callerLocation(clientName) {
  return tmux("list-clients", "-F", "#{client_name}\t#{client_session}:#{window_index}")
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([name]) => name === clientName)?.[1];
}

function activePane(window) {
  return tmux("list-panes", "-t", window, "-F", "#{pane_id}\t#{pane_active}")
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, active]) => active === "1")?.[0];
}

async function startControlClient() {
  const socket = tmuxSocketUnder(process.env.TMUX_TMPDIR);
  const child = spawn("tmux", ["-S", socket, "-C", "attach-session", "-t", `=${session}`], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  for (let attempt = 0; attempt < 60; attempt++) {
    const client = tmux("list-clients", "-F", "#{client_name}\t#{client_session}:#{window_index}")
      .split("\n")
      .map((line) => line.split("\t"))
      .find(([, location]) => location?.startsWith(`${session}:`));
    if (client) return { child, clientName: client[0], location: client[1] };
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill("SIGTERM");
  throw new Error(`tmux control client did not attach: ${stderr}`);
}

function project(name) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `hive-detach-${name}-`)));
  const row = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, path);
  return { id: row.id, path };
}

function countRows(table, projectId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId).n;
}

function seedTrust(projectId, name, command, dir = null, env = {}) {
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)")
    .run(projectId, name, configHash(name, command, dir, env));
}

after(() => cleanup(session));

describe("hive lead --detach", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("refuses an untrusted lead without an agents or command_trust row or a tmux pane", async () => {
    const p = project("untrusted-lead");
    writeFileSync(join(p.path, "hive.yml"), "lead: 'sleep 600'\n");
    const result = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, 'hive lead: "lead" is not trusted; run hive lead <path> interactively once\n');
    assert.equal(countRows("agents", p.id), 0);
    assert.equal(countRows("command_trust", p.id), 0);
    assert.equal(existsSync(tmuxSocketUnder(process.env.TMUX_TMPDIR)), false, "refusal must not start tmux");
  });

  it("rejects a changed lead hash before creating the lead", async () => {
    const p = project("changed-lead-hash");
    writeFileSync(join(p.path, "hive.yml"), "lead: 'sleep 600'\n");
    seedTrust(p.id, "lead", "sleep 599");

    const result = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /"lead" is not trusted/);
    assert.equal(countRows("agents", p.id), 0);
    assert.equal(countRows("command_trust", p.id), 1);
  });

  it("starts a lead whose exact configured command hash is trusted", async () => {
    const p = project("trusted-lead");
    writeFileSync(join(p.path, "hive.yml"), "lead: claude\n");
    seedTrust(p.id, "lead", "claude");

    const result = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));

    assert.equal(result.code, 0, result.stderr);
    assert.ok(leadRow(db, p.id));
    assert.match(result.stdout, /LEAD_PANE=%\d+/);
  });

  it("keeps a worker-pinned caller from starting a foreign project's lead", async () => {
    const pinned = project("pinned-caller");
    const foreign = project("foreign-target");
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, 'agent:pinned-caller', 'worker', '%caller-pane', 'claude', ?, 'agent', 'running')`,
    ).run(pinned.id, pinned.path);

    const result = await runCli(["lead", foreign.path, "--detach"], {
      ...cliOpts(foreign.path),
      env: {
        ...cliOpts(foreign.path).env,
        HIVE_AGENT_ID: "agent:pinned-caller",
        HIVE_PROJECT_LOCK: "1",
      },
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /cannot escape HIVE_PROJECT_LOCK=1/);
    assert.equal(countRows("agents", foreign.id), 0);
  });

  it("preflights auto-start processes, but ignores an untrusted process with auto_start off", async () => {
    const p = project("untrusted-process");
    writeFileSync(join(p.path, "hive.yml"), "processes:\n  job:\n    command: 'sleep 600'\n");

    const refused = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /"job" is not trusted/);
    assert.equal(countRows("agents", p.id), 0);
    assert.equal(countRows("command_trust", p.id), 0);

    writeFileSync(join(p.path, "hive.yml"), "processes:\n  job:\n    command: 'sleep 600'\n    auto_start: false\n");
    const accepted = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.ok(leadRow(db, p.id), `${accepted.stdout}\n${accepted.stderr}`);
    assert.equal(countRows("command_trust", p.id), 0);
  });

  it("returns the recorded pane and attach command, adopts live leads, and restarts dead panes", async () => {
    const p = project("detached target");
    writeFileSync(join(p.path, "hive.yml"), "dashboard: true\n");
    const first = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));
    assert.equal(first.code, 0, first.stderr);
    let row = leadRow(db, p.id);
    assert.ok(row, `${first.stdout}\n${first.stderr}`);
    const firstPane = row.tmux_target;
    const finalLines = first.stdout.trimEnd().split("\n").slice(-2);
    assert.deepEqual(finalLines, [`LEAD_PANE=${firstPane}`, `ATTACH_COMMAND=hive attach '${p.path}'`]);
    assert.equal(countRows("kv", p.id), 0, "detached startup must not open or mark the dashboard");

    const adopted = await runCli(["lead", p.path, "--detach", "--no-dashboard"], cliOpts(p.path));
    assert.equal(adopted.code, 0, adopted.stderr);
    row = leadRow(db, p.id);
    assert.equal(row.tmux_target, firstPane);
    assert.equal(adopted.stdout.trimEnd().split("\n").slice(-2)[0], `LEAD_PANE=${firstPane}`);

    execFileSync("tmux", ["kill-pane", "-t", firstPane], { stdio: "ignore" });
    const restarted = await runCli(["lead", p.path, "--detach"], cliOpts(p.path));
    assert.equal(restarted.code, 0, restarted.stderr);
    row = leadRow(db, p.id);
    assert.notEqual(row.tmux_target, firstPane);
    assert.equal(restarted.stdout.trimEnd().split("\n").slice(-2)[0], `LEAD_PANE=${row.tmux_target}`);
  });

  it("keeps the caller client and the target window's active pane in place", async () => {
    const p = project("caller location");
    const callerPane = tmux(
      "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `=${session}`, "-n", "caller-location", "-c",
      dirs.projectDir, "sleep", "600",
    );
    const callerWindow = tmux("display-message", "-p", "-t", callerPane, "#{window_id}");
    tmux("select-window", "-t", callerWindow);
    const client = await startControlClient();
    const callerEnv = {
      ...cliOpts(p.path).env,
      TMUX: `${tmuxSocketUnder(process.env.TMUX_TMPDIR)},1,0`,
      TMUX_PANE: callerPane,
    };
    const opts = { ...cliOpts(dirs.projectDir), env: callerEnv };
    try {
      const originalLocation = callerLocation(client.clientName);
      assert.equal(originalLocation, client.location);

      writeFileSync(join(p.path, "hive.yml"), "dashboard: true\n");
      const first = await runCli(["lead", p.path, "--detach"], opts);
      assert.equal(first.code, 0, first.stderr);
      assert.equal(callerLocation(client.clientName), originalLocation, "first start must not select its new window");
      let row = leadRow(db, p.id);
      const pane = row.tmux_target;
      const window = tmux("display-message", "-p", "-t", pane, "#{window_id}");
      const panesBeforeAdopt = tmux("list-panes", "-t", window, "-F", "#{pane_id}").split("\n");

      const adopted = await runCli(["lead", p.path, "--detach"], opts);
      assert.equal(adopted.code, 0, adopted.stderr);
      assert.equal(callerLocation(client.clientName), originalLocation, "adoption must leave the caller selected");
      const panesAfterAdopt = tmux("list-panes", "-t", window, "-F", "#{pane_id}").split("\n");
      assert.deepEqual(panesAfterAdopt, panesBeforeAdopt, "adopting the live lead must not add a pane");
      assert.equal(leadRow(db, p.id).tmux_target, pane);

      const keeper = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", window, "sleep", "600");
      tmux("select-pane", "-t", keeper);
      assert.equal(activePane(window), keeper);
      execFileSync("tmux", ["kill-pane", "-t", pane], { stdio: "ignore" });
      const restarted = await runCli(["lead", p.path, "--detach"], opts);
      assert.equal(restarted.code, 0, restarted.stderr);
      row = leadRow(db, p.id);
      assert.notEqual(row.tmux_target, pane);
      assert.equal(callerLocation(client.clientName), originalLocation, "restart must not select the target window");
      assert.equal(activePane(window), keeper, "split-window must leave the existing active pane selected");
    } finally {
      if (client.child.exitCode === null) {
        client.child.kill("SIGTERM");
        await new Promise((resolve) => client.child.once("exit", resolve));
      }
    }
  });

  it("keeps both supported flags and refuses unknown flags", async () => {
    const p = project("flags");
    const unknown = await runCli(["lead", p.path, "--unknown"], cliOpts(p.path));
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /--no-dashboard and --detach/);
    const detached = await runCli(["lead", p.path, "--detach", "--no-dashboard"], cliOpts(p.path));
    assert.equal(detached.code, 0, detached.stderr);
    assert.match(detached.stdout, /LEAD_PANE=%\d+/);
    assert.match(detached.stdout, /ATTACH_COMMAND=hive attach /);
  });
});
