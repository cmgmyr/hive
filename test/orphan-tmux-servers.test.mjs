import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  fakeHangingTmux,
  isolateTmux,
  REPO,
  runCli,
  scratchDirs,
  scratchTmuxServer,
  withEnv,
} from "./helpers.mjs";

const { hasTmux } = isolateTmux("the orphaned scratch tmux server tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { orphanScratchServers, orphansWorthWarningAbout, SCRATCH_SOCKET_PREFIX } = await import("../dist/tmux.js");

const made = [];
function scratchServer(options = {}) {
  const server = scratchTmuxServer({ prefix: SCRATCH_SOCKET_PREFIX, ...options });
  made.push(server);
  return server.socket;
}

after(() => {
  for (const server of made) server.reap();
});

describe("hive doctor's orphaned scratch tmux server report", { skip: hasTmux ? false : "tmux not installed" }, () => {
  it("counts a real, aged scratch server and names its socket", () => {
    const socket = scratchServer({ ageHours: 5 });

    const before = orphanScratchServers({ budgetMs: 30_000 });
    assert.ok(before.sockets.includes(socket), `expected ${socket} to be reported, got ${before.sockets.join(", ")}`);
    assert.ok(before.live >= 1);
    assert.ok(before.candidates >= 1);

    execFileSync("tmux", ["-S", socket, "kill-session", "-t", "=orphan"], {
      stdio: "ignore",
      timeout: 5000,
      killSignal: "SIGKILL",
    });
    const after_ = orphanScratchServers({ budgetMs: 30_000 });
    assert.ok(!after_.sockets.includes(socket), "a killed server must stop being reported");
  });

  it("does not report a FRESH scratch socket, so a concurrent suite is not debris", () => {
    const socket = scratchServer();
    const seen = orphanScratchServers({ budgetMs: 30_000 });
    assert.ok(!seen.sockets.includes(socket), "a socket younger than the age floor must not be reported");

    assert.ok(seen.candidates >= 1);
  });

  it("excludes the live socket explicitly, never by inference", () => {
    const socket = scratchServer({ ageHours: 5 });

    withEnv({ TMUX_TMPDIR: made[made.length - 1].dir }, () => {
      const seen = orphanScratchServers({ minAgeMs: 0, budgetMs: 30_000 });
      assert.ok(!seen.sockets.includes(socket), "the live socket must never be reported as an orphan");
    });

    const seenAgain = orphanScratchServers({ minAgeMs: 0, budgetMs: 30_000 });
    assert.ok(seenAgain.sockets.includes(socket));
  });

  it("counts a server that does not ANSWER as wedged rather than dropping it as gone", () => {

    const socket = scratchServer({ ageHours: 24 * 365 });
    const fakeDir = fakeHangingTmux();
    try {
      withEnv({ PATH: `${fakeDir}:${process.env.PATH}`, HIVE_TMUX_TIMEOUT_MS: "300" }, () => {
        const seen = orphanScratchServers({ budgetMs: 1000 });
        assert.ok(seen.wedged >= 1, "a non-answering server must be counted, not silently dropped");
        assert.ok(seen.sockets.includes(socket));
        assert.equal(seen.live, 0);
      });
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it("says so in `hive doctor`, names the socket, and kills nothing", async () => {
    const socket = scratchServer({ ageHours: 7 });
    const { stdout } = await runCli(["doctor"], { cwd: REPO, dataDir });
    assert.match(stdout, /scratch tmux servers/);
    assert.ok(stdout.includes(socket), `doctor did not name ${socket}:\n${stdout}`);
    assert.match(stdout, /not touched here - doctor reports/);

    const sessions = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    }).trim();
    assert.equal(sessions, "orphan");
  });

  it("warns only for a wedged server or a hoard, never for ordinary debris", () => {

    const at = (live, wedged) => orphansWorthWarningAbout({ live, wedged, candidates: 9, aged: 9, probed: 9, oldestMs: 1, sockets: [] });
    assert.equal(at(0, 0), false);
    assert.equal(at(4, 0), false, "a handful of answering orphans is debris, not a fault");
    assert.equal(at(5, 0), true, "a hoard is worth a look");

    assert.equal(at(0, 1), true);
  });

  it("keeps its socket prefix in step with the one isolateTmux actually creates", () => {

    const helpers = readFileSync(join(REPO, "test", "helpers.mjs"), "utf8");
    assert.ok(
      helpers.includes(`"${SCRATCH_SOCKET_PREFIX}"`),
      `test/helpers.mjs no longer creates sockets under "${SCRATCH_SOCKET_PREFIX}"`,
    );
  });
});
