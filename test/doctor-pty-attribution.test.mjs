import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, promotedCount, runCli, scratchDirs, warningCount } from "./helpers.mjs";

const { hasTmux } = isolateTmux("the doctor pty-attribution tests");
clearHiveEnv();

const { dataDir, projectDir } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
const baseEnv = { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
const opts = { cwd: projectDir, env: baseEnv };

await assertScratchStore();

// A doctor run that reaches its own end always closes with one of these two shapes
// (src/cli.ts's summary line); a crash mid-report never reaches either.
const DOCTOR_COMPLETED = /\n(All good\.|\d+ problem\(s\) found,)/;

// Same threshold pair test/ptys.test.mjs's isLowHeadroom suite pins: 461/511 crosses, 459/511 does not.
const HEALTHY = { allocated: 459, max: 511, orphanLoginShells: 0, source: "fixture" };
const AT_MARGIN = { allocated: 461, max: 511, orphanLoginShells: 2, source: "fixture" };

function shellsEnv(ages) {
  return JSON.stringify(
    ages.map((hours, i) => ({ pid: 9000 + i, ppid: 1, ageMs: hours * 3_600_000, tty: `ttys0${i}`, comm: "-zsh" })),
  );
}

describe(
  "hive doctor's pty count escalates to holder-class attribution at the safety margin (todo 470)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("stays a bare in-use line below the margin, no attribution", async () => {
      const { stdout } = await runCli(["doctor"], {
        ...opts,
        env: { ...baseEnv, HIVE_PTY_HEADROOM_JSON: JSON.stringify(HEALTHY) },
      });

      assert.match(stdout, /info {2}ptys: 459 of 511 in use \(52 free\)/);
      assert.doesNotMatch(stdout, /orphaned login shell/);
    });

    it("escalates to named holder classes right at the margin", async () => {
      const { stdout } = await runCli(["doctor"], {
        ...opts,
        env: {
          ...baseEnv,
          HIVE_PTY_HEADROOM_JSON: JSON.stringify(AT_MARGIN),
          HIVE_PTY_PS_ROWS_JSON: shellsEnv([12, 3]),
        },
      });

      assert.match(
        stdout,
        /warn {2}ptys: 461 of 511 in use \(50 free\), below the safety margin/,
        `must still carry the bare count; got: ${stdout}`,
      );
      assert.match(
        stdout,
        /2 orphaned login shell\(s\) holding a pty \(ppid 1, reparented to launchd\), oldest 12\.0h/,
        `must name the orphan-shell count and the oldest age; got: ${stdout}`,
      );
      assert.match(stdout, /0 orphaned scratch tmux server\(s\)/, `must name the scratch-server count; got: ${stdout}`);
      assert.match(
        stdout,
        /0 pane\(s\) recorded 'running' in hive's own store/,
        `must name the live-pane count; got: ${stdout}`,
      );
      assert.match(
        stdout,
        /node scripts\/sweep-scratch\.mjs/,
        `must name the command that fixes it; got: ${stdout}`,
      );
    });

    it("says '0 orphaned login shell(s)' rather than omitting the line when none qualify", async () => {
      const { stdout } = await runCli(["doctor"], {
        ...opts,
        env: {
          ...baseEnv,
          HIVE_PTY_HEADROOM_JSON: JSON.stringify(AT_MARGIN),
          HIVE_PTY_PS_ROWS_JSON: shellsEnv([]),
        },
      });

      assert.match(stdout, /0 orphaned login shell\(s\) holding a pty \(ppid 1, reparented to launchd\)$/m);
    });

    it("is information, never a gate: --strict does not promote it", async () => {
      const before = await runCli(["doctor", "--strict"], {
        ...opts,
        env: { ...baseEnv, HIVE_PTY_HEADROOM_JSON: JSON.stringify(HEALTHY) },
      });
      const after = await runCli(["doctor", "--strict"], {
        ...opts,
        env: {
          ...baseEnv,
          HIVE_PTY_HEADROOM_JSON: JSON.stringify(AT_MARGIN),
          HIVE_PTY_PS_ROWS_JSON: shellsEnv([1]),
        },
      });

      assert.match(after.stdout, /warn {2}ptys: 461 of 511 in use/);
      assert.equal(
        warningCount(after.stdout) - warningCount(before.stdout),
        1,
        "the control: crossing the margin must add exactly this one warn",
      );
      assert.equal(
        promotedCount(after.stdout) - promotedCount(before.stdout),
        0,
        "--strict must not promote the pty escalation itself, even though other gating warns may still fire here",
      );
    });

    it("does not crash on malformed HIVE_PTY_HEADROOM_JSON", async () => {
      const { stdout, stderr } = await runCli(["doctor"], {
        ...opts,
        env: { ...baseEnv, HIVE_PTY_HEADROOM_JSON: "{oops" },
      });

      assert.equal(stderr, "", `malformed override JSON must not throw an uncaught exception; got stderr: ${stderr}`);
      assert.match(stdout, DOCTOR_COMPLETED, `doctor must still finish its report; got: ${stdout}`);
    });

    // A real execFileSync("ps", ...) failure is caught by the identical branch malformed JSON hits
    // (see psSnapshotWithAge() in src/ptys.ts), and test/ptys.test.mjs pins that at the unit level by
    // shadowing the real `ps` binary for one direct call to orphanLoginShellDetails(). Driving the
    // same failure through the CLI here via HIVE_PTY_PS_ROWS_JSON, rather than shadowing `ps` on PATH
    // for the whole doctor process, keeps this test scoped to the escalation path alone: an earlier
    // version shadowed `ps` process-wide and red on an unrelated check on Linux CI, proving nothing
    // about this behaviour.
    it("names the escalation as unavailable, never a false zero, when its ps-rows probe fails", async () => {
      const { stdout, stderr } = await runCli(["doctor"], {
        ...opts,
        env: { ...baseEnv, HIVE_PTY_HEADROOM_JSON: JSON.stringify(AT_MARGIN), HIVE_PTY_PS_ROWS_JSON: "{oops" },
      });

      assert.equal(stderr, "", `a failed probe must not throw an uncaught exception; got stderr: ${stderr}`);
      assert.match(stdout, DOCTOR_COMPLETED, `doctor must still finish its report; got: ${stdout}`);
      assert.match(
        stdout,
        /warn {2}ptys: 461 of 511 in use \(50 free\), below the safety margin/,
        "the escalation must still have engaged - this is the non-vacuity check",
      );
      assert.match(
        stdout,
        /orphaned login shell count unavailable \(ps did not respond\)/,
        "it must say the count could not be gathered, not silently claim zero",
      );
      assert.doesNotMatch(
        stdout,
        /0 orphaned login shell\(s\)/,
        "a failed probe must never be reported as a clean zero",
      );
    });

    it("names which override is active, mirroring HIVE_TMUX_TIMEOUT_MS's own precedent", async () => {
      const healthy = await runCli(["doctor"], {
        ...opts,
        env: { ...baseEnv, HIVE_PTY_HEADROOM_JSON: JSON.stringify(HEALTHY) },
      });
      assert.match(
        healthy.stdout,
        /info {2}ptys: 459 of 511 in use \(52 free\) \(HIVE_PTY_HEADROOM_JSON override; testing only\)/,
        `a fabricated healthy reading must say so, or doctor's numbers cannot be trusted; got: ${healthy.stdout}`,
      );

      const escalated = await runCli(["doctor"], {
        ...opts,
        env: {
          ...baseEnv,
          HIVE_PTY_HEADROOM_JSON: JSON.stringify(AT_MARGIN),
          HIVE_PTY_PS_ROWS_JSON: shellsEnv([1]),
        },
      });
      assert.match(
        escalated.stdout,
        /below the safety margin \(HIVE_PTY_HEADROOM_JSON, HIVE_PTY_PS_ROWS_JSON overrides; testing only\)/,
        `both active overrides must be named together; got: ${escalated.stdout}`,
      );
    });
  },
);
