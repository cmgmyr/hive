import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, leadRow, makeFakeClaude, runCli, scratchDirs, seedLeadProject, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the fresh-lead leftover tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
const { sessionName, targetLive } = await import("../dist/tmux.js");

const fakeClaude = makeFakeClaude(dirs.tmp);
const leadBin = fakeClaude();
const session = sessionName();

const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

function portHolderScript(dir, port) {
  const path = join(dir, "hold-a-port.mjs");
  writeFileSync(
    path,
    `import { createServer } from "node:net";\n` +
      `process.on("SIGINT", () => {});\n` +
      `createServer().listen(${port}, "127.0.0.1");\n`,
  );
  return path;
}

const seedProject = (name, yml, processes) =>
  seedLeadProject(db, { root: dirs.tmp, name, leadBin, processes, yml });

const cliOpts = (dir) => ({ cwd: dir, dataDir: dirs.dataDir, tmp: dirs.tmp });

const commandRow = (projectId, name) =>
  db
    .prepare("SELECT * FROM agents WHERE project_id = ? AND name = ? AND kind = 'command' AND status = 'running'")
    .get(projectId, name);

after(() => cleanup(session));

describe("a fresh hive lead clears the processes a previous lead left running (todo 765)", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("stops the leftover pane, says why, and starts a new one for an auto_start process", async () => {
    const project = await seedProject(
      "leftovers-restart",
      `lead: ${leadBin}\nprocesses:\n  api:\n    command: sleep 600\n    visible: false\n`,
      { api: "sleep 600" },
    );

    const first = await runCli(["lead"], cliOpts(project.dir));
    assert.equal(first.code, 0, first.stderr);
    const leftover = commandRow(project.id, "api");
    assert.ok(leftover, "the fixture needs a running process to leave behind");

    execFileSync("tmux", ["kill-pane", "-t", leadRow(db, project.id).tmux_target], { stdio: "ignore" });

    const second = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^- api: stopped \(C-c\); left running by a previous lead$/m);
    assert.match(second.stdout, /^- api: started \(hidden\)$/m);
    const restarted = commandRow(project.id, "api");
    assert.ok(restarted);
    assert.notEqual(restarted.tmux_target, leftover.tmux_target, "the leftover pane must be replaced, not adopted");
    assert.equal(targetLive(leftover.tmux_target), false, "the previous lead's pane must be gone");
    assert.equal(targetLive(restarted.tmux_target), true);
  });

  it("stops the leftover before starting its replacement, so a port the leftover holds is free to rebind", async () => {
    const port = await freePort();
    const holderDir = join(dirs.tmp, "leftovers-port");
    mkdirSync(holderDir, { recursive: true });
    const command = `node ${portHolderScript(holderDir, port)}`;
    const project = await seedProject(
      "leftovers-port",
      `lead: ${leadBin}\nprocesses:\n  server:\n    command: ${command}\n    visible: false\n`,
      { server: command },
    );

    const first = await runCli(["lead"], cliOpts(project.dir));
    assert.equal(first.code, 0, first.stderr);
    assert.ok(commandRow(project.id, "server"), `the fixture needs the port holder running: ${first.stdout}`);

    execFileSync("tmux", ["kill-pane", "-t", leadRow(db, project.id).tmux_target], { stdio: "ignore" });
    const second = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(second.code, 0, second.stderr);
    const restarted = commandRow(project.id, "server");
    assert.ok(restarted, "the replacement must be recorded");
    assert.equal(
      await until(() => targetLive(restarted.tmux_target) === false, 1500),
      false,
      "the replacement must still be up: started before the leftover was stopped, it exits on EADDRINUSE",
    );
  });

  it("stops a leftover whose definition is gone from hive.yml and says so, starting nothing", async () => {
    const project = await seedProject(
      "leftovers-undefined",
      `lead: ${leadBin}\nprocesses:\n  api:\n    command: sleep 600\n    visible: false\n`,
      { api: "sleep 600" },
    );
    const first = await runCli(["lead"], cliOpts(project.dir));
    assert.equal(first.code, 0, first.stderr);
    const leftover = commandRow(project.id, "api");
    assert.ok(leftover);

    execFileSync("tmux", ["kill-pane", "-t", leadRow(db, project.id).tmux_target], { stdio: "ignore" });
    writeFileSync(join(project.dir, "hive.yml"), `lead: ${leadBin}\n`);
    const second = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(second.code, 0, second.stderr);
    assert.match(
      second.stdout,
      /^- api: stopped \(C-c\); left running by a previous lead, and it is no longer defined in hive\.yml$/m,
    );
    assert.equal(commandRow(project.id, "api"), undefined, "nothing may be started for a definition that is gone");
    assert.equal(targetLive(leftover.tmux_target), false);
  });

  it("an adopted live lead stops nothing and prints no leftover line", async () => {
    const project = await seedProject(
      "leftovers-adopt",
      `lead: ${leadBin}\nprocesses:\n  api:\n    command: sleep 600\n    visible: false\n`,
      { api: "sleep 600" },
    );
    const first = await runCli(["lead"], cliOpts(project.dir));
    assert.equal(first.code, 0, first.stderr);
    const running = commandRow(project.id, "api");
    assert.ok(running);

    const again = await runCli(["lead"], cliOpts(project.dir));

    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /left running by a previous lead/);
    assert.match(again.stdout, /^- api: already running \(hidden\)$/m);
    assert.equal(commandRow(project.id, "api").tmux_target, running.tmux_target, "the live process must be untouched");
    assert.equal(targetLive(running.tmux_target), true);
  });
});
