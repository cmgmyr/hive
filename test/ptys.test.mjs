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

const { cleanup } = isolateTmux("the ptys doctor-wiring test");

const PS_FIXTURE = [
  "ttys000    501 -zsh",
  "ttys000  60234 node",
  "ttys001      1 -zsh",
  "ttys002      1 -bash",
  "??            1 launchd",
  "ttys003    501 zsh",
  "ttys004      1 /usr/local/bin/-fish",
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

    assert.equal(isLowHeadroom({ allocated: 460, max: 511 }), false);
  });

  it("warns one pty below the threshold", () => {

    assert.equal(isLowHeadroom({ allocated: 461, max: 511 }), true);
  });

  it("does not warn one pty above the threshold", () => {

    assert.equal(isLowHeadroom({ allocated: 459, max: 511 }), false);
  });

  it("uses the floor, not the raw percentage, on a small max", () => {

    assert.equal(isLowHeadroom({ allocated: 68, max: 100 }), false);
    assert.equal(isLowHeadroom({ allocated: 69, max: 100 }), true);
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

    assert.equal(
      safeProbe(() => {
        throw new Error("sysctl: unknown oid 'kern.tty.ptmx_max'");
      }),
      null,
    );
  });
});

describe(
  "hive doctor's own ptys line, against the real machine",
  { skip: platform() === "darwin" || platform() === "linux" ? false : "unsupported platform" },
  () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

    after(() => cleanup());

    it("prints an info or warn ptys line shaped like doctor's own report()", async () => {
      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /^ {2}(info|warn) {2}ptys: \d+ of \d+ in use \(\d+ free\)/m);
    });
  },
);
