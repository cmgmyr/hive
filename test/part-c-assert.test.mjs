import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";
import {
  assertNoIdleWhileSubagentsLive,
  assertPaneReadCoverageSufficient,
  assertRetentionCouldNotHaveEvicted,
  assertSubagentActuallyObserved,
  assertWakeDidNotDeliverIntoDialog,
  assertWakeFiredAfterLastCompletion,
  assertWakeFiredByIdleNotMaxWaitTimeout,
  assertWakeHeldThroughoutSubagentWindow,
  assertWorkerUsedItsOwnMcpServer,
  assertWorkingTreeUnchanged,
  runAllAssertions,
} from "../scripts/part-c-assert.mjs";

const toSqliteUtc = (d) => d.toISOString().slice(0, 19).replace("T", " ");

const MAX_WAIT_AT = "2026-01-01 00:06:00";

const READY_PANE_TAIL = "Claude Code\n> working on the assignment\n  ? for shortcuts\n";

const DIALOG_PANE_TAIL = "New MCP server found in this project: hive-iso\n1. Use this MCP server\nEsc to cancel\n";

function goodResult() {
  const done = [1767225690, 1767225700, 1767225710].map((epochSeconds, i) => ({
    path: `/scratch/completions/${i + 1}.completed`,
    done: true,
    epochSeconds,
  }));
  const notYetDone = [
    { path: "/scratch/completions/1.completed", done: false },
    { path: "/scratch/completions/2.completed", done: false },
    { path: "/scratch/completions/3.completed", done: false },
  ];
  return {
    agentStateLog: [
      { event: "prompt", state: "working", created_at: "2026-01-01 00:00:00.000", payload: '{"background_tasks":[]}' },

      {
        event: "stop",
        state: "working",
        created_at: "2026-01-01 00:01:00.000",
        payload: '{"background_tasks":[{"type":"subagent","status":"running"}]}',
      },
      { event: "stop", state: "idle", created_at: "2026-01-01 00:01:55.000", payload: '{"background_tasks":[]}' },
    ],

    agentStateLogGlobal: { lo: 1, hi: 3, count: 3, oldest: toSqliteUtc(new Date(Date.now() - 120_000)) },

    agentStateLogPreRunSpan: { lo: null, hi: null, count: 0, oldest: null },
    samples: [
      { t: 0, completions: notYetDone, firedAt: null, cancelledAt: null, maxWaitAt: MAX_WAIT_AT, paneTail: READY_PANE_TAIL },
      { t: 1, completions: notYetDone, firedAt: null, cancelledAt: null, maxWaitAt: MAX_WAIT_AT, paneTail: READY_PANE_TAIL },
      { t: 2, completions: notYetDone, firedAt: null, cancelledAt: null, maxWaitAt: MAX_WAIT_AT, paneTail: READY_PANE_TAIL },
      { t: 3, completions: notYetDone, firedAt: null, cancelledAt: null, maxWaitAt: MAX_WAIT_AT, paneTail: READY_PANE_TAIL },
      { t: 4, completions: done, firedAt: null, cancelledAt: null, maxWaitAt: MAX_WAIT_AT, paneTail: READY_PANE_TAIL },
      {
        t: 5,
        completions: done,
        firedAt: "2026-01-01 00:01:56",
        cancelledAt: null,
        maxWaitAt: MAX_WAIT_AT,
        paneTail: READY_PANE_TAIL,
      },
    ],
    gitBefore: { head: "abc123", status: "" },
    gitAfter: { head: "abc123", status: "" },
    distChecksumBefore: "deadbeef".repeat(8),
    distChecksumAfter: "deadbeef".repeat(8),
    mcpServerConfirmed: "mcp__hive-iso__whoami",
  };
}

describe("assertNoIdleWhileSubagentsLive", () => {
  it("passes on a genuinely correct run", () => {
    const proof = assertNoIdleWhileSubagentsLive(goodResult());
    assert.match(proof, /is after the last of the 3 completions/);
  });

  it("PROVES NOTHING when agent_state_log is empty", () => {
    const result = { ...goodResult(), agentStateLog: [] };
    assert.throws(() => assertNoIdleWhileSubagentsLive(result), /PROVES NOTHING.*no rows/);
  });

  it("PROVES NOTHING when fewer than 3 completions are tracked", () => {
    const result = { ...goodResult() };
    result.samples = [{ t: 0, completions: result.samples.at(-1).completions.slice(0, 2), firedAt: null }];
    assert.throws(() => assertNoIdleWhileSubagentsLive(result), /PROVES NOTHING.*exactly 3/);
  });

  it("PROVES NOTHING when no idle row was ever written", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.filter((r) => r.state !== "idle");
    assert.throws(() => assertNoIdleWhileSubagentsLive(result), /PROVES NOTHING.*no row.*state=idle/);
  });

  it("FAILS when idle was recorded before the last completion -- issue #24's own shape", () => {
    const result = goodResult();

    result.agentStateLog = [
      ...result.agentStateLog.filter((r) => r.state !== "idle"),
      { event: "stop", state: "idle", created_at: "2026-01-01 00:01:45.000" },
    ];
    assert.throws(() => assertNoIdleWhileSubagentsLive(result), /FAILS.*idle while a subagent was still live/);
  });
});

describe("assertWakeFiredAfterLastCompletion", () => {
  it("passes on a genuinely correct run", () => {
    const proof = assertWakeFiredAfterLastCompletion(goodResult());
    assert.match(proof, /is after the last of the 3 completions/);
  });

  it("PROVES NOTHING when fired_at is still null -- the exact shape of the real bug this lane found", () => {
    const result = goodResult();
    result.samples = result.samples.map((s) => ({ ...s, firedAt: null }));
    assert.throws(() => assertWakeFiredAfterLastCompletion(result), /PROVES NOTHING.*never fired/);
  });

  it("PROVES NOTHING when fewer than 3 completions are tracked", () => {
    const result = goodResult();
    result.samples = [{ t: 0, completions: [], firedAt: "2026-01-01 00:01:56" }];
    assert.throws(() => assertWakeFiredAfterLastCompletion(result), /PROVES NOTHING.*exactly 3/);
  });

  it("FAILS when the wake fired before the last completion", () => {
    const result = goodResult();

    result.samples[result.samples.length - 1].firedAt = "2026-01-01 00:01:48";
    assert.throws(() => assertWakeFiredAfterLastCompletion(result), /FAILS.*did not wait for the actual last completion/);
  });

  it("PROVES NOTHING, naming cancellation as the cause, when the timer was cancelled rather than never fired", () => {
    const result = goodResult();
    result.samples = result.samples.map((s) => ({ ...s, firedAt: null, cancelledAt: "2026-01-01 00:01:52" }));
    assert.throws(() => assertWakeFiredAfterLastCompletion(result), /PROVES NOTHING.*was cancelled at/);
  });

  it("FAILS loudly on a malformed timestamp, rather than silently passing on NaN", () => {
    const result = goodResult();
    result.samples[result.samples.length - 1].firedAt = "not-a-real-timestamp";
    assert.throws(() => assertWakeFiredAfterLastCompletion(result), /FAILS.*malformed timestamp/);
  });
});

describe("assertWakeFiredByIdleNotMaxWaitTimeout", () => {
  it("passes on a genuinely correct run: fired before max_wait_at, promptly after the triggering idle row", () => {
    const proof = assertWakeFiredByIdleNotMaxWaitTimeout(goodResult());
    assert.match(proof, /a genuine idle fire, not a max-wait timeout/);
  });

  it("PROVES NOTHING when fired_at is still null", () => {
    const result = goodResult();
    result.samples = result.samples.map((s) => ({ ...s, firedAt: null }));
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /PROVES NOTHING.*never fired/);
  });

  it("PROVES NOTHING, naming cancellation, when the timer was cancelled", () => {
    const result = goodResult();
    result.samples = result.samples.map((s) => ({ ...s, firedAt: null, cancelledAt: "2026-01-01 00:01:52" }));
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /PROVES NOTHING.*was cancelled at/);
  });

  it("PROVES NOTHING when no max_wait_at was captured", () => {
    const result = goodResult();
    result.samples = result.samples.map((s) => ({ ...s, maxWaitAt: null }));
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /PROVES NOTHING.*no max_wait_at/);
  });

  it("FAILS when fired_at is at or after max_wait_at -- a max-wait timeout fire, not a genuine idle fire", () => {
    const result = goodResult();
    result.samples[result.samples.length - 1].firedAt = MAX_WAIT_AT;
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /FAILS.*max-wait timeout fire/);
  });

  it("PROVES NOTHING when no idle row at or after the last completion exists to compare promptness against", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.filter((r) => r.state !== "idle");
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /PROVES NOTHING.*no idle row/);
  });

  it("FAILS when fired_at lands well outside the prompt window after the triggering idle row", () => {
    const result = goodResult();

    result.samples[result.samples.length - 1].firedAt = "2026-01-01 00:02:55";
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /FAILS.*outside the 30s window/);
  });

  it("PASSES when fired_at and the triggering idle row land in the SAME whole second, even though the idle row's fractional part is later", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.map((r) =>
      r.state === "idle" ? { ...r, created_at: "2026-01-01 00:01:55.700" } : r,
    );

    result.samples[result.samples.length - 1].firedAt = "2026-01-01 00:01:55";
    const proof = assertWakeFiredByIdleNotMaxWaitTimeout(result);
    assert.match(proof, /a genuine idle fire, not a max-wait timeout/);
  });

  it("still FAILS when fired_at is a full second or more BEFORE the triggering idle row's own whole second", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.map((r) =>
      r.state === "idle" ? { ...r, created_at: "2026-01-01 00:01:56.000" } : r,
    );
    result.samples[result.samples.length - 1].firedAt = "2026-01-01 00:01:55";
    assert.throws(() => assertWakeFiredByIdleNotMaxWaitTimeout(result), /FAILS.*BEFORE the first idle row/);
  });
});

describe("assertSubagentActuallyObserved", () => {
  it("passes when a stop row before the last completion shows a live subagent", () => {
    const proof = assertSubagentActuallyObserved(goodResult());
    assert.match(proof, /the gate's actual subject was exercised/);
  });

  it("PROVES NOTHING when agent_state_log is empty", () => {
    const result = { ...goodResult(), agentStateLog: [] };
    assert.throws(() => assertSubagentActuallyObserved(result), /PROVES NOTHING.*no rows/);
  });

  it("PROVES NOTHING when no row carries a payload column at all", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.map(({ payload, ...rest }) => rest);
    assert.throws(() => assertSubagentActuallyObserved(result), /PROVES NOTHING.*not selected/);
  });

  it("FAILS when no stop row before the last completion shows a live subagent (the worker never actually spawned one)", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.map((r) =>
      r.event === "stop" ? { ...r, payload: '{"background_tasks":[]}' } : r,
    );
    assert.throws(() => assertSubagentActuallyObserved(result), /FAILS.*never exercised the thing this gate exists to check/);
  });

  it("FAILS (not a silent pass) when the only live-subagent row lands after the last completion, too late to prove pre-completion work", () => {
    const result = goodResult();
    result.agentStateLog = [
      { event: "prompt", state: "working", created_at: "2026-01-01 00:00:00.000", payload: '{"background_tasks":[]}' },

      {
        event: "stop",
        state: "working",
        created_at: "2026-01-01 00:01:52.000",
        payload: '{"background_tasks":[{"type":"subagent","status":"running"}]}',
      },
      { event: "stop", state: "idle", created_at: "2026-01-01 00:01:55.000", payload: '{"background_tasks":[]}' },
    ];
    assert.throws(() => assertSubagentActuallyObserved(result), /FAILS.*never exercised/);
  });

  it("does not count a terminal-status subagent entry as live", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.map((r) =>
      r.event === "stop" && r.state === "working"
        ? { ...r, payload: '{"background_tasks":[{"type":"subagent","status":"completed"}]}' }
        : r,
    );
    assert.throws(() => assertSubagentActuallyObserved(result), /FAILS/);
  });

  it("does not count a live background shell (type != subagent) as a live subagent", () => {
    const result = goodResult();
    result.agentStateLog = result.agentStateLog.map((r) =>
      r.event === "stop" && r.state === "working"
        ? { ...r, payload: '{"background_tasks":[{"type":"shell","status":"running"}]}' }
        : r,
    );
    assert.throws(() => assertSubagentActuallyObserved(result), /FAILS/);
  });
});

describe("assertWakeHeldThroughoutSubagentWindow", () => {
  it("passes on a genuinely correct run", () => {
    const proof = assertWakeHeldThroughoutSubagentWindow(goodResult());
    assert.match(proof, /stayed null across all/);
  });

  it("PROVES NOTHING with too few samples to call it a sampled window", () => {
    const result = goodResult();
    result.samples = result.samples.slice(0, 2);
    assert.throws(() => assertWakeHeldThroughoutSubagentWindow(result), /PROVES NOTHING.*at least 5/);
  });

  it("PROVES NOTHING when every sample already shows completion -- no pre-completion window exists to check", () => {
    const result = goodResult();
    const done = result.samples.at(-1).completions;
    result.samples = result.samples.map((s) => ({ ...s, completions: done }));
    assert.throws(() => assertWakeHeldThroughoutSubagentWindow(result), /PROVES NOTHING.*no pre-completion window/);
  });

  it("FAILS when a pre-completion sample already shows fired_at set -- the wake fired early", () => {
    const result = goodResult();

    result.samples[2] = { ...result.samples[2], firedAt: "2026-01-01 00:01:40" };
    assert.throws(() => assertWakeHeldThroughoutSubagentWindow(result), /FAILS.*fired early/);
  });
});

describe("assertPaneReadCoverageSufficient", () => {
  it("passes when every sample carried a real pane read", () => {
    const proof = assertPaneReadCoverageSufficient(goodResult());
    assert.match(proof, /6\/6 samples \(100%\)/);
  });

  it("PROVES NOTHING when no samples were taken at all", () => {
    const result = { ...goodResult(), samples: [] };
    assert.throws(() => assertPaneReadCoverageSufficient(result), /PROVES NOTHING.*no samples/);
  });

  it("FAILS when too many samples have a null paneTail (agent_output kept failing)", () => {
    const result = goodResult();
    result.samples = result.samples.map((s, i) => (i < 5 ? { ...s, paneTail: null } : s));
    assert.throws(() => assertPaneReadCoverageSufficient(result), /FAILS.*agent_output failed too often/);
  });
});

describe("assertWakeDidNotDeliverIntoDialog", () => {
  it("passes when no dialog was ever observed", () => {
    const proof = assertWakeDidNotDeliverIntoDialog(goodResult());
    assert.match(proof, /no choice dialog was observed/);
  });

  it("passes when a dialog appears but fired_at stays null throughout -- the wake held", () => {
    const result = goodResult();
    result.samples[2] = { ...result.samples[2], paneTail: DIALOG_PANE_TAIL };
    const proof = assertWakeDidNotDeliverIntoDialog(result);
    assert.match(proof, /the wake held rather than delivering into it/);
  });

  it("PROVES NOTHING when no samples were taken at all", () => {
    const result = { ...goodResult(), samples: [] };
    assert.throws(() => assertWakeDidNotDeliverIntoDialog(result), /PROVES NOTHING.*no samples/);
  });

  it("PROVES NOTHING when no sample carried a real pane read", () => {
    const result = goodResult();
    result.samples = result.samples.map((s) => ({ ...s, paneTail: null }));
    assert.throws(() => assertWakeDidNotDeliverIntoDialog(result), /PROVES NOTHING.*no sample carried a real pane read/);
  });

  it("FAILS when a dialog is showing in the same sample fired_at is already set", () => {
    const result = goodResult();
    const lastIndex = result.samples.length - 1;
    result.samples[lastIndex] = { ...result.samples[lastIndex], paneTail: DIALOG_PANE_TAIL };
    assert.throws(
      () => assertWakeDidNotDeliverIntoDialog(result),
      /FAILS.*delivered into a dialog instead of holding/,
    );
  });
});

describe("assertWorkerUsedItsOwnMcpServer", () => {
  it("passes when the worker confirmed calling a mcp__hive-iso__ tool", () => {
    const proof = assertWorkerUsedItsOwnMcpServer(goodResult());
    assert.match(proof, /its own branch's hive-iso MCP server/);
  });

  it("PROVES NOTHING when no confirmation file was ever written", () => {
    const result = { ...goodResult(), mcpServerConfirmed: null };
    assert.throws(() => assertWorkerUsedItsOwnMcpServer(result), /PROVES NOTHING.*never completed step 0/);
  });

  it("FAILS when the confirmed tool name is not prefixed mcp__hive-iso__ -- a different registration answered", () => {
    const result = { ...goodResult(), mcpServerConfirmed: "mcp__hive__whoami" };
    assert.throws(() => assertWorkerUsedItsOwnMcpServer(result), /FAILS.*different hive registration answered/);
  });

  it("FAILS when the confirmation file's content is empty or garbage", () => {
    const result = { ...goodResult(), mcpServerConfirmed: "" };
    assert.throws(() => assertWorkerUsedItsOwnMcpServer(result), /FAILS/);
  });
});

describe("assertWorkingTreeUnchanged", () => {
  it("passes when HEAD and status are identical", () => {
    const proof = assertWorkingTreeUnchanged(goodResult());
    assert.match(proof, /identical before and after/);
  });

  it("PROVES NOTHING when a snapshot was never captured", () => {
    const result = { ...goodResult(), gitBefore: undefined };
    assert.throws(() => assertWorkingTreeUnchanged(result), /PROVES NOTHING.*git-before/);
  });

  it("FAILS when the working tree was dirtied during the run", () => {
    const result = goodResult();
    result.gitAfter = { ...result.gitAfter, status: " M some/file.ts\n" };
    assert.throws(() => assertWorkingTreeUnchanged(result), /FAILS.*working tree changed/);
  });

  it("FAILS when HEAD moved during the run", () => {
    const result = goodResult();
    result.gitAfter = { ...result.gitAfter, head: "def456" };
    assert.throws(() => assertWorkingTreeUnchanged(result), /FAILS.*HEAD moved/);
  });

  it("PROVES NOTHING when no dist/ checksum was captured", () => {
    const result = goodResult();
    result.distChecksumBefore = undefined;
    assert.throws(() => assertWorkingTreeUnchanged(result), /PROVES NOTHING.*no dist\/ checksum/);
  });

  it("FAILS when dist/'s checksum changed even though git HEAD and status did not", () => {
    const result = goodResult();
    result.distChecksumAfter = "f".repeat(64);
    assert.throws(() => assertWorkingTreeUnchanged(result), /FAILS.*dist\/'s content checksum changed/);
  });
});

describe("assertRetentionCouldNotHaveEvicted", () => {

  const NOW_MS = Date.parse("2026-01-01T00:02:00Z");
  const EMPTY_PRE_RUN = { lo: null, hi: null, count: 0, oldest: null };

  it("passes when the global span and age are both well inside pruneStateLog's bounds, and the pre-run boundary was empty with MIN(id) 1", () => {
    const result = {
      agentStateLogGlobal: { lo: 1, hi: 4, count: 4, oldest: "2026-01-01 00:00:00" },
      agentStateLogPreRunSpan: EMPTY_PRE_RUN,
    };
    const proof = assertRetentionCouldNotHaveEvicted(result, NOW_MS);
    assert.match(proof, /could not have evicted/);
    assert.match(proof, /no prune ran mid-run/);
  });

  it("PROVES NOTHING when no global span was captured", () => {
    assert.throws(
      () => assertRetentionCouldNotHaveEvicted({ agentStateLogGlobal: undefined }, NOW_MS),
      /PROVES NOTHING.*no global agent_state_log span/,
    );
  });

  it("FAILS when the global id span is at or over LOG_MAX_ROWS -- a row-count eviction could have run", () => {
    const result = {
      agentStateLogGlobal: { lo: 1, hi: 1 + 20_000, count: 20_000, oldest: "2026-01-01 00:00:00" },
      agentStateLogPreRunSpan: EMPTY_PRE_RUN,
    };
    assert.throws(() => assertRetentionCouldNotHaveEvicted(result, NOW_MS), /FAILS.*LOG_MAX_ROWS/);
  });

  it("FAILS when the oldest row is at or over the 7-day retention window -- an age eviction could have run", () => {
    const result = {
      agentStateLogGlobal: { lo: 1, hi: 4, count: 4, oldest: "2025-12-25 00:00:00" },
      agentStateLogPreRunSpan: EMPTY_PRE_RUN,
    };
    assert.throws(() => assertRetentionCouldNotHaveEvicted(result, NOW_MS), /FAILS.*retention window/);
  });

  it("PROVES NOTHING when no pre-run boundary was captured", () => {
    const result = { agentStateLogGlobal: { lo: 1, hi: 4, count: 4, oldest: "2026-01-01 00:00:00" } };
    assert.throws(
      () => assertRetentionCouldNotHaveEvicted(result, NOW_MS),
      /PROVES NOTHING.*no pre-run agent_state_log boundary/,
    );
  });

  it("FAILS when the store was empty pre-run but the post-run MIN(id) is not 1 -- a prune deleted this run's own row", () => {
    const result = {
      agentStateLogGlobal: { lo: 3, hi: 6, count: 4, oldest: "2026-01-01 00:00:00" },
      agentStateLogPreRunSpan: EMPTY_PRE_RUN,
    };
    assert.throws(
      () => assertRetentionCouldNotHaveEvicted(result, NOW_MS),
      /FAILS.*post-run global MIN\(id\) is 3, not 1/,
    );
  });

  it("passes (with a narrower note) when the store was not empty pre-run -- id alone cannot rule out a mid-run prune of this run's own rows", () => {
    const result = {
      agentStateLogGlobal: { lo: 1, hi: 8, count: 4, oldest: "2026-01-01 00:00:00" },
      agentStateLogPreRunSpan: { lo: 1, hi: 4, count: 4, oldest: "2025-12-31 23:00:00" },
    };
    const proof = assertRetentionCouldNotHaveEvicted(result, NOW_MS);
    assert.match(proof, /cannot be ruled out by id alone/);
  });
});

describe("runAllAssertions", () => {
  it("reports every assertion, all passing, on a genuinely correct run", () => {
    const report = runAllAssertions(goodResult());
    assert.equal(report.length, 10);
    assert.ok(report.every((a) => a.ok === true), JSON.stringify(report));
  });

  it("names each specific assertion that failed, not just that something did, when two independent things are both broken", () => {
    const result = goodResult();

    result.agentStateLog = [
      ...result.agentStateLog.filter((r) => r.state !== "idle"),
      { event: "stop", state: "idle", created_at: "2026-01-01 00:01:45.000" },
    ];

    result.gitAfter = { ...result.gitAfter, status: " M some/file.ts\n" };

    const report = runAllAssertions(result);
    const byName = Object.fromEntries(report.map((a) => [a.name, a]));
    assert.equal(byName["no idle while subagents live"].ok, false);
    assert.match(byName["no idle while subagents live"].error, /idle while a subagent was still live/);
    assert.equal(byName["working tree unchanged"].ok, false);
    assert.match(byName["working tree unchanged"].error, /working tree changed/);

    assert.equal(byName["wake fired after last completion"].ok, true);
    assert.equal(byName["wake held throughout the subagent window"].ok, true);
  });
});

describe("part-c-assert.mjs does not keep its own copy of the dialog predicate (todo 399)", () => {

  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports the predicate from dist/ instead of transcribing it", () => {
    const script = stripComments(readFileSync(join(REPO, "scripts", "part-c-assert.mjs"), "utf8"));

    assert.match(
      script,
      /screenAwaitingChoice.*dist\/tmux\.js/s,
      "part-c-assert.mjs must import the real predicate from this checkout's dist/, not re-derive it",
    );
    for (const declaration of [/const\s+CHOICE_DIALOG\s*=/, /const\s+INPUT_BOX_PRESENT\s*=/, /for shortcuts/]) {
      assert.doesNotMatch(
        script,
        declaration,
        `scripts/part-c-assert.mjs has grown its own copy of the dialog predicate again (${declaration}). ` +
          "That copy shipped todo 392's bug through its own acceptance run and went stale again in todo 399; " +
          "import screenAwaitingChoice from dist/tmux.js instead. See src/tmux.ts's own comment on that export.",
      );
    }
  });
});
