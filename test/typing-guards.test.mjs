import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, REPO, scratchDirs, seedLeadRow, sleep, until } from "./helpers.mjs";

// Todo 70 / issue #27. The #24 lane guarded exactly one typing path, the
// scheduler's own wake delivery. Two more still typed into whatever was on
// screen: agent_send's text path and agent_rename's /rename (a third, the
// spawn announcement, existed until todo 387 removed it - agent_spawn types
// nothing into a fresh pane anymore, so there is nothing left to guard there,
// though it still WAITS for the pane first; see agent_spawn's own comment on
// PANE_READY_MS for why the wait outlived the typing it was added for).
// Decisions D1-D3, D5 on plan-issue-27-guard govern this file (D5 superseded
// D4 in round 2: see src/tmux.ts next to CHOICE_DIALOG).
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
// decision, not claude's chrome. The two halves of the pair are each pinned
// separately, against real captures, in test/pane-fixtures.test.mjs.
//
// TODO 399 HAD TO REBUILD THIS SCREEN, AND THE REASON IS THE FINDING. It
// used to be five lines: the literal string "shift+tab to cycle", then a
// dialog's options and "Esc to cancel". That satisfied D5 only because
// "shift+tab to cycle" was itself an INPUT_BOX_PRESENT alternative - so the
// screen proved hive's decision by ACCIDENT, on a shell pane with no input
// box anywhere on it. That accident is the `╰` bug's own shape (a substring
// standing in for a box) pointed the other way, and the box anchor removes
// it: a bare shell printf now correctly reads as having no box, which for a
// NON-claude pane is the fail-closed degeneration this file already records.
//
// So the screen now carries what it always claimed to: a real input box -
// top rule, `❯`+NBSP prompt row, closing rule, a status line and the mode
// footer, in claude's own layout - with the grepped dialog text sitting in
// the SCROLLBACK above it. That is the case D5 is actually about (a worker
// that grepped for the string while its own box is still on screen), and it
// is the same case whether the predicate under it is a footer substring or
// the box's own borders.
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
  // agent_spawn still waits for the pane before returning (fix round 1,
  // finding 1 restored it - typing is gone, the wait is not). A dialog
  // fixture never shows claude's input-box marker, so agent_spawn's wait
  // pays its FULL ceiling on every dialog spawn below; at the production
  // default (45s) that alone would blow past McpClient's own 15s call
  // timeout. 2000ms is cheap for the ordinary case (a ready fixture is
  // detected within ~1s) and short enough that dialog spawns fail fast
  // rather than timing out the client - none of the tests below assert
  // `ready`, so the exact ceiling only affects how long a dialog case takes,
  // not what it proves. spawnShowing's own poll (below) is the belt to this
  // suspenders: it does not depend on agent_spawn's wait succeeding, only on
  // the fixture having rendered by the time IT checks.
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
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
// Polls for the pane to show something before returning, on top of
// agent_spawn's own wait rather than instead of it: agent_spawn's wait looks
// for CLAUDE's input-box marker specifically, and a dialog fixture never
// shows one, so agent_spawn returns at its ceiling with the fixture already
// rendered (cat is far faster than 2000ms) but with no marker to report. This
// poll is what actually protects the caller's own next read (agent_rename,
// agent_send) against the fixture still painting, independent of whether
// agent_spawn's own wait found what it was looking for.
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

// This file used to have a describe block here, "agent_spawn's [hive]
// announcement" - agent_spawn typed a line into the pane and waited for it to
// be ready (or refused on a dialog) before doing so, and every test in it
// asserted the receipt's `announced`/`note`/`tail`. Todo 387 removed the
// TYPING: nothing is typed into a spawned worker's pane anymore, so there is
// no announcement receipt left to assert against. The wait stayed (fix round
// 1, finding 1), and the describe below is its regression test.

// TODO 387 FIX ROUND 1, FINDING 1. The first version of this lane removed
// agent_spawn's readiness wait along with its typing, reasoning that with
// nothing left to type there was nothing left to wait FOR. That reasoning
// only looked at what agent_spawn itself does. waitForPaneInput's own
// contract (src/tmux.ts) is that sending into a pane that has not taken the
// terminal loses the text silently and reports success - and the NEXT thing
// to type into a freshly spawned pane is now the lead's own agent_send,
// which can land in the same tool block as the spawn (todo 384's exact
// dispatch shape, and this PR's own regression test for it). Without the
// wait, that send would race a cold claude and could be silently swallowed:
// strictly worse than the false-finish defect this whole lane exists to fix,
// since a swallowed send leaves the worker sitting forever with an empty
// screen and nothing in the store distinguishes that from a worker that is
// simply thinking.
//
// THIS IS WHY THE REGRESSION TEST BELOW USES A SLOW-RENDERING FAKE CLAUDE
// RATHER THAN THE PLAIN ONE spawn-false-finish.test.mjs uses. A plain
// fakeClaude() shell takes the terminal essentially instantly (it is a `sh`
// script, not a cold claude loading plugins and MCP servers), so a test
// built on it cannot distinguish "the wait ran and succeeded quickly" from
// "there was no wait at all" - which is exactly why the first version of
// this lane shipped with its own regression tests green. Forcing a real
// delay before the pane renders is what makes the absence of a wait
// observable.
describe("agent_spawn's readiness wait outlives the typing it was added for", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  it("a send landing immediately after spawn is not swallowed, even against a slow-to-render pane", async () => {
    // A wider ceiling than the file's default 2000ms, and a client of its
    // own rather than reusing `mcp`: this is the one case in the file that
    // needs agent_spawn to actually wait out a multi-second cold start
    // rather than timing out fast, so it cannot share the short ceiling
    // every other test here relies on to keep dialog cases quick.
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
        // 2s before the pane renders anything at all - long enough that a
        // send fired the instant agent_spawn returns would land on a raw,
        // untaken terminal if agent_spawn were not itself waiting.
        command: fakeClaude(`sleep 2; ${replayFixture("ready-idle.txt")}`),
        extra_args: [],
        placement: "window",
      });
      spawned.push(receipt.agent_id);
      await liveAgentRow(patientMcp, name);
      const spawnMs = Date.now() - started;

      // THE PROPERTY UNDER TEST: agent_spawn's own return already implies
      // the pane was ready, so the immediately-following send below is safe
      // BY CONSTRUCTION rather than by luck. Asserted directly (spawn_ms
      // comfortably exceeds the artificial 2s render delay) rather than
      // inferred from the send succeeding, so a future change that makes
      // the wait a no-op fails HERE with a clear message instead of only on
      // the send assertion below, which a flaky pane could also fail for
      // unrelated reasons.
      assert.ok(
        spawnMs >= 1800,
        `agent_spawn must not return before the pane is ready; returned after ${spawnMs}ms against a 2000ms render delay`,
      );
      assert.equal(receipt.ready, true, "the pane must have been detected as ready before agent_spawn returned");

      // No extra wait here - this call fires the instant agent_spawn
      // returns, which is exactly the dispatch shape (spawn and send in the
      // same tool block) todo 384 measured.
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
    // Immune: folder-trust-dialog.txt is a static, checked-in fixture, grepped
    // clean of "rename" in any case (a real trust prompt has no reason to say
    // it). The only way "/rename" lands in this pane is agent_rename actually
    // typing it, which is exactly the regression this guards.
    assert.doesNotMatch(output, /\/rename/);
  });

  it("refuses to type /rename into the /model picker", async () => {
    const receipt = await renamed("rename-model", "model-picker-dialog.txt");
    assert.equal(receipt.retitled, false);
    const { output } = await mcp.call("agent_output", { name: "rename-model" });
    // Same immunity as the folder-trust case above.
    assert.doesNotMatch(output, /\/rename/);
  });

  // Todo 317. agent_rename cannot reach the LEAD - the kind='lead' refusal
  // throws before any typing - but it types into a live WORKER pane, and a
  // human attached to one is ordinary. The failure is worse here than a plain
  // merge: a slash command only runs at the start of a line, so "/rename foo"
  // pasted onto a half-typed sentence submits the human's unfinished text
  // with the command glued on, the retitle never happens, and the receipt
  // used to say retitled: true anyway.
  //
  // Two cases only, not the five agent_send carries: the classifier itself is
  // pinned against every fixture in test/input-box.test.mjs, so what is worth
  // proving here is the WIRING - that this call site reads "pending" and not
  // "box is non-null". ghost-suggestion.txt is the control that catches that
  // exact confusion, and it is the destructive direction besides.
  it("refuses to type /rename onto real unsubmitted input, and renames the row anyway", async () => {
    const receipt = await renamed("rename-pending", "real-input.txt");
    assert.equal(receipt.retitled, false);
    assert.match(receipt.note, /unsubmitted text/);
    // The note has to name a rename that still resolves: the row is already
    // the NEW name by this point, so "retry your original call" would send a
    // caller at a name nothing answers to.
    assert.match(receipt.note, /rename-pending-renamed/);
    const { output } = await mcp.call("agent_output", { name: "rename-pending-renamed" });
    // Immune: real-input.txt is also grepped clean of "rename" (see the two
    // dialog cases above for the same reasoning).
    assert.doesNotMatch(output, /\/rename/, "the command must never have been typed");
    // Deliberately not asserting the fixture's own text is still on screen:
    // the pane cats it, so that can never fail. See the matching note in the
    // agent_send block below.
  });

  it("still retitles against a ghost suggestion - the box is claude's own, not a human's", async () => {
    const receipt = await renamed("rename-ghost", "ghost-suggestion.txt");
    assert.equal(receipt.retitled, true);
    assert.equal(receipt.note, undefined);
    const { output } = await mcp.call("agent_output", { name: "rename-ghost-renamed" });
    assert.match(output, /\/rename rename-ghost-renamed/, "retitled: true must mean the command actually landed");
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
    // Immune: ready-idle.txt is static and grepped clean of "hello", and
    // send-both gets its own tmux window (spawnShowing's placement: "window"),
    // so there is no other test's typing to bleed into this pane either. A
    // fixture edited to include example text containing "hello" (a worked
    // example in a transcript, say) would silently defeat this check.
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

  // Todo 392. The whole bug: an ordinary tool-permission prompt's own
  // preview box closes with `╰`, the same glyph INPUT_BOX_PRESENT used to
  // trust as proof no dialog was up, so this call used to type "1" and
  // hive granted the permission nobody read. Same shape as the trust/model
  // cases above; the fixture is the only thing that changed.
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

  // D5, the grep case, same reasoning as agent_spawn's and agent_rename's.
  it("still sends text when the marker is grepped text, not a real dialog", async () => {
    const name = "send-grepped-marker";
    const spawn = await spawnShowing(name, printScreen(GREPPED_MARKER_STILL_READY));
    spawned.push(spawn.agent_id);
    const receipt = await mcp.call("agent_send", { name, text: "hello", submit: false });
    assert.equal(receipt.sent, true);
  });

  // Issue #150. A control byte in `text` reaches tmux as a keystroke instead
  // of as literal text - `send-keys -l` stops tmux interpreting key NAMES but
  // not raw control bytes, agent_rename's own guard verified this against a
  // real tmux - so an unvalidated `text` argument silently becomes the `keys`
  // path .claude/rules/tmux-and-panes.md deliberately keeps unguarded against
  // a dialog. Checked before any pane read (no tmux fork spent on a call that
  // is refused outright), so a genuinely idle pane still proves nothing
  // reached it.
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

  // Todo 317. agent_send's text path guarded a DIALOG and nothing else, so a
  // pane holding real unsubmitted human text got the send pasted onto the end
  // of it and Enter submitted both as one message. Not hypothetical: three
  // clobbers of exactly this shape were captured on the SCHEDULER's path
  // before its own hold shipped (todo 317 comment 635, from
  // agent_state_log/transcript payloads), and this path has been recorded in
  // the project's `lessons` pad as observed three times since 2026-07-29
  // ("the next agent_send appends to it"), answered with a human procedure
  // rather than a check because hive was capturing without "-e" back then and
  // throwing the ghost/real signal away.
  //
  // The refusal is scoped to "pending" alone. The five no-refusal cases below
  // are what stops it becoming worse than the bug: ghost and the queued hint
  // render in every idle claude pane, so refusing on those refuses every send
  // forever.
  describe("unsubmitted human text in the box", () => {
    it("refuses to submit onto real unsubmitted input, and nothing reaches the pane", async () => {
      const name = await showing("send-pending", "real-input.txt");
      const receipt = await mcp.call("agent_send", { name, text: "CLOBBERING TEXT" });
      assert.equal(receipt.sent, false);
      assert.match(receipt.note, /unsubmitted text/);
      // The receipt must name the condition well enough to act on, and
      // report the box that DECIDED the refusal rather than a second read.
      assert.equal(receipt.input_box.state, "pending");
      assert.equal(receipt.input_box.text, "REAL UNSUBMITTED INPUT");
      const { output } = await mcp.call("agent_output", { name });
      assert.doesNotMatch(output, /CLOBBERING TEXT/, "the text must never have been typed");
      // NOT asserting that "REAL UNSUBMITTED INPUT" is still on screen. It
      // is, unconditionally, because the pane cats the fixture and nothing
      // re-renders that row - so the assertion passes with the guard deleted
      // and on main, while its message claims the property this lane exists
      // to protect. That is test/CLAUDE.md's shape 7, and counselors caught
      // it here. doesNotMatch above is the live half.
    });

    // submit=false is exempt on purpose, and the reason is the ENTER, not
    // compose-then-send: see src/tools/agents.ts, where the compose argument
    // is recorded as FACTUALLY WRONG. The guard is on the submitting call,
    // which is the SECOND call, so two text calls genuinely do refuse at the
    // second one. A compose is finished with keys:["Enter"] instead, and the
    // refusal note says so. These two tests pin the documented flow end to
    // end rather than only its first step, which is how the old single-step
    // version passed while the flow it cited was dead.
    it("still appends with submit=false, and the text really lands", async () => {
      const name = await showing("send-pending-nosubmit", "real-input.txt");
      const receipt = await mcp.call("agent_send", { name, text: "APPENDED ON PURPOSE", submit: false });
      assert.equal(receipt.sent, true);
      const { output } = await mcp.call("agent_output", { name });
      assert.match(output, /APPENDED ON PURPOSE/, "sent: true must mean the characters actually reached the pane");
    });

    it("refuses a SECOND submitting text call over a pending box, and keys:[\"Enter\"] is the way out", async () => {
      const name = await showing("send-compose-finish", "real-input.txt");
      // The pane already shows real pending text, which is the state a
      // compose leaves behind. WHAT THIS RIG CANNOT STAGE, said out loud so
      // nobody reads more into it than is here: an actual submit=false call
      // does NOT change what inputBoxState sees, because the pane is a catted
      // static screen and typed characters echo BELOW the fixture's box row
      // rather than into it. So this asserts the same decision the real
      // compose hits - a submitting call over a pending box - reached by a
      // fixture instead of by a prior call.
      const refused = await mcp.call("agent_send", { name, text: "SECOND HALF" });
      assert.equal(refused.sent, false);
      assert.match(refused.note, /keys: \["Enter"\]/, "the note must name the only way to finish a compose");
      const { output: before } = await mcp.call("agent_output", { name });
      assert.doesNotMatch(before, /SECOND HALF/);
      // And the remedy the note gives has to actually be reachable: keys is
      // unguarded against this condition by design, on a non-lead target.
      const finished = await mcp.call("agent_send", { name, keys: ["Enter"] });
      assert.equal(finished.sent, true);
    });

    // The negative controls. Each of these renders in an ORDINARY pane -
    // ghost and the queued hint are what an idle claude draws by itself - so
    // a refusal on any of them takes agent_send off the air for good. If one
    // of these ever starts failing, the classifier widened, not this guard.
    //
    // EACH ASSERTS DELIVERY, NOT JUST THE RECEIPT (counselors, codex seat).
    // sent: true is a claim the handler makes about itself: a mutation that
    // returns {sent: true} without ever calling sendText kept every one of
    // these green, and the headline refusal green too, while agent_send
    // delivered nothing at all. Reading the text back off the pane is what
    // makes these end-to-end paths through capture, classify and type on five
    // different sets of real bytes, rather than five ways of asking the same
    // predicate the same question.
    for (const [file, why] of [
      ["ghost-suggestion.txt", "claude's own dim suggestion is not something a human typed"],
      ["queued-hint.txt", "the queued-messages hint is chrome, not input"],
      ["ready-idle.txt", "an empty box is the ordinary case and must always send"],
      ["busy-mid-turn.txt", "busy is not a hold condition and never has been"],
      ["drifted-prompt-glyph.txt", "\"unknown\" means the detector drifted; refusing on it would refuse every screen"],
    ]) {
      it(`still sends against ${file} (${why})`, async () => {
        // The fixture name minus ".txt": a literal dot is tmux's own
        // window.pane separator, so it has no business in a target name.
        const name = await showing(`send-nohold-${file.replace(/\.txt$/, "")}`, file);
        const receipt = await mcp.call("agent_send", { name, text: "ORDINARY SEND" });
        assert.equal(receipt.sent, true);
        const { output } = await mcp.call("agent_output", { name });
        assert.match(output, /ORDINARY SEND/, "sent: true must mean the text actually reached the pane");
      });
    }
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
      // Immune: ready-idle.txt is static and grepped clean of a literal "^C"
      // (Claude Code's idle chrome does not print one). This pane also gets
      // its own tmux window, so no earlier test's own Ctrl-C echo can bleed
      // in. A fixture recaptured from a screen that shows "^C to exit"-style
      // chrome, or a real Ctrl-C echoed by something upstream of this test,
      // would silently defeat this check.
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
