import assert from "node:assert/strict";
import { platform } from "node:os";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";
import {
  countAllocatedTtys,
  countOrphanLoginShells,
  isLowHeadroom,
  parsePsSnapshot,
  probeForPlatform,
  ptyWarnThreshold,
  safeProbe,
} from "../dist/ptys.js";

// `hive doctor` runs the janitor, which reaches tmux (test/CLAUDE.md).
const { cleanup } = isolateTmux("the ptys doctor-wiring test");

// Captured shape, not a real `ps` run: test/CLAUDE.md's "a test asserting a
// number read off the box it runs on cannot fail" applies here exactly as it
// does anywhere else in this suite, and it is the precise defect this
// module exists to avoid repeating
// (.claude/sessions/dead-ends/2026-08-07-pgrep-x-zsh-to-count-shells-holding-ptys.md).
// Row count (7), allocated tty count (5) and orphan count (3) are all
// different numbers, so a probe that reads the wrong field cannot pass by
// accident.
const PS_FIXTURE = [
  "ttys000    501 -zsh", // live login shell, allocated
  "ttys000  60234 node", // same tty as above -- allocated must count ttys, not rows
  "ttys001      1 -zsh", // orphan: leading dash, ppid 1
  "ttys002      1 -bash", // orphan: a different shell, same leading-dash rule
  "??            1 launchd", // ppid 1 but no tty and no leading dash: neither allocated nor orphan
  "ttys003    501 zsh", // allocated, not orphan: no leading dash despite a live pane
  "ttys004      1 /usr/local/bin/-fish", // orphan: leading dash survives a full path, matched on the basename
].join("\n");

describe("parsePsSnapshot", () => {
  it("parses every row of `ps -eo tty=,ppid=,comm=` output", () => {
    const rows = parsePsSnapshot(PS_FIXTURE);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows[0], { tty: "ttys000", ppid: 501, comm: "-zsh" });
    assert.deepEqual(rows[4], { tty: "??", ppid: 1, comm: "launchd" });
  });

  it("skips blank lines", () => {
    const rows = parsePsSnapshot(`${PS_FIXTURE}\n\n  \n`);
    assert.equal(rows.length, 7);
  });
});

describe("countAllocatedTtys", () => {
  it("counts distinct ttys* names, not rows", () => {
    const rows = parsePsSnapshot(PS_FIXTURE);
    assert.equal(countAllocatedTtys(rows), 5);
  });
});

describe("countOrphanLoginShells", () => {
  it("counts ppid-1 rows whose comm basename has a leading dash", () => {
    const rows = parsePsSnapshot(PS_FIXTURE);
    assert.equal(countOrphanLoginShells(rows), 3);
  });

  // This is the exact trap the dead-end names: matching the full string
  // "-zsh" rather than the basename, or requiring an exact "zsh" name,
  // would both undercount here.
  it("is not fooled by a non-login shell with ppid 1", () => {
    const rows = parsePsSnapshot("??            1 launchd\nttys009        1 sshd");
    assert.equal(countOrphanLoginShells(rows), 0);
  });
});

describe("ptyWarnThreshold", () => {
  it("is 10% of max on a box big enough for the percentage to dominate", () => {
    assert.equal(ptyWarnThreshold(511), 51);
  });

  it("floors at 32 on a small max", () => {
    assert.equal(ptyWarnThreshold(100), 32);
    assert.equal(ptyWarnThreshold(319), 32);
    assert.equal(ptyWarnThreshold(320), 32);
    assert.equal(ptyWarnThreshold(330), 33);
  });
});

describe("isLowHeadroom", () => {
  it("does not warn exactly at the threshold", () => {
    // max 511 -> threshold 51. free == 51 when allocated == 460.
    assert.equal(isLowHeadroom({ allocated: 460, max: 511 }), false);
  });

  it("warns one pty below the threshold", () => {
    // free == 50.
    assert.equal(isLowHeadroom({ allocated: 461, max: 511 }), true);
  });

  it("does not warn one pty above the threshold", () => {
    // free == 52.
    assert.equal(isLowHeadroom({ allocated: 459, max: 511 }), false);
  });

  it("uses the floor, not the raw percentage, on a small max", () => {
    // max 100 -> 10% would be 10, but the floor of 32 wins.
    assert.equal(isLowHeadroom({ allocated: 68, max: 100 }), false); // free 32
    assert.equal(isLowHeadroom({ allocated: 69, max: 100 }), true); // free 31
  });
});

describe("probeForPlatform", () => {
  it("has no probe for a platform that isn't darwin or linux", () => {
    assert.equal(probeForPlatform("win32"), null);
    assert.equal(probeForPlatform("freebsd"), null);
  });

  it("returns a callable probe for darwin and linux", () => {
    assert.equal(typeof probeForPlatform("darwin"), "function");
    assert.equal(typeof probeForPlatform("linux"), "function");
  });
});

describe("safeProbe", () => {
  it("returns the probe's result when it succeeds", () => {
    const headroom = { allocated: 1, max: 2, orphanLoginShells: 0, source: "fixture" };
    assert.deepEqual(safeProbe(() => headroom), headroom);
  });

  it("degrades to null instead of throwing when the probe fails", () => {
    // Stands in for a missing sysctl or an unreadable /proc file -- the
    // point under test is that a thrown probe never reaches the caller as
    // a thrown error, not which real-world probe failed.
    assert.equal(
      safeProbe(() => {
        throw new Error("sysctl: unknown oid 'kern.tty.ptmx_max'");
      }),
      null,
    );
  });
});

// Counselors review (codex-5.6-sol-high): every test above asserts parsing
// and comparison logic against fixtures, per design -- a test asserting a
// number read off the box it runs on cannot fail (test/CLAUDE.md) -- but
// nothing exercised the real darwin/linux probe or cmdDoctor's own wiring,
// so a misspelled sysctl name, a wrong /proc path, or deleting
// `reportPtyHeadroom();` from cmdDoctor would leave every test above green.
// This closes that gap without asserting a live number: only the LABEL's
// presence and shape are pinned, on the platforms hive actually ships CI for
// (CLAUDE.md: "CI runs the same on macOS"; linux is the other supported
// platform per src/ptys.ts's own probeForPlatform).
describe(
  "hive doctor's own ptys line, against the real machine",
  { skip: platform() === "darwin" || platform() === "linux" ? false : "unsupported platform" },
  () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    after(() => cleanup());

    it("prints an info or warn ptys line shaped like doctor's own report()", async () => {
      const { stdout } = await runCli(["doctor"], opts);
      // "in use", not "allocated": on darwin the number is ttys with a live
      // process, a lower bound on the kernel's allocation rather than the
      // allocation itself (src/ptys.ts, PtyHeadroom.allocated). Pinning the
      // honest word here keeps a future edit from quietly restoring the
      // stronger claim in doctor's own output.
      assert.match(stdout, /^ {2}(info|warn) {2}ptys: \d+ of \d+ in use \(\d+ free\)/m);
    });
  },
);
