import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, REPO, scratchDirs, seedLeadRow, sleep, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the typing-guard tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);

const GREPPED_MARKER_STILL_READY =
  " 1. Yes\\n 2. No\\n\\n Esc to cancel\\n" +
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\\n" +
  "\u276f\u00a0\\n" +
  "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\\n" +
  "  hive-scratch | ctx: 0k\\n" +
  "  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents";

let mcp;
let projectId;

before(async () => {

  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;

  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName(), "-x", "300", "-y", "60", "-c", dirs.projectDir,
  ]);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;
const printScreen = (text) => `printf '${text}\\n'; sleep 600`;

async function spawnShowing(name, shellCommand) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(shellCommand),
    extra_args: [],
    placement: "window",
  });
  await liveAgentRow(mcp, name);
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt;
}

describe("agent_spawn's readiness wait outlives the typing it was added for", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  it("a send landing immediately after spawn is not swallowed, even against a slow-to-render pane", async () => {

    const patientMcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_SPAWN_READY_MS: "10000" },
    });
    await patientMcp.start();
    try {
      const name = "spawn-then-send-cold";
      const started = Date.now();
      const receipt = await patientMcp.call("agent_spawn", {
        name,

        command: fakeClaude(`sleep 2; ${replayFixture("ready-idle.txt")}`),
        extra_args: [],
        placement: "window",
      });
      spawned.push(receipt.agent_id);
      await liveAgentRow(patientMcp, name);
      const spawnMs = Date.now() - started;

      assert.ok(
        spawnMs >= 1800,
        `agent_spawn must not return before the pane is ready; returned after ${spawnMs}ms against a 2000ms render delay`,
      );
      assert.equal(receipt.ready, true, "the pane must have been detected as ready before agent_spawn returned");

      const sendReceipt = await patientMcp.call("agent_send", { name, text: "REAL ASSIGNMENT", submit: false });
      assert.equal(sendReceipt.sent, true);

      const { output } = await patientMcp.call("agent_output", { name });
      assert.match(
        output,
        /REAL ASSIGNMENT/,
        "the text must have actually reached the pane, not been silently swallowed by a cold terminal",
      );
    } finally {
      await patientMcp.close();
    }
  });
});

describe("agent_rename's /rename keystroke", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  async function renamed(name, file) {
    const spawn = await spawnShowing(name, replayFixture(file));
    spawned.push(spawn.agent_id);
    return mcp.call("agent_rename", { name, new_name: `${name}-renamed` });
  }

  it("retitles a pane that is genuinely idle", async () => {
    const receipt = await renamed("rename-ready", "ready-idle.txt");
    assert.equal(receipt.retitled, true);
    assert.equal(receipt.note, undefined);
  });

  it("retitles a pane that is busy but not on a dialog", async () => {
    const receipt = await renamed("rename-busy", "busy-mid-turn.txt");
    assert.equal(receipt.retitled, true);
  });

  it("refuses to type /rename into a folder-trust prompt", async () => {
    const receipt = await renamed("rename-trust", "folder-trust-dialog.txt");
    assert.equal(receipt.retitled, false);
    assert.match(receipt.note, /waiting on a choice/);
    assert.match(receipt.tail, /trust this folder/, "the receipt must show what it is being asked");
    const { output } = await mcp.call("agent_output", { name: "rename-trust" });

    assert.doesNotMatch(output, /\/rename/);
  });

  it("refuses to type /rename into the /model picker", async () => {
    const receipt = await renamed("rename-model", "model-picker-dialog.txt");
    assert.equal(receipt.retitled, false);
    const { output } = await mcp.call("agent_output", { name: "rename-model" });

    assert.doesNotMatch(output, /\/rename/);
  });

  it("refuses to type /rename onto real unsubmitted input, and renames the row anyway", async () => {
    const receipt = await renamed("rename-pending", "real-input.txt");
    assert.equal(receipt.retitled, false);
    assert.match(receipt.note, /unsubmitted text/);

    assert.match(receipt.note, /rename-pending-renamed/);
    const { output } = await mcp.call("agent_output", { name: "rename-pending-renamed" });

    assert.doesNotMatch(output, /\/rename/, "the command must never have been typed");

  });

  it("still retitles against a ghost suggestion - the box is claude's own, not a human's", async () => {
    const receipt = await renamed("rename-ghost", "ghost-suggestion.txt");
    assert.equal(receipt.retitled, true);
    assert.equal(receipt.note, undefined);
    const { output } = await mcp.call("agent_output", { name: "rename-ghost-renamed" });
    assert.match(output, /\/rename rename-ghost-renamed/, "retitled: true must mean the command actually landed");
  });

  it("still retitles when the marker is grepped text, not a real dialog", async () => {
    const name = "rename-grepped-marker";
    const spawn = await spawnShowing(name, printScreen(GREPPED_MARKER_STILL_READY));
    spawned.push(spawn.agent_id);
    const receipt = await mcp.call("agent_rename", { name, new_name: `${name}-renamed` });
    assert.equal(receipt.retitled, true);
    assert.equal(receipt.note, undefined);
  });
});

describe("agent_send", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  async function showing(name, file) {
    const spawn = await spawnShowing(name, replayFixture(file));
    spawned.push(spawn.agent_id);
    return name;
  }

  it("types text at a pane that is genuinely idle", async () => {
    const name = await showing("send-ready", "ready-idle.txt");
    const receipt = await mcp.call("agent_send", { name, text: "hello", submit: false });
    assert.equal(receipt.sent, true);
    const { output } = await mcp.call("agent_output", { name });
    assert.match(output, /hello/);
  });

  it("types text at a pane that is busy but not on a dialog", async () => {
    const name = await showing("send-busy", "busy-mid-turn.txt");
    const receipt = await mcp.call("agent_send", { name, text: "hello", submit: false });
    assert.equal(receipt.sent, true);
  });

  it("refuses both text and keys together rather than silently dropping the text", async () => {
    const name = await showing("send-both", "ready-idle.txt");
    await assert.rejects(
      mcp.call("agent_send", { name, text: "hello", keys: ["Escape"] }),
      /Pass text or keys, not both/,
    );
    const { output } = await mcp.call("agent_output", { name });

    assert.doesNotMatch(output, /hello/, "neither the text nor the keys may have reached the pane");
  });

  it("refuses text into a folder-trust prompt and says why", async () => {
    const name = await showing("send-trust", "folder-trust-dialog.txt");
    const receipt = await mcp.call("agent_send", { name, text: "1. Yes, I trust this folder" });
    assert.equal(receipt.sent, false);
    assert.match(receipt.note, /waiting on a choice/);
    assert.match(receipt.tail, /trust this folder/);
    const { output } = await mcp.call("agent_output", { name });
    assert.match(
      output,
      /Esc to cancel/,
      "the dialog must still be up: an Enter reaching it would have chosen an option and cleared it",
    );
  });

  it("refuses text into the /model picker", async () => {
    const name = await showing("send-model", "model-picker-dialog.txt");
    const receipt = await mcp.call("agent_send", { name, text: "3" });
    assert.equal(receipt.sent, false);
  });

  it("refuses text into an ordinary tool-permission prompt (todo 392)", async () => {
    const name = await showing("send-permission-prompt", "tool-permission-prompt.txt");
    const receipt = await mcp.call("agent_send", { name, text: "1" });
    assert.equal(receipt.sent, false);
    assert.match(receipt.note, /waiting on a choice/);
    assert.match(receipt.tail, /Esc to cancel/);
    const { output } = await mcp.call("agent_output", { name });
    assert.match(
      output,
      /Esc to cancel/,
      "the dialog must still be up: an Enter reaching it would have chosen an option and cleared it",
    );
  });

  it("still sends text when the marker is grepped text, not a real dialog", async () => {
    const name = "send-grepped-marker";
    const spawn = await spawnShowing(name, printScreen(GREPPED_MARKER_STILL_READY));
    spawned.push(spawn.agent_id);
    const receipt = await mcp.call("agent_send", { name, text: "hello", submit: false });
    assert.equal(receipt.sent, true);
  });

  describe("control bytes in text (issue #150)", () => {
    it("refuses a control byte, names it and its offset, before any pane read", async () => {
      const name = await showing("send-control-byte", "ready-idle.txt");
      await assert.rejects(
        mcp.call("agent_send", { name, text: "zzsentinelzz" }),
        /ETX \(Ctrl-C\), 0x03.*at offset 10/,
      );
      const { output } = await mcp.call("agent_output", { name });
      assert.doesNotMatch(output, /zzsentinel/, "a refused text must never reach the pane");
    });

    it("names keys as the remedy for an actual keystroke, not embedding the byte in text", async () => {
      const name = await showing("send-control-byte-remedy", "ready-idle.txt");
      await assert.rejects(mcp.call("agent_send", { name, text: "xy" }), /use keys instead/);
    });

    it("still sends text containing a literal tab and newline - both are allowed", async () => {
      const name = await showing("send-tab-newline", "ready-idle.txt");
      const receipt = await mcp.call("agent_send", { name, text: "one\ttwo\nthree", submit: false });
      assert.equal(receipt.sent, true);
    });

    it("refuses CR specifically: it is the byte a literal Enter keypress sends", async () => {
      const name = await showing("send-cr", "ready-idle.txt");
      await assert.rejects(mcp.call("agent_send", { name, text: "one\rtwo" }), /CR, 0x0D/);
    });
  });

  describe("unsubmitted human text in the box", () => {
    it("refuses to submit onto real unsubmitted input, and nothing reaches the pane", async () => {
      const name = await showing("send-pending", "real-input.txt");
      const receipt = await mcp.call("agent_send", { name, text: "CLOBBERING TEXT" });
      assert.equal(receipt.sent, false);
      assert.match(receipt.note, /unsubmitted text/);

      assert.equal(receipt.input_box.state, "pending");
      assert.equal(receipt.input_box.text, "REAL UNSUBMITTED INPUT");
      const { output } = await mcp.call("agent_output", { name });
      assert.doesNotMatch(output, /CLOBBERING TEXT/, "the text must never have been typed");

    });

    it("still appends with submit=false, and the text really lands", async () => {
      const name = await showing("send-pending-nosubmit", "real-input.txt");
      const receipt = await mcp.call("agent_send", { name, text: "APPENDED ON PURPOSE", submit: false });
      assert.equal(receipt.sent, true);
      const { output } = await mcp.call("agent_output", { name });
      assert.match(output, /APPENDED ON PURPOSE/, "sent: true must mean the characters actually reached the pane");
    });

    it("refuses a SECOND submitting text call over a pending box, and keys:[\"Enter\"] is the way out", async () => {
      const name = await showing("send-compose-finish", "real-input.txt");

      const refused = await mcp.call("agent_send", { name, text: "SECOND HALF" });
      assert.equal(refused.sent, false);
      assert.match(refused.note, /keys: \["Enter"\]/, "the note must name the only way to finish a compose");
      const { output: before } = await mcp.call("agent_output", { name });
      assert.doesNotMatch(before, /SECOND HALF/);

      const finished = await mcp.call("agent_send", { name, keys: ["Enter"] });
      assert.equal(finished.sent, true);
    });

    for (const [file, why] of [
      ["ghost-suggestion.txt", "claude's own dim suggestion is not something a human typed"],
      ["queued-hint.txt", "the queued-messages hint is chrome, not input"],
      ["ready-idle.txt", "an empty box is the ordinary case and must always send"],
      ["busy-mid-turn.txt", "busy is not a hold condition and never has been"],
      ["drifted-prompt-glyph.txt", "\"unknown\" means the detector drifted; refusing on it would refuse every screen"],
    ]) {
      it(`still sends against ${file} (${why})`, async () => {

        const name = await showing(`send-nohold-${file.replace(/\.txt$/, "")}`, file);
        const receipt = await mcp.call("agent_send", { name, text: "ORDINARY SEND" });
        assert.equal(receipt.sent, true);
        const { output } = await mcp.call("agent_output", { name });
        assert.match(output, /ORDINARY SEND/, "sent: true must mean the text actually reached the pane");
      });
    }
  });

  it("still sends keys into a dialog, deliberately, on every fixture", async () => {
    for (const file of ["ready-idle.txt", "folder-trust-dialog.txt", "model-picker-dialog.txt", "busy-mid-turn.txt"]) {
      const name = await showing(`keys-${file}`, file);
      const receipt = await mcp.call("agent_send", { name, keys: ["Escape"] });
      assert.equal(receipt.sent, true, `keys must reach ${file} unconditionally`);
    }

  });

  describe("refuses raw keys to a lead from a non-lead caller (does not touch a peer lead, or text)", () => {
    async function showingAsLead(name, file) {
      const receipt = await spawnShowing(name, replayFixture(file));
      spawned.push(receipt.agent_id);

      db.prepare("UPDATE agents SET kind = 'lead' WHERE id = ?").run(receipt.agent_id);
      return name;
    }

    it("refuses keys from an ordinary (non-lead) caller, and the keys never reach the pane", async () => {
      const name = await showingAsLead("send-lead-keys-refused", "ready-idle.txt");
      await assert.rejects(
        mcp.call("agent_send", { name, keys: ["C-c"] }),
        /this project's lead session.*no.*supervisor above it.*non-lead caller/s,
      );
      const { output } = await mcp.call("agent_output", { name });

      assert.doesNotMatch(output, /\^C/, "the C-c must never have reached the pane");
    });

    it("still sends text to a lead from a non-lead caller - the guard is keys-specific", async () => {
      const name = await showingAsLead("send-lead-text-still-works", "ready-idle.txt");
      const receipt = await mcp.call("agent_send", { name, text: "hello", submit: false });
      assert.equal(receipt.sent, true);
      const { output } = await mcp.call("agent_output", { name });
      assert.match(output, /hello/);
    });

    it("still sends keys to a lead from ANOTHER lead - the escape hatch survives for a peer", async () => {
      const name = await showingAsLead("send-lead-keys-from-lead", "folder-trust-dialog.txt");

      const peerLeadId = seedLeadRow(db, projectId, dirs.projectDir);
      spawned.push(peerLeadId);
      const leadMcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "lead:999" },
      });
      await leadMcp.start();
      try {
        const receipt = await leadMcp.call("agent_send", { name, keys: ["Escape"] });
        assert.equal(receipt.sent, true, "a lead caller must keep the keys escape hatch on another lead");
      } finally {
        await leadMcp.close();
      }
    });

    it("refuses keys from a caller whose HIVE_AGENT_ID merely LOOKS like a lead, with no row behind it", async () => {

      const name = await showingAsLead("send-lead-keys-from-fake-lead", "folder-trust-dialog.txt");
      const fakeLeadMcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "lead:999999" },
      });
      await fakeLeadMcp.start();
      try {
        await assert.rejects(
          fakeLeadMcp.call("agent_send", { name, keys: ["Escape"] }),
          /this project's lead session.*no.*supervisor above it.*non-lead caller/s,
        );
      } finally {
        await fakeLeadMcp.close();
      }
    });
  });
});
