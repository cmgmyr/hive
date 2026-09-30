import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { assertScratchStore, isolateTmux, REPO, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the wake trailer tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tick } = await import("../dist/scheduler.js");
const { capturePane, sanitizeTail, tailCaptureLines } = await import("../dist/tmux.js");
migrate();

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const session = `hive-trailer-${process.pid}`;
const outFile = join(dirs.tmp, "delivered.txt");
const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("wake-trailer-test", dirs.projectDir).id;

let watchedPane;
let deliveryPane;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "300", "-y", "50", "sleep 600"], { stdio: "ignore" });
  execFileSync("tmux", ["new-window", "-d", "-t", `=${session}`, `cat > ${outFile}`], { stdio: "ignore" });
  [watchedPane, deliveryPane] = execFileSync("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
});

after(() => cleanup(session));

const delivered = () => readFileSync(outFile, "utf8");

function paint(file) {
  execFileSync("tmux", ["respawn-pane", "-k", "-t", watchedPane, `cat '${file}'; sleep 600`], { stdio: "ignore" });
}

async function trailerFor(fixture, command = "claude") {
  db.exec("DELETE FROM wakes; DELETE FROM agents;");
  writeFileSync(outFile, "");
  paint(fixture.startsWith("/") ? fixture : join(FIXTURES, fixture));
  await until(() => capturePane(watchedPane, 5).trim() !== "");
  const agent = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state, created_at)
       VALUES (?, 'agent:tr', 'tr', ?, ?, '/tmp', 'running', 'working', datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(project, watchedPane, command).id;
  db.prepare(
    `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at, created_at)
     VALUES (?, 'user:test', 'lane check', 'idle_any', ?, 'user:test', ?, datetime('now', '-1 seconds'), datetime('now', '-60 seconds'))`,
  ).run(project, JSON.stringify([agent]), deliveryPane);
  await tick();
  await until(() => delivered().includes("read agent_output before acting on it"));
  const text = delivered();
  const start = text.indexOf("last lines of its terminal:\n");
  assert.ok(start >= 0, `no trailer delivered: ${JSON.stringify(text)}`);
  const body = text.slice(start + "last lines of its terminal:\n".length);
  return { text, trailer: body.slice(0, body.indexOf("\nhive fires this on each worker's own hook state")) };
}

function withAbove(rows) {
  const src = readFileSync(join(FIXTURES, "real-input.txt"), "utf8").trimEnd().split("\n").slice(-5, -2).join("\n");
  const path = join(dirs.tmp, `above-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(path, `${rows.join("\n")}\n${src}`);
  return path;
}

describe("the generated wake trailer", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  beforeEach(() => writeFileSync(outFile, ""));

  it("never carries a claude ghost suggestion's text, and says a suggestion is showing", async () => {
    const { trailer } = await trailerFor("ghost-suggestion.txt");
    assert.ok(!trailer.includes("write the failing test case for me"), trailer);
    assert.match(trailer, /input box: empty \(a model suggestion is showing; nobody typed it\)/);
  });

  it("never carries a codex ghost suggestion's text", async () => {
    const { trailer } = await trailerFor("codex-production-idle-ghost-e.txt", "codex");
    assert.ok(!trailer.includes("Write tests for @filename"), trailer);
    assert.match(trailer, /a model suggestion is showing/);
  });

  it("shows a claude human's unsubmitted text labelled UNSUBMITTED", async () => {
    const { trailer } = await trailerFor("real-input.txt");
    assert.match(trailer, /input box: UNSUBMITTED TEXT, not sent: "REAL UNSUBMITTED INPUT"/);
  });

  it("shows a codex human's unsubmitted text labelled UNSUBMITTED", async () => {
    const { trailer } = await trailerFor("codex-idle-pending-e.txt", "codex");
    assert.match(trailer, /input box: UNSUBMITTED TEXT, not sent: "check the current git status"/);
  });

  it("ends a real codex two-row-footer pane's trailer in an input box line with no placeholder text", async () => {
    const { trailer } = await trailerFor("codex-two-row-footer-e.txt", "codex");
    assert.ok(!trailer.includes("Ask Codex to do anything"), trailer);
    assert.match(trailer.trimEnd().split("\n").at(-1), /^input box: empty/, trailer);
  });

  it("ends a reconstructed codex two-warnings pane's trailer in an input box line with no placeholder text", async () => {
    const { trailer } = await trailerFor("codex-two-row-footer-two-warnings-e.txt", "codex");
    assert.ok(!trailer.includes("Ask Codex to do anything"), trailer);
    assert.match(trailer, /Worked for 8m 34s/);
    assert.match(trailer.trimEnd().split("\n").at(-1), /^input box: empty/, trailer);
  });

  it("shows a reconstructed codex two-row-footer pane's human text labelled UNSUBMITTED", async () => {
    const { trailer } = await trailerFor("codex-two-row-footer-pending-e.txt", "codex");
    assert.match(trailer, /input box: UNSUBMITTED TEXT, not sent: "check the current git status"/);
  });

  it("keeps the raw tail when one agent output row sits between the prompt and a shortcuts row", async () => {
    const path = join(dirs.tmp, "codex-output-row-above-shortcuts.txt");
    writeFileSync(path, "› say hi\n\n• Working\n  ? for shortcuts\n");
    const { trailer } = await trailerFor(path, "codex");
    assert.ok(!/^input box:/m.test(trailer), trailer);
  });

  it("keeps the raw tail for a codex approval dialog", async () => {
    const { trailer } = await trailerFor("codex-sandbox-approval-dialog.txt", "codex");
    assert.ok(!/^input box:/m.test(trailer), trailer);
  });

  it("drops braille-only and box-drawing-only rows above the box but keeps a spinner row with words", async () => {
    const { trailer } = await trailerFor(
      withAbove(["✻ Working (12s · esc to interrupt)", "⠋⠙⠹⠸⠼", "╭───────╮"]),
    );
    assert.ok(!/[⠀-⣿╭│▀]/.test(trailer), trailer);
    assert.match(trailer, /✻ Working \(12s · esc to interrupt\)/);
  });

  it("drops the statusline and mode-line footer rows below the box", async () => {
    const { trailer } = await trailerFor("real-input.txt");
    assert.ok(!trailer.includes("auto mode on"), trailer);
    assert.ok(!trailer.includes("ghost-capture-34"), trailer);
    assert.ok(trailer.split("\n").length <= 6 + 1, trailer);
  });

  it("keeps a below-box row that reports a background shell", async () => {
    const src = readFileSync(join(FIXTURES, "real-input.txt"), "utf8").trimEnd();
    const path = join(dirs.tmp, "bg-footer.txt");
    writeFileSync(path, `${src} · 2 shells\n`);
    const { trailer } = await trailerFor(path);
    assert.match(trailer, /2 shells/);
    assert.ok(!trailer.includes("ghost-capture-34"), "the rest of the footer is still dropped");
  });

  it("keeps a below-box row that reports a running local agent", async () => {
    const src = readFileSync(join(FIXTURES, "real-input.txt"), "utf8").trimEnd();
    const path = join(dirs.tmp, "local-agent-footer.txt");
    writeFileSync(path, `${src} · 1 local agent · ↓ to manage\n`);
    const { trailer } = await trailerFor(path);
    assert.match(trailer, /1 local agent · ↓ to manage/);
  });

  it("falls back to the raw tail, dialog text included, when the box has borders but no prompt row", async () => {
    const { trailer } = await trailerFor("dialog-under-two-rules.txt");
    assert.match(trailer, /Do you want to run this command again\?/);
    assert.ok(!trailer.includes("could not be classified"), trailer);
  });

  it("falls back to the raw tail when the prompt glyph has drifted", async () => {
    const { trailer } = await trailerFor("drifted-prompt-glyph.txt");
    assert.ok(!trailer.includes("could not be classified"), trailer);
  });

  it("masks a choice-dialog marker in the rows above the box on the view path", async () => {
    const { trailer } = await trailerFor(withAbove(["please note Esc to cancel and ctrl+g to edit in vim"]));
    assert.match(trailer, /\[dialog marker masked\]/);
    assert.ok(!/Esc to cancel|ctrl\+g to edit in/.test(trailer), trailer);
    assert.match(trailer, /input box: UNSUBMITTED TEXT/, "the view path, not the fallback, produced this");
  });

  it("strips OSC 8 hyperlink bytes from the rows it shows", async () => {
    const { trailer } = await trailerFor("codex-idle-ghost-e.txt", "codex");
    assert.ok(!trailer.includes("]8;;"), trailer);
    assert.match(trailer, /input box: empty \(a model suggestion is showing/);
  });

  it("falls back to the old raw tail byte-for-byte when no input box can be found", async () => {
    const { trailer } = await trailerFor("model-picker-dialog.txt");
    const expected = sanitizeTail(capturePane(watchedPane, tailCaptureLines()));
    assert.equal(trailer, expected.replace(/Esc to cancel|ctrl\+g to edit in/g, "[dialog marker masked]"));
  });

  it("keeps the closing sentence verbatim", async () => {
    const { text } = await trailerFor("ghost-suggestion.txt");
    assert.ok(
      text.includes(
        "hive fires this on each worker's own hook state. If a terminal above shows work still running, that worker is not finished: read agent_output before acting on it.",
      ),
    );
  });
});
