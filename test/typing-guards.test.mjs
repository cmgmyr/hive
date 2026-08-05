import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, REPO, scratchDirs, seedLeadRow, sleep } from "./helpers.mjs";

// Todo 70 / issue #27. The #24 lane guarded exactly one typing path, the
// scheduler's own wake delivery. These three still typed into whatever was on
// screen: the spawn announcement, agent_send's text path, and agent_rename's
// /rename. Decisions D1-D3, D5 on plan-issue-27-guard govern this file (D5
// superseded D4 in round 2: see src/tmux.ts next to CHOICE_DIALOG).
const { hasTmux, cleanup } = isolateTmux("the typing-guard tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");
const { db } = await import("../dist/db.js");

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fixturePath = (file) => join(FIXTURES, file);

// Round 2, D5. A dialog is CHOICE_DIALOG present AND the input-box marker
// ABSENT, not CHOICE_DIALOG alone: a modal replaces claude's input affordance
// rather than sitting beside it. This screen carries BOTH markers at once,
// which is exactly the case D4 could not tell apart from a real dialog and
// D5 exists to fix -- a worker whose own transcript contains the literal text
// "Esc to cancel" (it grepped for the string, or opened
// test/fixtures/panes/folder-trust-dialog.txt) while its input box is still
// on screen. Under D4 this refused forever, with no dialog to ever clear:
// agent_send would tell the lead to clear a prompt that does not exist, and
// every wake targeting that pane would hold for as long as the screen sat
// still. Under D5 it types, because there is somewhere for the paste to go.
// Claude itself has never been observed rendering both markers on one real
// screen, so this stays synthetic the same way test/false-idle.test.mjs pins
// the scheduler's own guard with a printf: what is under test is hive's
// decision, not claude's chrome. INPUT_BOX_PRESENT and CHOICE_DIALOG are each
// pinned separately, against real captures, in test/pane-fixtures.test.mjs.
const GREPPED_MARKER_STILL_READY = "shift+tab to cycle\\n 1. Yes\\n 2. No\\n\\n Esc to cancel";

let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    // Real fixtures resolve in well under a second; a dialog fixture never
    // matches at all, so this is the ceiling those cases pay in full.
    env: { HIVE_SPAWN_READY_MS: "2000" },
  });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;

  // Round 2, todo 75. This comment has been wrong twice (width, then the
  // wrong specifics on the right axis), so what follows is MEASURED, not
  // reasoned: replayed each fixture into real panes across a range of
  // heights at a fixed 220 columns, and read the actual production
  // paneChoiceCheck's answer back (script output kept on the todo, not here).
  //
  // Only folder-trust-dialog.txt is height-sensitive. Its footer is on line
  // 16 of 50; ready-idle.txt, busy-mid-turn.txt and model-picker-dialog.txt
  // all carry their marker on line 50, the LAST printed line, so they read
  // correctly at every height tested (10 through 50) -- generalising from the
  // trust fixture to "each fixture" was the previous version's mistake.
  // Measured thresholds for the trust fixture, capturePane(target, N):
  //   N=18 (tailCaptureLines(), what paneChoiceCheck and paneAwaitingChoice
  //     use since todo 72/74): false at pane height <= 17, true at >= 18.
  //   N=12 (paneAwaitingChoice's window before todo 72): false at <= 23,
  //     true at >= 24.
  // The direction: a NARROWER capture window needs a TALLER pane, because
  // capture-pane -S -N counts back N lines from wherever the pane's own
  // history currently ends, and a shorter pane pushes that end further down
  // (more blank lines printed below the footer before the prompt returns),
  // so a narrower N has to reach further to find the same footer. This is
  // why round 2 step 2 keeping the window at 18 rather than reverting to 12
  // was a live coupling, not just a style choice: reverting would have
  // raised the threshold this file depends on from 18 to 24.
  //
  // None of this is a production hazard: a real claude renders its dialog to
  // fit whatever pane it actually has, footer at the bottom, and has never
  // been observed with it scrolled off. It is an artifact of REPLAYING a
  // fixed 50-line capture into a pane shorter than that.
  //
  // Enforced, not just described: every worker below spawns with placement
  // "window" (see spawnShowing), so each gets this session's own dimensions
  // as its own tmux window rather than a pane tiled down by its siblings.
  // Margin under the old tiled "split" placement was one or two rows at this
  // describe's peak worker count, so the very next spawn added to any
  // describe here would have silently dropped below 18 with nothing pointing
  // at geometry; window placement removes the shrink path entirely rather
  // than asserting around it.
  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session", "-d", "-s", sessionName(), "-x", "300", "-y", "60", "-c", dirs.projectDir,
  ]);
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

// Each command replays a fixture (or a synthetic screen) byte-for-byte via
// cat/printf, then sleeps so the pane stays put for capture-pane to read.
const fakeClaude = makeFakeClaude(dirs.tmp);

const replayFixture = (file) => `cat '${fixturePath(file)}'; sleep 600`;
const printScreen = (text) => `printf '${text}\\n'; sleep 600`;

// placement: "window" gives every worker here its own tmux window rather
// than a pane tiled into a shared one, so a describe spawning many workers
// cannot shrink any of them below the session's own size (see the geometry
// comment above the session's own creation for why height matters and what
// was measured). This is the enforcement half: no pane in this file can ever
// be shorter than 60 rows, so there is no threshold left to fall under.
async function spawnShowing(name, shellCommand) {
  const receipt = await mcp.call("agent_spawn", {
    name,
    command: fakeClaude(shellCommand),
    extra_args: [],
    placement: "window",
  });
  await liveAgentRow(mcp, name);
  return receipt;
}

describe("agent_spawn's [hive] announcement", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  it("announces once the pane is genuinely ready with no dialog up", async () => {
    const receipt = await spawnShowing("spawn-ready", replayFixture("ready-idle.txt"));
    spawned.push(receipt.agent_id);
    assert.equal(receipt.announced, true);
    assert.equal(receipt.note, undefined);
  });

  it("still announces mid-turn busy, which must not be read as a dialog", async () => {
    const receipt = await spawnShowing("spawn-busy", replayFixture("busy-mid-turn.txt"));
    spawned.push(receipt.agent_id);
    assert.equal(receipt.announced, true);
  });

  // Todo 73. A real folder-trust or /model-picker screen carries no readiness
  // marker (that absence is #30's own fix), so before the spawn dialog check
  // ran unconditionally these two landed in the not-ready branch every time
  // and never reached the dialog branch at all: /NOT sent/ matches both
  // branches' notes, so the assertion below could not have told them apart,
  // and deleting the dialog check entirely left both tests passing (13/14,
  // only the synthetic both-markers test caught it). Asserting the dialog
  // note and the tail is the fix: only the dialog branch produces either.
  it("refuses a folder-trust prompt with the dialog note and a tail, not the not-ready note", async () => {
    const receipt = await spawnShowing("spawn-trust", replayFixture("folder-trust-dialog.txt"));
    spawned.push(receipt.agent_id);
    assert.equal(receipt.announced, false);
    assert.match(receipt.note, /waiting on a choice/);
    assert.match(receipt.tail, /trust this folder/, "the tail is what proves this hit the dialog branch");
    const { output } = await mcp.call("agent_output", { name: "spawn-trust" });
    assert.doesNotMatch(output, /\[hive\]/, "nothing may have been typed at the dialog");
  });

  it("refuses the /model picker with the dialog note and a tail, not the not-ready note", async () => {
    const receipt = await spawnShowing("spawn-model", replayFixture("model-picker-dialog.txt"));
    spawned.push(receipt.agent_id);
    assert.equal(receipt.announced, false);
    assert.match(receipt.note, /waiting on a choice/);
    assert.match(receipt.tail, /Esc to cancel/, "the tail is what proves this hit the dialog branch");
    const { output } = await mcp.call("agent_output", { name: "spawn-model" });
    assert.doesNotMatch(output, /\[hive\]/);
  });

  // The other side of the same fix: a pane that genuinely never becomes
  // ready (no dialog, just slow or dead) must still land on the not-ready
  // note, not be silently upgraded to the dialog one. A fake claude that
  // exits immediately never draws anything, so waitForPaneInput times out and
  // paneChoiceCheck reads an empty pane -- CHOICE_DIALOG cannot match nothing.
  it("still reports not-ready, not a dialog, for a pane that never draws anything", async () => {
    const receipt = await spawnShowing("spawn-never-ready", "sleep 600");
    spawned.push(receipt.agent_id);
    assert.equal(receipt.announced, false);
    assert.match(receipt.note, /never became ready/);
    assert.equal(receipt.tail, undefined);
  });

  // Decision D5, the grep case (round 2). "Esc to cancel" on screen is not
  // enough by itself: the input box is on the same screen too, so there is
  // somewhere for the paste to go and nothing to answer. Refusing here is
  // exactly the D4 bug round 2 found -- a worker that greps for the dialog
  // string, or opens the fixture file, would have been refused forever, with
  // no real dialog ever going to clear.
  it("still announces when the marker is grepped text, not a real dialog", async () => {
    const receipt = await spawnShowing("spawn-grepped-marker", printScreen(GREPPED_MARKER_STILL_READY));
    spawned.push(receipt.agent_id);
    assert.equal(receipt.announced, true);
    assert.equal(receipt.note, undefined);
    const { output } = await mcp.call("agent_output", { name: "spawn-grepped-marker" });
    assert.match(output, /\[hive\]/, "there was an input box, so the announcement must have landed");
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

  // D5, the grep case, same reasoning as agent_spawn's: the marker alone is
  // not enough, since paneChoiceCheck backs every dialog-refusal call site.
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

  // Pre-existing bug, found by this lane's review rather than introduced by
  // it: passing both used to send the keys, silently drop the text, and
  // still report sent: true. "keys won, text vanished" is not a thing any
  // caller can have wanted, so this is a caller error, the same way passing
  // neither already is.
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

  // D5, the grep case, same reasoning as agent_spawn's and agent_rename's.
  it("still sends text when the marker is grepped text, not a real dialog", async () => {
    const name = "send-grepped-marker";
    const spawn = await spawnShowing(name, printScreen(GREPPED_MARKER_STILL_READY));
    spawned.push(spawn.agent_id);
    const receipt = await mcp.call("agent_send", { name, text: "hello", submit: false });
    assert.equal(receipt.sent, true);
  });

  // Decision D2. text and keys are not the same operation and are not guarded
  // the same way. text means "inject a user turn", which a dialog eats and
  // then reads the trailing Enter as an answer -- the exact hazard #27
  // exists to close. keys means "drive this TUI deliberately", and pressing a
  // key to answer or dismiss a dialog is the ONLY supported way to unstick a
  // pane sitting on one; guarding it would remove that. Pinned against every
  // fixture, dialog or not, so a future guard added here by symmetry-minded
  // reflex breaks this test and has to read this comment first.
  it("still sends keys into a dialog, deliberately, on every fixture", async () => {
    for (const file of ["ready-idle.txt", "folder-trust-dialog.txt", "model-picker-dialog.txt", "busy-mid-turn.txt"]) {
      const name = await showing(`keys-${file}`, file);
      const receipt = await mcp.call("agent_send", { name, keys: ["Escape"] });
      assert.equal(receipt.sent, true, `keys must reach ${file} unconditionally`);
    }
    // The accept case for the guard below: an ORDINARY worker's keys path is
    // untouched by it, on every fixture including a dialog one - this loop
    // already proves that; the new guard below is scoped to kind='lead'.
  });

  // Issue #27's L4 fix round R6, todo 169 (counselors opus F3). agent_close
  // already refuses a kind='lead' target (src/tools/agents.ts); agent_send's
  // keys path did not, and a worker could reach the identical outcome -
  // ending the lead's session - with no dialog guard, no confirm_self, and
  // no kind check at all. Refused only when the CALLER is not itself a lead.
  describe("refuses raw keys to a lead from a non-lead caller (does not touch a peer lead, or text)", () => {
    async function showingAsLead(name, file) {
      const receipt = await spawnShowing(name, replayFixture(file));
      spawned.push(receipt.agent_id);
      // Relabelled directly on the row rather than minted through
      // ensureLeadRow: this guard checks agent.kind alone, and the point
      // here is a REAL live pane to prove keys do or do not reach it, not
      // exercising the mint path (that is lead-identity.test.mjs's job).
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
      // Issue #27's L4 fix round R8, todo 175 item 3 (BOTH SEATS). Used to
      // be a bare HIVE_AGENT_ID: "lead:999" naming no row at all, which is
      // exactly the env-shaped hole this round closes: the guard now checks
      // for a REAL running kind='lead' row with this actor_id, so the
      // fixture has to be one, or this test would pass for the wrong reason
      // (the same trap it was written to catch on the callER's side).
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
      // Issue #27's L4 fix round R8, todo 175 item 3 (BOTH SEATS). The exact
      // shape the branch's own prior fixture proved passed the escape hatch:
      // a string shaped like a lead actor id, naming no agents row at all.
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
