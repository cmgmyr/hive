import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, scratchDirs, SERVER, runCli, warningCount, promotedCount } from "./helpers.mjs";

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
      : `#!/bin/sh\ncase "$*" in\n  *"pid=,ppid=,etime=,command="*) cat ${JSON.stringify(psRowsPath)} ;;\nesac\n`,
    { mode: 0o755 },
  );
  chmodSync(psPath, 0o755);
}

function fixtureRow(pid, start, command = `${process.execPath} ${SERVER}`, ppid = 1) {
  return `${pid} ${ppid} ${start} ${command}`;
}

const { elapsedSeconds, parseStaleHiveServers, STALE_SERVER_BOUNDARY_SLACK_MS } = await import("../dist/staleServers.js");
const observedAt = Date.parse("2026-10-08T10:00:10.000Z");

describe("stale hive server elapsed times", () => {
  it("names an older server from a day-prefixed macOS ps etime", () => {
    const output = fixtureRow(50857, "1-02:03:04") + "\n";
    const result = parseStaleHiveServers(output, "2026-10-07 08:00:00", Date.parse("2026-10-08T10:00:00.000Z"));
    assert.deepEqual(result.servers.map((server) => server.pid), [50857]);
    assert.equal(result.servers[0].startedAt, "2026-10-07T07:56:56.000Z");
  });

  it("does not name a Linux ps etime at or after the newest migration", () => {
    const output = [
      fixtureRow(73803, "01:00:05"),
      fixtureRow(90001, "01:00:05", `${process.execPath} /other/install/dist/index.js`),
    ].join("\n");
    const result = parseStaleHiveServers(output, "2026-10-08 09:00:00", observedAt);
    assert.deepEqual(result.servers, []);
  });

  it("uses a three-second boundary slack so a server near migration time is not called stale", () => {
    const nearBoundary = parseStaleHiveServers(fixtureRow(111, "00:00:12"), "2026-10-08 10:00:00", observedAt);
    const outsideBoundary = parseStaleHiveServers(fixtureRow(222, "00:00:14"), "2026-10-08 10:00:00", observedAt);
    assert.equal(STALE_SERVER_BOUNDARY_SLACK_MS, 3000);
    assert.deepEqual(nearBoundary.servers, []);
    assert.deepEqual(outsideBoundary.servers.map((server) => server.pid), [222]);
  });

  it("parses each ps etime shape and rejects malformed elapsed values", () => {
    assert.equal(elapsedSeconds("03:04"), 184);
    assert.equal(elapsedSeconds("02:03:04"), 7384);
    assert.equal(elapsedSeconds("1-02:03:04"), 93784);
    assert.equal(elapsedSeconds("1-25:03:04"), null);
    assert.equal(elapsedSeconds("bad"), null);
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
        fixtureRow(1, "3650-00:00:00", "/sbin/launchd", 0),
        fixtureRow(50857, "3650-00:00:00"),
        fixtureRow(73803, "00:00:01"),
      ].join("\n") + "\n",
    );
    writePs();
    const result = await runCli(["doctor"], isolated);
    assert.match(result.stdout, /warn  stale hive server: pid 50857 started \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(parent pid 1: \/sbin\/launchd\)/);
    assert.match(result.stdout, new RegExp(`command: ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${SERVER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.stdout, /restart that session to load the current build/);
    assert.doesNotMatch(result.stdout, /pid 73803/);
  });

  it("stale server warning is not promoted by --strict", async () => {
    writeFileSync(
      psRowsPath,
      `${fixtureRow(1, "3650-00:00:00", "/sbin/launchd", 0)}\n${fixtureRow(50857, "3650-00:00:00")}\n`,
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
