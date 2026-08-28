import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ageMs, assertYoungMs, bucket, reduceTraceLog, report, UNRESOLVED } from "../scripts/tmux-trace.mjs";
import { REPO, sessionsWorthReporting } from "./helpers.mjs";

const FIXTURES = join(REPO, "test", "fixtures", "tmux-trace");

function reduced(name) {
  return reduceTraceLog(readFileSync(join(FIXTURES, name), "utf8"), { file: name });
}

describe("what the tmux server trace says a pane was, from a real captured log", () => {
  const { panes } = reduced("tmux-server-40413.log");

  it("names the tmux command that created each pane, which a server's argv never could", () => {
    assert.deepEqual(
      panes.map((p) => p.verb),
      ["new-session", "new-window"],
    );
  });

  it("reads a pane with no cmd= line as the bare login shell the wedge needs", () => {
    assert.deepEqual(
      panes.map((p) => p.bare),
      [true, true],
    );
    const commanded = reduced("tmux-server-50001.log").panes;
    assert.deepEqual(
      commanded.map((p) => p.bare),
      [false],
      "the same parser must read a pane spawned with cmd= as commanded, or every pane looks bare",
    );
  });

  it("dates the destroy from the window's own destroyed line, not from the kill command's", () => {
    assert.equal(ageMs(panes[1]).toFixed(3), "7.299");
    assert.equal(ageMs(panes[0]).toFixed(3), "1022.877");
  });

  it("attributes the destroy to the tmux function that performed it", () => {
    assert.equal(panes[0].cause, "cmd_kill_session_exec (session probe1)");
    assert.equal(panes[1].cause, "cmd_kill_session_exec (session probe1)");
  });

  it("records the pane's cwd, which is what maps a pane back to the test file that made it", () => {
    assert.deepEqual(
      panes.map((p) => p.cwd),
      ["/scratch/project-a", "/scratch/project-a"],
    );
  });
});

describe("which destroy commands the trace counts", () => {
  it("counts a kill-session a client actually ran", () => {
    const { commands } = reduced("tmux-server-40413.log");
    assert.deepEqual(
      commands.map((c) => c.command),
      ["kill-session -t probe1"],
    );
  });

  it("does not count the kill-window and kill-pane inside a bind-key's bound command", () => {
    const source = readFileSync(join(FIXTURES, "tmux-server-40413.log"), "utf8");
    assert.match(source, /bind-key[^\n]*kill-window/, "the fixture must contain the trap this test is about");
    assert.match(source, /bind-key[^\n]*kill-pane/);

    const { commands } = reduceTraceLog(source);
    assert.equal(
      commands.filter((c) => /^bind-key/.test(c.command)).length,
      0,
      "a destroy verb is only a destroy when it starts the command, not when it is bound to a key",
    );
  });
});

describe("the session the tracer holds its server up with", () => {
  it("is not reported as a session the test file left behind, since it is the tracer's own", () => {
    assert.deepEqual(sessionsWorthReporting(["hive-trace-hold"]), []);
    assert.deepEqual(sessionsWorthReporting([""]), []);
  });

  it("does not hide a session the test file really did leave behind", () => {
    assert.deepEqual(sessionsWorthReporting(["hive-trace-hold", "leftover"]), ["leftover"]);
  });
});

describe("a pane that kill-pane destroyed before its window went", () => {
  it("is dated from the kill-pane, not from the window destroy hundreds of ms later", () => {
    const { panes } = reduced("tmux-server-60002.log");
    const split = panes.find((p) => p.verb === "split-window");

    assert.equal(split.pane, "%1", "the split's own pane id is what ties the kill-pane to it");
    assert.equal(split.cause, "kill-pane");
    assert.equal(ageMs(split).toFixed(3), "421.718");

    const windowDestroyed = panes.find((p) => p.verb === "new-session");
    assert.equal(ageMs(windowDestroyed).toFixed(3), "1280.286");
    assert.ok(
      ageMs(windowDestroyed) - ageMs(split) > 800,
      "the window outlived the killed pane by most of a second, which is the error this pins",
    );
  });

  it("is left undated when the kill-pane named a pane id the log never saw created", () => {
    const { panes } = reduced("tmux-server-60003.log");
    const inKilledWindow = panes.filter((p) => p.window === "@1");

    assert.equal(inKilledWindow.length, 2, "the kill-pane hit one of these two and the log cannot say which");
    for (const pane of inKilledWindow) {
      assert.equal(pane.destroyTs, null);
      assert.equal(pane.cause, UNRESOLVED);
    }
  });

  it("does not spread that doubt to a single-pane window, where the window destroy IS the kill", () => {
    const { panes } = reduced("tmux-server-60003.log");
    const alone = panes.find((p) => p.window === "@0");
    assert.notEqual(alone.cause, UNRESOLVED);
    assert.equal(ageMs(alone).toFixed(3), "1365.184");
  });
});

describe("the age bucket the wedge candidates are read out of", () => {
  it("separates a destroy inside the fork-to-setsid window from one just outside it", () => {
    assert.match(bucket(14.9, 15), /WEDGE CANDIDATE/);
    assert.doesNotMatch(bucket(15, 15), /WEDGE CANDIDATE/);
  });

  it("reports a pane with no destroy as unmeasured rather than as age zero", () => {
    assert.equal(ageMs({ createTs: 1, destroyTs: null }), null);
    assert.equal(bucket(null, 15), "age not measured");
  });

  it("keeps its band labels coherent when the young bound is wider than the bands", () => {
    assert.equal(bucket(150, 200), "under 200ms - WEDGE CANDIDATE");
    assert.equal(bucket(500, 200), "200-1000ms");
    assert.equal(bucket(5000, 200), "over 1000ms");
  });

  it("refuses a young bound it cannot compare with, rather than silently reporting no candidates", () => {
    assert.throws(() => assertYoungMs(Number("abc")), /--young-ms must be a positive number/);
    assert.throws(() => bucket(5, Number("abc")), /--young-ms must be a positive number/);
    assert.throws(() => assertYoungMs(0), /--young-ms must be a positive number/);
  });

  it("puts the bare young pane in the report's candidate list and leaves the old one out", () => {
    const { panes, commands } = reduced("tmux-server-40413.log");
    const lines = report(panes, commands, { youngMs: 15 }).join("\n");
    assert.match(lines, /bare panes destroyed under 15ms \(the wedge conjunction\): 1/);
    assert.match(lines, /7\.299ms {2}new-window -> cmd_kill_session_exec/);
    assert.doesNotMatch(lines, /1022\.877ms/);
  });
});
