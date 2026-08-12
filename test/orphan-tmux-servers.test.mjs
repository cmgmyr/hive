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

// Todo 375 item 2. Bounding a tmux call kills the CHILD, not the SERVER it
// was talking to, so the fix leaves survivors: on the night this was filed
// there were 200 candidate scratch sockets under the temp dir and a server
// still spinning from that morning, from a worktree that no longer existed.
// `hive doctor` counts them now. It must never kill one.
const { hasTmux } = isolateTmux("the orphaned scratch tmux server tests");
const { dataDir } = scratchDirs();

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { orphanScratchServers, orphansWorthWarningAbout, SCRATCH_SOCKET_PREFIX } = await import("../dist/tmux.js");

// Real servers on real scratch sockets, shaped exactly as isolateTmux's are.
// scratchTmuxServer (test/helpers.mjs) owns the shape, so this file and
// test/tmux-leak-check.test.mjs cannot drift apart on the socket-path
// derivation both of them depend on being right.
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

    // Membership of OUR socket, never an absolute count: other test files run
    // concurrently and make scratch sockets of their own, so a count would be
    // a race dressed as an assertion.
    const before = orphanScratchServers({ budgetMs: 30_000 });
    assert.ok(before.sockets.includes(socket), `expected ${socket} to be reported, got ${before.sockets.join(", ")}`);
    assert.ok(before.live >= 1);
    assert.ok(before.candidates >= 1);

    // THE CONTROL, and it is what makes the assertion above able to fail: the
    // same enumeration, one kill-server later, must stop naming it. Without
    // this, a function that reported every socket it found - reachable server
    // or not - would pass the first assertion perfectly.
    // Its last session going takes the server with it (`exit-empty on`), so
    // the socket stops answering without this file ever naming kill-server.
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
    // Still COUNTED as a candidate: "0 servers" must never read as "nothing
    // is there", which is what doctor's zero line prints this number for.
    assert.ok(seen.candidates >= 1);
  });

  it("excludes the live socket explicitly, never by inference", () => {
    const socket = scratchServer({ ageHours: 5 });
    // Point this process at that server: it is now the socket hive itself
    // would talk to, and reporting it would be doctor calling its own live
    // server debris. dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-
    // pid.md: the safe method resolves the live socket and excludes it.
    withEnv({ TMUX_TMPDIR: made[made.length - 1].dir }, () => {
      const seen = orphanScratchServers({ minAgeMs: 0, budgetMs: 30_000 });
      assert.ok(!seen.sockets.includes(socket), "the live socket must never be reported as an orphan");
    });
    // CONTROL: the identical server, no longer the live one, IS reported. The
    // exclusion has to be the reason for the miss above, not the age floor,
    // the prefix, or a probe that failed for some unrelated reason.
    const seenAgain = orphanScratchServers({ minAgeMs: 0, budgetMs: 30_000 });
    assert.ok(seenAgain.sockets.includes(socket));
  });

  it("counts a server that does not ANSWER as wedged rather than dropping it as gone", () => {
    // The incident's own shape: a server that is alive and unreachable. A
    // real one cannot be manufactured here, so the probe is made to time out
    // instead - which is exactly what this classification reads.
    // Aged past anything a real machine can be carrying, because candidates
    // are probed oldest first and the box this was written on had a genuine
    // 10.4h orphan on it: a fixture that is merely "old" can lose the race
    // for the budget to real debris and never be probed at all.
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
    // THE POINT OF THE WHOLE ITEM: reporting, not reaping. Asserted against
    // the server itself rather than against doctor's own words.
    const sessions = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
    }).trim();
    assert.equal(sessions, "orphan");
  });

  it("warns only for a wedged server or a hoard, never for ordinary debris", () => {
    // The threshold at the boundary, both sides of it, because a report that
    // warns on the everyday state of a machine that runs this suite is one a
    // reader learns to skip. Asserted here rather than through doctor's own
    // stdout: making doctor SEE five orphans means making five servers, and
    // the wiring it would prove is a single if.
    const at = (live, wedged) => orphansWorthWarningAbout({ live, wedged, candidates: 9, aged: 9, probed: 9, oldestMs: 1, sockets: [] });
    assert.equal(at(0, 0), false);
    assert.equal(at(4, 0), false, "a handful of answering orphans is debris, not a fault");
    assert.equal(at(5, 0), true, "a hoard is worth a look");
    // ONE is enough when it does not answer: the recorded safe reap
    // (kill-server by socket) does not work against a wedged server at all.
    assert.equal(at(0, 1), true);
  });

  it("keeps its socket prefix in step with the one isolateTmux actually creates", () => {
    // The prefix is mirrored by hand in test/helpers.mjs, the same way
    // scripts/restart-lead.sh mirrors isViewSessionName's suffix. A drift here
    // would make doctor's report silently count nothing at all, which is the
    // failure a report cannot show you.
    const helpers = readFileSync(join(REPO, "test", "helpers.mjs"), "utf8");
    assert.ok(
      helpers.includes(`"${SCRATCH_SOCKET_PREFIX}"`),
      `test/helpers.mjs no longer creates sockets under "${SCRATCH_SOCKET_PREFIX}"`,
    );
  });
});
