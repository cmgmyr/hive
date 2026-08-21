import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs, until } from "./helpers.mjs";

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

const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp;

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

async function spawnShell(name) {
  const receipt = await mcp.call("agent_spawn", { name, command: "bash", extra_args: [], placement: "window" });
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt.agent_id;
}

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

    const name = "send414-shell-finish";
    await spawnShell(name);
    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"));

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

  it("a SHORTENED send's enter-failed message names the pointer on screen, not the text the caller wrote (todo 475)", NEEDS_TMUX, async () => {

    const name = "send475-lead-shortened";
    const agentId = await spawnClaude(name);
    const { db } = await import("../dist/db.js");
    db.prepare("UPDATE agents SET kind = 'lead' WHERE id = ?").run(agentId);
    // Past the pointer's head budget, so the pointer cannot legitimately quote it and the assertion below
    // distinguishes shortened from verbatim rather than passing on where the marker happened to sit.
    const text = `${"a".repeat(400)} MARKERONE ${"a".repeat(500)}`;

    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, text), (err) => {
      assert.match(err.message, /^\[agent_send:paste-landed-enter-failed\]/, "the stable tag must not change");
      assert.match(
        err.message,
        /\[hive message #\d+ from [^,]+, \d+ chars\]/,
        "it must name the pointer that is actually on that screen - without it the caller hunts for its own words",
      );
      assert.match(err.message, /agent_message_get\(\d+\)/, "and say the full text is stored, with the id");
      assert.match(err.message, /INTENDED finish/, "a human reading a line they did not write must be told Enter is right");
      return true;
    });

    const { output } = await mcp.call("agent_output", { name });
    assert.doesNotMatch(output, /MARKERONE/, "the caller's own text must NOT be on the lead's screen");
  });

  it("a SHORTENED send's paste-timeout message says the same, since neither error can describe the caller's text (todo 475)", NEEDS_TMUX, async () => {

    const name = "send475-lead-timeout";
    const agentId = await spawnClaude(name);
    const { db } = await import("../dist/db.js");
    db.prepare("UPDATE agents SET kind = 'lead' WHERE id = ?").run(agentId);

    await assert.rejects(
      callWithBrokenTmux({ HIVE_TEST_HANG: "1", HIVE_TMUX_TIMEOUT_MS: "300" }, name, "b".repeat(900)),
      (err) => {
        assert.match(err.message, /^\[agent_send:paste-timeout-ambiguous\]/);
        assert.match(
          err.message,
          /\[hive message #\d+ from [^,]+, 900 chars\]/,
          "\"only send again if the text genuinely is not there\" is unusable without naming what to look for",
        );
        assert.match(err.message, /agent_message_get\(\d+\)/);
        return true;
      },
    );
  });

  it("a paste call that TIMES OUT is reported as ambiguous, not as a confirmed landing or a confirmed miss", NEEDS_TMUX, async () => {

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

    const name = 'send414-shell-quote"mark';
    await spawnShell(name);

    await assert.rejects(callWithBrokenTmux({ HIVE_TEST_FAIL_ENTER: "1" }, name, "MARKERONE"), (err) => {

      assert.ok(
        err.message.includes(`agent_send(name: ${JSON.stringify(name)}, keys: ["Enter"])`),
        `emitted call must be the JSON-escaped name; got: ${err.message}`,
      );
      return true;
    });
  });
});
