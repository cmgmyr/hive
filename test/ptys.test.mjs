import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DIST, isolateTmux, runCli, runFixture, scratchDirs } from "./helpers.mjs";
import {
  countAllocatedTtys,
  countOrphanLoginShells,
  filterOrphanLoginShellsWithAge,
  isLowHeadroom,
  parseEtimeSeconds,
  parsePsSnapshot,
  parsePsSnapshotWithAge,
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

describe("parseEtimeSeconds", () => {
  it("parses mm:ss", () => {
    assert.equal(parseEtimeSeconds("05:30"), 330);
  });

  it("parses hh:mm:ss", () => {
    assert.equal(parseEtimeSeconds("02:05:30"), 2 * 3600 + 5 * 60 + 30);
  });

  it("parses dd-hh:mm:ss", () => {
    assert.equal(parseEtimeSeconds("3-02:05:30"), 3 * 86400 + 2 * 3600 + 5 * 60 + 30);
  });

  it("parses bare seconds", () => {
    assert.equal(parseEtimeSeconds("45"), 45);
  });

  it("returns null for unparseable input rather than guessing", () => {
    assert.equal(parseEtimeSeconds("not-an-etime"), null);
  });
});

describe("parsePsSnapshotWithAge", () => {
  const OUTPUT = [
    "  501     1 12:00:00 ttys001 -zsh",
    "  502   501 00:00:05 ttys001 node",
    "  503     1 45:00    ttys002 -bash",
  ].join("\n");

  it("parses pid, ppid, age, tty and comm from `ps -eo pid=,ppid=,etime=,tty=,comm=` output", () => {
    const parsed = parsePsSnapshotWithAge(OUTPUT);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], { pid: 501, ppid: 1, ageMs: 12 * 3600 * 1000, tty: "ttys001", comm: "-zsh" });
  });

  it("skips a row whose etime does not parse", () => {
    const parsed = parsePsSnapshotWithAge(`${OUTPUT}\n  504     1 garbage ttys003 -zsh`);
    assert.equal(parsed.length, 3);
  });
});

describe("filterOrphanLoginShellsWithAge", () => {
  it("keeps only ppid-1 rows whose comm has a leading dash, reusing isOrphanLoginShell", () => {
    const parsed = parsePsSnapshotWithAge(
      [
        "  501     1 12:00:00 ttys001 -zsh",
        "  502   501 00:00:05 ttys001 node",
        "  503     1 02:00:00 ttys002 -bash",
        "  504     1 00:01:00 ??      launchd",
      ].join("\n"),
    );
    const shells = filterOrphanLoginShellsWithAge(parsed);
    assert.deepEqual(
      shells.map((s) => s.pid),
      [501, 503],
    );
  });

  it("returns an empty list rather than throwing when nothing qualifies", () => {
    assert.deepEqual(filterOrphanLoginShellsWithAge([]), []);
  });
});

describe("orphanLoginShellDetails degrades instead of crashing when its own probe fails (lead's PR #229 finding)", () => {
  it("returns null, not a thrown exception, when the real ps process exits non-zero", () => {
    const { tmp } = scratchDirs();
    const failingPsBin = join(tmp, "failing-ps-only");
    mkdirSync(failingPsBin, { recursive: true });
    writeFileSync(join(failingPsBin, "ps"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(failingPsBin, "ps"), 0o755);

    const out = runFixture(
      tmp,
      "orphan-shells-ps-fails",
      `const { orphanLoginShellDetails } = await import(${JSON.stringify(join(DIST, "ptys.js"))});\n` +
        `process.stdout.write(JSON.stringify(orphanLoginShellDetails()));\n`,
      { PATH: failingPsBin },
    );

    assert.equal(
      out,
      null,
      "a failing ps process must degrade to null, not throw out of the caller - this was the crash the escalation hit on Linux CI",
    );
  });

  it("returns null, not a thrown exception, when HIVE_PTY_PS_ROWS_JSON is malformed", () => {
    const { tmp } = scratchDirs();
    const out = runFixture(
      tmp,
      "orphan-shells-malformed-json",
      `const { orphanLoginShellDetails } = await import(${JSON.stringify(join(DIST, "ptys.js"))});\n` +
        `process.stdout.write(JSON.stringify(orphanLoginShellDetails()));\n`,
      { HIVE_PTY_PS_ROWS_JSON: "{oops" },
    );

    assert.equal(out, null, "malformed override JSON must degrade to null the same way a failed ps process does");
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
