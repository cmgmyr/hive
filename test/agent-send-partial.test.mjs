import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs, until } from "./helpers.mjs";

// TODO 414. sendText (src/tmux.ts) is a paste and then, ENTER_DELAY_MS later,
// a SEPARATE tmux call for the Enter. Before this lane, a throw from that
// second call propagated as a bare TmuxError, and agent_send's synchronous
// caller reads a throw as "nothing was sent" - so it retries the whole send,
// pasting the same text onto the end of the stranded copy and submitting
// both as one message. On a claude pane that lands on top of todo 389's own
// clobber shape; on a PLAIN SHELL pane, which holdsHumanInput cannot see at
// all (.claude/rules/tmux-and-panes.md, "THIS PROTECTION IS
// CLAUDE-CHROME-SHAPED"), the merged line EXECUTES.
//
// Todo 386 (f0bec0e) built the mechanism this lane reuses rather than
// reinventing: sendText's onPasted callback fires the instant the PASTE
// CALL RETURNS, before the Enter is ever attempted - NOT "the instant the
// paste lands", which this file's own header claimed until the adversarial
// round corrected it. Those differ for a timed-out paste call: the server
// can finish a command after the client gives up on it
// (.claude/rules/tmux-and-panes.md's own "A TIMED-OUT PASTE..." paragraph),
// so a TmuxTimeoutError on the paste itself can throw before onPasted ever
// runs even though the text landed. That case gets its own hedged message
// ("may already be on screen"), tested below; only a confirmed pasted:true
// gets the confident one. Here there is a synchronous caller standing right
// there, so the fix is a truthful thrown error instead: the text WAS on
// screen, unsubmitted, the moment the paste returned, and the exact call
// that finishes it is agent_send(name, keys: ["Enter"]) - never a second
// text send, which is the thing this message exists to make read as
// obviously wrong.
//
// THE FAKE TMUX SHIM IS test/notice-partial-send.test.mjs's, reused rather
// than rebuilt (.claude/sessions/dead-ends/2026-08-14-killing-the-pane-mid-
// gap-to-reproduce-a-partial-send.md - killing the pane races a 300ms
// window and destroys the evidence; this env-var shim is deterministic and
// serves the Enter-fails case, the paste-fails control, and the
// paste-times-out case from one fixture).
//
// COVERS BOTH PANE KINDS, which notice-partial-send.test.mjs's own case C
// established matters for a real distinction: the existing pending-box
// guard (todo 317, holdsHumanInput) already blocks a blind text retry on a
// CLAUDE pane in production, so the danger there is a caller wasting a call
// on a refusal - not asserted directly here, since this file's claude pane
// is a static `cat` fixture and cannot stage a live pending box (see the
// claude-pane "finish" test's own comment). On a SHELL pane nothing blocks
// it at all, and this file's shell-pane retry test proves that case
// actually executes the merge rather than merely asserting the codebase's
// own claim about it.
const { hasTmux, cleanup } = isolateTmux("the agent_send partial-send tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "/usr/bin/false";
const shimDir = mkdtempSync(join(tmpdir(), "hive-sendpartial-"));
writeFileSync(
  join(shimDir, "tmux"),
  `#!/bin/sh
# HIVE_TEST_FAIL_ENTER: the submit only - \`send-keys -t <pane> Enter\`. A
# single-line text's paste (\`send-keys -l\`) and a multi-line paste
# (set-buffer + paste-buffer) are both untouched.
if [ "$HIVE_TEST_FAIL_ENTER" = "1" ] && [ "$1" = "send-keys" ]; then
  for a in "$@"; do
    if [ "$a" = "Enter" ]; then echo "tmux: send-keys failed" >&2; exit 1; fi
  done
fi
# HIVE_TEST_FAIL_PASTE: the control. Fails a single-line paste (\`send-keys
# -l\`) before anything reaches the pane, so the honest "nothing was sent"
# case must stay untouched by this lane's rewritten message.
if [ "$HIVE_TEST_FAIL_PASTE" = "1" ] && [ "$1" = "send-keys" ]; then
  for a in "$@"; do
    if [ "$a" = "-l" ]; then echo "tmux: send-keys failed" >&2; exit 1; fi
  done
fi
# HIVE_TEST_HANG: never answers the next send-keys call at all (paste or
# Enter, whichever comes first - for a single-line text that is always the
# paste). Combined with a short HIVE_TMUX_TIMEOUT_MS, this is what a
# TmuxTimeoutError on the PASTE call looks like from agent_send's side:
# adversarial-round finding 2, "pasted === false does not prove nothing
# reached the pane" - a timed-out client, not a failed one.
if [ "$HIVE_TEST_HANG" = "1" ] && [ "$1" = "send-keys" ]; then
  exec sleep 30
fi
exec ${realTmux} "$@"
`,
  { mode: 0o755 },
);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fakeClaude = makeFakeClaude(dirs.tmp);
// 220 columns: every fixture in that directory was captured at 220, and a
// narrower pane wraps its own box borders, which reads as no-box (todo 399,
// "A WRAPPED BORDER IS ONE EDGE") and would fail the claude-pane case for
// the wrong reason.
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp; // The ordinary client: no HIVE_TEST_FAIL_ENTER/PASTE, so every tmux
// call it makes passes through the shim untouched.

before(async () => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "60", "-c", dirs.projectDir]);
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
});

after(async () => {
  if (mcp) await mcp.close();
  cleanup(sessionName());
});

// placement: "window" for both spawns below, for the same reason
// typing-guards.test.mjs gives every worker its own window: a tiled split
// pane shrinks as more workers join the session, and this file's claude
// pane needs its full 60 rows for the fixture's own box to classify
// (see BOX_TAIL_ROWS / BOX_MAX_ROWS in .claude/rules/tmux-and-panes.md).
async function spawnClaude(name) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(replayFixture("ready-idle.txt")),
    extra_args: [],
    placement: "window",
  });
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt.agent_id;
}

// A REAL interactive bash, not a fixture cat - the claim under test
// ("the shell pane actually executes the merge") needs a shell that reads
// its own stdin, not a static screen. No claude chrome anywhere, so
// isClaudeCommand(agent.command) is false and holdsHumanInput can never see
// text sitting in this pane (.claude/rules/tmux-and-panes.md's own
// "CLAUDE-CHROME-SHAPED" section).
async function spawnShell(name) {
  const receipt = await mcp.call("agent_spawn", { name, command: "bash", extra_args: [], placement: "window" });
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt.agent_id;
}

// A second, short-lived MCP server per failing call, spawned WITH its extra
// env baked in at process start. Toggling process.env in THIS file, the way
// notice-partial-send.test.mjs does around its in-process tick() calls,
// cannot reach a spawned server's tmux calls: execFileSync inside that
// CHILD process reads the child's own env, fixed the moment node forked it,
// not this file's env at call time. `mcp` above is never given any of these
// variables, so its own tmux calls stay real for the rest of each test (the
// recovery agent_send(keys:["Enter"]), the blind retry, agent_output).
async function callWithBrokenTmux(env, name, text, submit = true) {
  const failMcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
  await failMcp.start();
  try {
    return await failMcp.call("agent_send", { name, text, submit });
  } finally {
    await failMcp.close();
  }
}

describe("agent_send tells the truth when the paste lands but the Enter fails (todo 414)", () => {
  it("on a claude pane: the sentence names the screen, the unsubmitted text, and the exact finishing call", NEEDS_TMUX, async () => {
    const name = "send414-claude-truth";
    await spawnClaude(name);

    // DIES if the catch block reverts to a bare rethrow: the message would
    // then be the shim's own "tmux: send-keys failed", matching none of the
    // three assertions below.
    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"), (err) => {
      assert.match(err.message, /^\[agent_send:paste-landed-enter-failed\]/, "must carry the stable machine tag");
      assert.match(err.message, /on the target's screen/i, "must say the text was on the target's screen");
      assert.match(err.message, /unsubmitted/i, "must say it is unsubmitted, not lost");
      assert.match(
        err.message,
        new RegExp(`agent_send\\(name: "${name}", keys: \\["Enter"\\]\\)`),
        "must name the exact call that finishes the delivery",
      );
      assert.doesNotMatch(
        err.message,
        /not sent/i,
        "must never say the text was NOT sent - that is false for this case and is the whole bug",
      );
      return true;
    });

    const { output } = await mcp.call("agent_output", { name });
    assert.match(output, /MARKERONE/, "the paste really landed - without this the case is not the incident's");
  });

  it("the named finishing call actually EXECUTES the stranded text, not just returns sent:true", NEEDS_TMUX, async () => {
    // Adversarial-round finding 4: the earlier version of this test used the
    // claude pane and asserted only `finished.sent === true`, which stays
    // green even if the keys path stops calling tmux at all and just
    // fabricates a receipt - the exact false-green shape counselors' codex
    // seat already found once on this file's sibling suite
    // (test/typing-guards.test.mjs's own comment: "a handler returning
    // {sent: true} without ever calling sendText kept all of them green").
    // A static cat fixture has nothing listening on stdin to prove a real
    // Enter landed, so this uses the SHELL pane instead, where a submitted
    // "MARKERONE" is something bash actually tries to run - proof read off
    // the pane, not off the receipt's own claim about itself.
    //
    // NOT ASSERTED HERE, and it never was: that a blind text retry (rather
    // than the named keys call) would instead be refused by the pre-existing
    // pending-box guard (todo 317). It would be, on a claude pane, in
    // production - a stranded send-keys -l paste carries no faint
    // attribute, same mechanism as test/fixtures/panes/real-input.txt - but
    // this file's claude pane is a static `cat` of a fixture and cannot
    // stage a live pending box: a live send-keys types where the pty's
    // cursor actually sits (the row below the fixture's last printed line),
    // not into the box the fixture merely PRINTS as text.
    // test/typing-guards.test.mjs's own compose-finish test hits the
    // identical limit and says so in the same words; it covers that guard by
    // starting FROM a fixture that already has the pending text baked in.
    // The shell-pane retry test below is where this lane's own claim -
    // nothing stops a blind retry there - is demonstrated end to end.
    const name = "send414-shell-finish";
    await spawnShell(name);
    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"));

    // THE RIGHT MOVE: the exact call the error named.
    const finished = await mcp.call("agent_send", { name, keys: ["Enter"] });
    assert.equal(finished.sent, true);

    await until(async () => /not found/.test((await mcp.call("agent_output", { name })).output));
    const { output } = await mcp.call("agent_output", { name });
    assert.match(output, /MARKERONE.*not found/s, "bash must have actually run the stranded line, not a merged one");
    assert.equal(
      (output.match(/not found/g) ?? []).length,
      1,
      "exactly one execution - the stranded text alone, cleanly submitted",
    );
  });

  it("a worker cannot be told to finish it themselves against a LEAD target - the remedy names who can", NEEDS_TMUX, async () => {
    // BLOCKING, adversarial round: the first version of this message always
    // named agent_send(name, keys:["Enter"]) as the fix, which agents.ts's
    // own keys-path guard (a worker calling keys against a lead) refuses -
    // exactly the human's-pane scenario todo 414 was filed about. Seeded
    // directly on the row, matching test/typing-guards.test.mjs's own
    // "showingAsLead" pattern, since minting a real lead identity is a
    // different test's job (lead-identity.test.mjs).
    const name = "send414-claude-lead-target";
    const agentId = await spawnClaude(name);
    const { db } = await import("../dist/db.js");
    db.prepare("UPDATE agents SET kind = 'lead' WHERE id = ?").run(agentId);

    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"), (err) => {
      assert.match(err.message, /^\[agent_send:paste-landed-enter-failed\]/);
      assert.match(err.message, /on the target's screen/i);
      assert.match(err.message, /cannot finish this yourself/i, "must say plainly the caller has no way through");
      assert.doesNotMatch(
        err.message,
        /keys: \["Enter"\]/,
        "must NOT name a call the keys-path guard would itself refuse",
      );
      return true;
    });
  });

  it("a paste call that TIMES OUT is reported as ambiguous, not as a confirmed landing or a confirmed miss", NEEDS_TMUX, async () => {
    // Adversarial-round finding 2. HIVE_TEST_HANG makes the shim never
    // answer the paste's own send-keys call, and a short HIVE_TMUX_TIMEOUT_MS
    // (the same testing-only override test/tmux-timeout.test.mjs uses) turns
    // that into a real TmuxTimeoutError inside the production window rather
    // than a 10-second wait. onPasted can never fire here - the paste call
    // itself never returns - so `pasted` stays false, and the fix has to
    // tell that apart from a call that genuinely FAILED (this file's control
    // test below) rather than one that merely never answered.
    const name = "send414-claude-timeout";
    await spawnClaude(name);

    await assert.rejects(
      callWithBrokenTmux({ HIVE_TEST_HANG: "1", HIVE_TMUX_TIMEOUT_MS: "300" }, name, "MARKERONE"),
      (err) => {
        assert.match(err.message, /^\[agent_send:paste-timeout-ambiguous\]/, "must carry its own, distinct tag");
        assert.match(err.message, /MAY already be on/i, "must hedge - a timeout is not proof either way");
        assert.doesNotMatch(
          err.message,
          /\[agent_send:paste-landed-enter-failed\]/,
          "must not claim the confirmed-landed case - the paste call never returned to confirm anything",
        );
        return true;
      },
    );
  });

  it("on a plain shell pane: the same three facts, on the pane the existing guard cannot see at all", NEEDS_TMUX, async () => {
    const name = "send414-shell-truth";
    await spawnShell(name);

    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"), (err) => {
      assert.match(err.message, /^\[agent_send:paste-landed-enter-failed\]/);
      assert.match(err.message, /on the target's screen/i);
      assert.match(err.message, /unsubmitted/i);
      assert.match(err.message, new RegExp(`agent_send\\(name: "${name}", keys: \\["Enter"\\]\\)`));
      return true;
    });

    const { output } = await mcp.call("agent_output", { name });
    assert.match(output, /MARKERONE/, "the paste landed on the shell pane too - same failure, no chrome to show it");
  });

  it("a blind text retry on the shell pane merges and EXECUTES - the case this message exists to stop", NEEDS_TMUX, async () => {
    const name = "send414-shell-retry";
    await spawnShell(name);
    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"));

    // Nothing refuses this. holdsHumanInput's box detector finds claude's
    // own chrome; a bash pane has none (.claude/rules/tmux-and-panes.md,
    // "THIS PROTECTION IS CLAUDE-CHROME-SHAPED"). The retry pastes onto the
    // end of the stranded copy, and this time the Enter succeeds, so bash
    // receives ONE line carrying BOTH copies concatenated and runs it.
    const retry = await mcp.call("agent_send", { name, text: "MARKERONE" });
    assert.equal(retry.sent, true, "no guard exists for this pane - that absence is the defect the message covers");

    await until(async () => /not found/.test((await mcp.call("agent_output", { name })).output));
    const { output } = await mcp.call("agent_output", { name });
    assert.match(
      output,
      /MARKERONEMARKERONE/,
      "bash ran ONE line carrying both attempts concatenated, not two separate MARKERONE commands",
    );
    assert.equal(
      (output.match(/not found/g) ?? []).length,
      1,
      "one shell execution, not two - the two agent_send calls became a single merged command",
    );
  });

  it("the paste itself failing (nothing on screen) is untouched - the honest 'nothing was sent' case", NEEDS_TMUX, async () => {
    // CONTROL. DIES if the rewrite is not gated on onPasted actually firing:
    // a version that rewrites every sendText failure, not only the ones
    // where the paste landed, would turn this pre-existing, correct
    // "nothing happened" error into a false claim that text is on screen.
    const name = "send414-claude-paste-failed";
    await spawnClaude(name);

    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_PASTE: "1" }, name, "MARKERONE"), (err) => {
      assert.doesNotMatch(err.message, /\[agent_send:/, "neither new tag may appear - nothing reached the pane");
      assert.doesNotMatch(err.message, /on the target's screen/i, "nothing reached the pane - this sentence must not fire");
      assert.match(err.message, /send-keys failed/, "the original tmux failure must propagate unchanged");
      return true;
    });

    const { output } = await mcp.call("agent_output", { name });
    assert.doesNotMatch(output, /MARKERONE/, "the text really never reached the pane in this case");
  });

  it("a name carrying a double quote still produces a call the caller can copy-paste and run", NEEDS_TMUX, async () => {
    // Adversarial-round finding 3. normalizeAgentName (agents.ts, near line
    // 604) blocks control characters and nothing else, so a name like
    // `ba"tch` is valid. Naive string interpolation
    // (`agent_send(name: "${name}", ...)`) would then emit
    // `agent_send(name: "ba"tch", keys: ["Enter"])`, which does not parse -
    // the only advertised recovery would itself be broken. JSON.stringify
    // escapes it instead.
    const name = 'send414-shell-quote"mark';
    await spawnShell(name);

    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"), (err) => {
      // Plain substring, not a regex: JSON.stringify(name) already contains
      // regex metacharacters (the embedded `"`), so re-parsing it into a
      // RegExp would just reintroduce the escaping bug this test exists to
      // catch, one layer up.
      assert.ok(
        err.message.includes(`agent_send(name: ${JSON.stringify(name)}, keys: ["Enter"])`),
        `emitted call must be the JSON-escaped name; got: ${err.message}`,
      );
      return true;
    });
  });
});
