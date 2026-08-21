import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead-message shortening tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { LEAD_MESSAGE_THRESHOLD, renderLeadPointer } = await import("../dist/leadMessage.js");

const { join } = await import("node:path");
const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fakeClaude = makeFakeClaude(dirs.tmp);
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

// The pane wraps at its width, so a marker can straddle a line break. Every pane assertion below runs
// against the whitespace-stripped screen: without this, an absent-marker assertion passes for the wrong
// reason the moment the marker lands on a wrap boundary.
const unwrapped = (screen) => screen.replace(/\s+/g, "");

const DEEP = "ZQXDEEPMARKERZQX";
const filler = (n) => "a".repeat(n);
// The marker sits past the head budget on purpose: a message whose marker fell inside the first 140
// characters would be quoted by the pointer itself, and the test could not tell shortened from verbatim.
const bodyOf = (length) => {
  const text = `${filler(200)} ${DEEP} ${filler(Math.max(0, length - 218))}`;
  return text.slice(0, length);
};

let mcp;
let db;

before(async () => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "60", "-c", dirs.projectDir]);
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
  ({ db } = await import("../dist/db.js"));
});

after(async () => {
  if (mcp) await mcp.close();
  cleanup(sessionName());
});

async function spawnAgent(name) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(replayFixture("ready-idle.txt")),
    extra_args: [],
    placement: "window",
  });
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt.agent_id;
}

async function spawnLead(name) {
  const agentId = await spawnAgent(name);
  db.prepare("UPDATE agents SET kind = 'lead' WHERE id = ?").run(agentId);
  return agentId;
}

// The sender's name has to come from a real actor row, so the caller runs as a spawned worker rather
// than as the test's own human actor. Without this the pointer would only ever be pinned against the
// fallback, and the interpolation this lane has to flatten would never be exercised.
async function sendAs(actorId, args, agentName) {
  const asWorker = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_AGENT_ID: actorId, ...(agentName ? { HIVE_AGENT_NAME: agentName } : {}) },
  });
  await asWorker.start();
  try {
    return await asWorker.call("agent_send", args);
  } finally {
    await asWorker.close();
  }
}

async function screen(name) {
  return unwrapped((await mcp.call("agent_output", { name, lines: 200 })).output);
}

describe("todo 475: a long worker message to a lead lands as a pointer, and the text stays retrievable", () => {
  it("types the pointer, not the message, and the pointer carries sender, size and the lookup", NEEDS_TMUX, async () => {
    const name = "t475-lead-long";
    await spawnLead(name);
    const sender = "t475-reporter";
    const senderId = await spawnAgent(sender);
    const senderActor = db.prepare("SELECT actor_id FROM agents WHERE id = ?").get(senderId).actor_id;
    const text = bodyOf(900);

    const receipt = await sendAs(senderActor, { name, text });
    assert.equal(receipt.sent, true, "the send succeeded - shortening is not a failure");
    assert.equal(receipt.shortened, true);
    assert.equal(typeof receipt.message_id, "number");

    await until(async () => (await screen(name)).includes("agent_message_get("));
    const shown = await screen(name);
    assert.ok(shown.includes(`[hivemessage#${receipt.message_id}`), "the pointer names its own id");
    assert.ok(shown.includes(`from${sender},`), "the pointer names who sent it, by that worker's own name");
    assert.ok(shown.includes("900chars"), "the pointer says how much it is not showing");
    assert.ok(
      !shown.includes(DEEP),
      "the body past the head must NOT be on the lead's screen - that is the whole defect",
    );
  });

  it("hands back the full text byte for byte behind the id the pointer named", NEEDS_TMUX, async () => {
    const name = "t475-lead-retrieve";
    await spawnLead(name);
    const text = bodyOf(1200);

    const receipt = await mcp.call("agent_send", { name, text });
    const got = await mcp.call("agent_message_get", { message_id: receipt.message_id });
    assert.equal(got.text, text, "a lookup that loses a byte is worse than the noise it replaced");
    assert.equal(got.chars, 1200);
    assert.equal(got.to_agent_id, (await mcp.call("agent_status", { name })).agent_id);
    assert.ok(got.from_actor.length > 0 && got.from.length > 0, "a stored message must say who sent it");
  });

  it("tells the sender its message was shortened, and what to do about it", NEEDS_TMUX, async () => {
    const name = "t475-lead-receipt";
    await spawnLead(name);

    const receipt = await mcp.call("agent_send", { name, text: bodyOf(900) });
    assert.match(receipt.note, /agent_message_get\(\d+\)/, "the receipt names the lookup, not just the fact");
    assert.match(receipt.note, /todo/i, "it must point at the durable copy, not only at the id");
    assert.match(receipt.note, /140/, "it must say how much of the message actually reaches the lead");
  });
});

describe("todo 475: the pointer's first job is saying WHO, so the name resolves past the agents table", () => {
  it("names a sender that has no agents row in this project, from its actor record", NEEDS_TMUX, async () => {
    const name = "t475-no-agent-row";
    await spawnLead(name);
    const stranger = "agent:900475";

    const receipt = await sendAs(stranger, { name, text: bodyOf(900) }, "faraway-worker");

    const got = await mcp.call("agent_message_get", { message_id: receipt.message_id });
    assert.equal(got.from_actor, stranger);
    assert.equal(
      got.from,
      "faraway-worker",
      "a sender with no agents row here still has an actor record, and `agent:900475` names nobody",
    );
    await until(async () => (await screen(name)).includes("agent_message_get("));
    assert.ok((await screen(name)).includes("fromfaraway-worker,"), "and that is the name the pointer shows");
  });

  it("falls back to the actor id when nothing names the sender, rather than to an empty slot", NEEDS_TMUX, async () => {
    const name = "t475-nameless-sender";
    await spawnLead(name);
    const nameless = "agent:900476";

    const receipt = await sendAs(nameless, { name, text: bodyOf(900) });

    const got = await mcp.call("agent_message_get", { message_id: receipt.message_id });
    assert.equal(got.from, nameless, "an unnamed sender renders as its id - never as blank, null or undefined");
    await until(async () => (await screen(name)).includes("agent_message_get("));
    assert.ok((await screen(name)).includes(`from${nameless},`), "and the pointer shows it rather than a gap");
  });
});

describe("todo 475: the threshold, on both sides of it and exactly on it", () => {
  it("passes a message exactly at the threshold through verbatim", NEEDS_TMUX, async () => {
    const name = "t475-at";
    await spawnLead(name);
    const text = bodyOf(LEAD_MESSAGE_THRESHOLD);
    assert.equal(text.length, 300, "the fixture must actually sit on the boundary");

    const receipt = await mcp.call("agent_send", { name, text });
    assert.equal(receipt.shortened, undefined, "the boundary itself is NOT shortened - the test is > not >=");
    await until(async () => (await screen(name)).includes(DEEP));
  });

  it("shortens one character past the threshold", NEEDS_TMUX, async () => {
    const name = "t475-just-over";
    await spawnLead(name);

    const receipt = await mcp.call("agent_send", { name, text: bodyOf(LEAD_MESSAGE_THRESHOLD + 1) });
    assert.equal(receipt.shortened, true, "301 characters is over the line; 300 was not");
  });

  it("leaves a short urgent message whole, so it needs no lookup", NEEDS_TMUX, async () => {
    const name = "t475-short";
    await spawnLead(name);
    const text = `BLOCKED, the machine is wedged. ${DEEP}`;

    const receipt = await mcp.call("agent_send", { name, text });
    assert.equal(receipt.shortened, undefined);
    assert.equal(receipt.message_id, undefined, "nothing is stored for a message that was not shortened");
    await until(async () => (await screen(name)).includes(DEEP));
  });
});

describe("todo 475: a WORKER-bound send is verbatim at the same length, because there the body is the instruction", () => {
  it("does not shorten 900 characters sent to a worker, and stores nothing", NEEDS_TMUX, async () => {
    const name = "t475-worker-long";
    await spawnAgent(name);

    const before = db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n;
    const receipt = await mcp.call("agent_send", { name, text: bodyOf(900) });
    assert.equal(receipt.shortened, undefined, "widening this to workers would truncate assignments");
    assert.equal(receipt.message_id, undefined);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM agent_messages").get().n,
      before,
      "a worker-bound send must not write a row either - storage follows the same predicate as delivery",
    );

    await until(async () => (await screen(name)).includes(DEEP));
  });
});

describe("todo 475: a pointer outlives its message, so a lookup that misses says WHICH miss it is", () => {
  it("says a pruned id expired, naming the retention, rather than reporting it missing", NEEDS_TMUX, async () => {
    const name = "t475-pruned";
    await spawnLead(name);
    const receipt = await mcp.call("agent_send", { name, text: bodyOf(900) });

    db.prepare("DELETE FROM agent_messages WHERE id = ?").run(receipt.message_id);

    await assert.rejects(mcp.call("agent_message_get", { message_id: receipt.message_id }), (err) => {
      assert.match(err.message, /\[agent_message_get:pruned\]/, "a stable tag, so a caller need not parse prose");
      assert.match(err.message, /7 days/, "it must name the bound that deleted it");
      assert.match(err.message, /EXISTED/, "it must say the id was real");
      assert.doesNotMatch(
        err.message,
        /never/i,
        "an expired message must not read as one that never existed - that is the false claim this pins",
      );
      return true;
    });
  });

  it("distinguishes an id that was never issued from one that expired", NEEDS_TMUX, async () => {
    await assert.rejects(mcp.call("agent_message_get", { message_id: 999_999 }), (err) => {
      assert.match(err.message, /\[agent_message_get:never-issued\]/);
      assert.doesNotMatch(
        err.message,
        /\[agent_message_get:pruned\]/,
        "nothing was deleted here, and claiming expiry sends the reader after a retention bound",
      );
      return true;
    });
  });

  it("refuses another project's message as a scoping refusal, not as a miss", NEEDS_TMUX, async () => {
    const { id } = db
      .prepare(
        `INSERT INTO agent_messages (project_id, from_actor, from_name, to_agent_id, text)
         VALUES (99999, 'agent:1', 'elsewhere', 1, 'other project text') RETURNING id`,
      )
      .get();

    await assert.rejects(mcp.call("agent_message_get", { message_id: id }), (err) => {
      assert.match(err.message, /\[agent_message_get:other-project\]/);
      assert.doesNotMatch(err.message, /other project text/, "a refusal must not leak the row it is refusing");
      return true;
    });
    db.prepare("DELETE FROM agent_messages WHERE id = ?").run(id);
  });

  it("the janitor really deletes a message past the retention bound", NEEDS_TMUX, async () => {
    const name = "t475-janitor";
    await spawnLead(name);
    const receipt = await mcp.call("agent_send", { name, text: bodyOf(900) });

    db.prepare("UPDATE agent_messages SET created_at = datetime('now', '-8 days') WHERE id = ?").run(
      receipt.message_id,
    );
    const { tick } = await import("../dist/scheduler.js");
    await tick(null);

    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE id = ?").get(receipt.message_id).n,
      0,
      "without this, the pruned branch above is testing a state the janitor never actually produces",
    );
  });
});

describe("todo 475: the pointer is typed into a pane, so every interpolated field is flattened", () => {
  it("collapses newlines and tabs out of both the head and the sender's name", () => {
    const line = renderLeadPointer(7, "wor\rker\tname", `first\nline\r\nsecond\ttab ${"b".repeat(400)}`);
    assert.doesNotMatch(line, /[\p{Cc}\p{Cf}]/u, "a raw control byte reaches tmux as a keystroke, not as text");
    assert.match(line, /wor ker name/, "the control byte becomes a space - the name is flattened, not dropped");
    assert.match(line, /first line second tab/, "the head is flattened, not dropped");
  });

  it("strips FORMAT characters too, which agent_send's own validator lets through", () => {
    // \u00AD SOFT HYPHEN and \u200D ZERO WIDTH JOINER are \p{Cf}, not \p{Cc}, so findUnsafeControlChar
    // (code <= 0x1f || 0x7f) passes them and they reach this render through the real path. Narrowing
    // flatten to \p{Cc} alone - the shape a merge with slug.ts's stripControlChars would produce - passes
    // every other test in this repo, which is why this case exists rather than a comment saying not to.
    const line = renderLeadPointer(7, "wor\u00ADker", `zero\u200Dwidth ${"d".repeat(400)}`);
    assert.doesNotMatch(line, /[\p{Cf}]/u, "a format character in the name or the head must not survive the flatten");
    assert.match(line, /wor ker/, "and it is replaced with a space, not deleted");
    assert.match(line, /zero width/);
  });

  it("keeps the head to its budget and marks that it was cut", () => {
    const line = renderLeadPointer(7, "w", "c".repeat(1000));
    assert.match(line, /…/, "a cut head must show it was cut");
    assert.ok(line.length < 300, `the pointer must be far shorter than what it replaced, got ${line.length}`);
    assert.match(line, /^\[hive message #7 from w, 1000 chars\] c+… agent_message_get\(7\) for the full text\.$/);
  });
});
