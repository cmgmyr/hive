import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, scratchDirs, SERVER, withEnv, runCli, warningCount, promotedCount } from "./helpers.mjs";

const { cleanup } = isolateTmux("the stale hive server tests");
after(() => cleanup());

const dirs = scratchDirs();
const psDir = join(dirs.tmp, "ps-bin");
const psPath = join(psDir, "ps");
const psRowsPath = join(dirs.tmp, "ps-rows.txt");
mkdirSync(psDir, { recursive: true });

function writePs({ fail = false } = {}) {
  writeFileSync(
    psPath,
    fail
      ? "#!/bin/sh\necho 'ps unavailable' >&2\nexit 127\n"
      : `#!/bin/sh\ncase "$*" in\n  *"pid=,ppid=,lstart=,command="*) cat ${JSON.stringify(psRowsPath)} ;;\nesac\n`,
    { mode: 0o755 },
  );
  chmodSync(psPath, 0o755);
}

function fixtureRow(pid, start, command = `${process.execPath} ${SERVER}`, ppid = 1) {
  return `${pid} ${ppid} ${start} ${command}`;
}

const { parseStaleHiveServers } = await import("../dist/staleServers.js");

describe("stale hive server start times", () => {
  it("names an older macOS ps lstart using local time against SQLite UTC", () => {
    const output = fixtureRow(50857, "Wed Oct  7 10:00:00 2026") + "\n";
    const result = withEnv({ TZ: "America/Los_Angeles" }, () =>
      parseStaleHiveServers(output, "2026-10-07 17:30:00"),
    );
    assert.deepEqual(result.servers.map((server) => server.pid), [50857]);
  });

  it("does not name a Linux ps lstart at or after the newest migration", () => {
    const output = [
      fixtureRow(73803, "Wed Oct  7 11:00:00 2026"),
      fixtureRow(90001, "Wed Oct  7 11:00:00 2026", `${process.execPath} /other/install/dist/index.js`),
    ].join("\n");
    const result = withEnv({ TZ: "America/Los_Angeles" }, () =>
      parseStaleHiveServers(output, "2026-10-07 17:00:00"),
    );
    assert.deepEqual(result.servers, []);
  });

  it("skips all process rows when ps output cannot be parsed", () => {
    assert.deepEqual(parseStaleHiveServers("not a ps row", "2026-10-07 17:30:00"), {
      skipped: "ps returned a row that could not be parsed",
    });
  });
});

describe("hive doctor stale hive server report", () => {
  const isolated = {
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: {
      PATH: `${psDir}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      CLAUDE_CONFIG_DIR: join(dirs.tmp, "claude-config"),
      CODEX_HOME: join(dirs.tmp, "codex-home"),
      HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-here"),
    },
    node: process.execPath,
  };

  it("doctor names a hive server started before the newest migration and excludes a later server", async () => {
    writeFileSync(
      psRowsPath,
      [
        fixtureRow(1, "Wed Jan  1 00:00:00 2020", "/sbin/launchd", 0),
        fixtureRow(50857, "Wed Jan  1 00:00:00 2020"),
        fixtureRow(73803, "Wed Jan  1 00:00:00 2099"),
      ].join("\n") + "\n",
    );
    writePs();
    const result = await runCli(["doctor"], isolated);
    assert.match(result.stdout, /warn  stale hive server: pid 50857 started Wed Jan 1 00:00:00 2020 \(parent pid 1: \/sbin\/launchd\)/);
    assert.match(result.stdout, new RegExp(`command: ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /restart that session to load the current build/);
    assert.doesNotMatch(result.stdout, /pid 73803/);
  });

  it("stale server warning is not promoted by --strict", async () => {
    writeFileSync(
      psRowsPath,
      `${fixtureRow(1, "Wed Jan  1 00:00:00 2020", "/sbin/launchd", 0)}\n${fixtureRow(50857, "Wed Jan  1 00:00:00 2020")}\n`,
    );
    writePs();
    const result = await runCli(["doctor", "--strict"], isolated);
    assert.match(result.stdout, /warn  stale hive server: pid 50857/);
    assert.ok(warningCount(result.stdout) >= 1, result.stdout);
    assert.equal(promotedCount(result.stdout), 0, result.stdout);
  });

  it("doctor degrades when ps is missing", async () => {
    writePs({ fail: true });
    const result = await runCli(["doctor"], isolated);
    assert.match(result.stdout, /info  stale hive servers: check skipped: ps could not be run:/);
    assert.doesNotMatch(result.stdout, /warn  stale hive server:/);
  });
});
