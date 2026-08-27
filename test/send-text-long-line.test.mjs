import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, scratchDirs, tmuxCallsIn, recordingTmux, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the sendText long-line tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sendText, sessionName, shellQuote } = await import("../dist/tmux.js");

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// tmux hands a pane's own input to it in 1022-byte writes on this platform, so
// anything longer arrives in pieces however it was sent. Sized well past that.
const LONG_TEXT = `HEAD-${"pinned single-paragraph prose with no newline in it. ".repeat(30)}-TAIL`;

const readerLog = join(dirs.tmp, "received.bin");
const readerReady = join(dirs.tmp, "reader-ready");
const readerScript = join(dirs.tmp, "reader.mjs");

// Enables bracketed-paste mode the way a real TUI does: tmux emits the markers
// only for a pane whose application asked for them.
writeFileSync(
  readerScript,
  `import { appendFileSync, writeFileSync } from "node:fs";
process.stdin.setRawMode?.(true);
process.stdout.write("\\x1b[?2004h");
process.stdin.resume();
writeFileSync(${JSON.stringify(readerLog)}, "");
process.stdin.on("data", (d) => appendFileSync(${JSON.stringify(readerLog)}, d));
setTimeout(() => writeFileSync(${JSON.stringify(readerReady)}, "ok"), 300);
setTimeout(() => process.exit(0), 120000);
`,
);

const session = sessionName();
let pane;

before(async () => {
  if (!hasTmux) return;
  execFileSync("tmux", [
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "220",
    "-y",
    "60",
    "-c",
    dirs.projectDir,
    `${shellQuote(process.execPath)} ${shellQuote(readerScript)}`,
  ]);
  pane = execFileSync("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  await until(() => existsSync(readerReady), 10000);
});

after(() => {
  cleanup(session);
});

describe("a newline-free text longer than one pty write reaches the pane whole", () => {
  it(
    "arrives inside bracketed-paste markers, which is the only thing that lets a TUI rejoin tmux's 1022-byte writes",
    NEEDS_TMUX,
    async () => {
      assert.ok(LONG_TEXT.length > 1022, "the text has to exceed one pty write or this test proves nothing");
      assert.ok(!LONG_TEXT.includes("\n"), "a newline would take the paste path for the wrong reason");

      await sendText(pane, LONG_TEXT, false);
      await until(() => readFileSync(readerLog, "utf8").includes("-TAIL"), 10000);

      const received = readFileSync(readerLog, "utf8");
      assert.ok(received.includes(LONG_TEXT), "the pane did not receive every byte of the text");
      const start = received.indexOf(PASTE_START);
      const end = received.indexOf(PASTE_END);
      assert.ok(start !== -1, "no bracketed-paste start marker: the pane got raw keystrokes and will keep only the last write");
      assert.ok(end !== -1, "no bracketed-paste end marker");
      assert.ok(start < received.indexOf(LONG_TEXT), "the start marker must precede the text");
      assert.ok(end > received.indexOf(LONG_TEXT), "the end marker must follow the text");
    },
  );
});

describe("no length of text is typed as raw keystrokes any more", () => {
  it("never calls send-keys -l for text, whether or not it carries a newline", NEEDS_TMUX, async () => {
    const log = join(dirs.tmp, "tmux-calls.log");
    const shim = recordingTmux({ log });
    const savedPath = process.env.PATH;
    process.env.PATH = `${shim}:${savedPath}`;
    try {
      await sendText(pane, "short one-liner", false);
      await sendText(pane, LONG_TEXT, false);
      await sendText(pane, "two\nlines", false);
    } finally {
      process.env.PATH = savedPath;
    }

    const calls = tmuxCallsIn(log);
    // The positive half first: an empty log satisfies the negative assertion
    // below just as well as a fixed sendText does (test/CLAUDE.md, shape 7).
    assert.equal(
      calls.filter((call) => call[0] === "set-buffer").length,
      3,
      "the shim recorded no set-buffer, so the negative assertion below would pass on an empty log",
    );
    assert.equal(calls.filter((call) => call[0] === "paste-buffer").length, 3, "every set-buffer needs its paste");

    const literalTypes = calls.filter((call) => call[0] === "send-keys" && call.includes("-l"));
    assert.deepEqual(literalTypes, [], "text still reaches send-keys -l, where anything past 1022 bytes loses its head");
  });
});
