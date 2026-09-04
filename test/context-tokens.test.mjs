import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONTEXT_TOKENS_TAIL_BYTES, readContextTokens, transcriptDir } from "../dist/transcript.js";

const scratch = mkdtempSync(join(tmpdir(), "hive-context-tokens-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = scratch;

let seq = 0;

function assistantLine(sum) {

  const input = 2;
  const cacheRead = sum - input;
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: 50 } },
  });
}

function userLine() {
  return JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
}

// Real shape, confirmed against a live transcript under ~/.claude/projects: a mid-response API
// error writes an assistant record with model "<synthetic>" and every usage field 0.
function syntheticApiErrorLine() {
  return JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    message: {
      role: "assistant",
      model: "<synthetic>",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  });
}

function fixtureCwd(name) {
  const cwd = `/fixture/${name}`;
  mkdirSync(transcriptDir(cwd), { recursive: true });
  return cwd;
}

function seedTranscript(cwd, lines) {
  const sessionId = `session-${seq++}`;
  const body = lines.length ? lines.join("\n") + "\n" : "";
  writeFileSync(join(transcriptDir(cwd), `${sessionId}.jsonl`), body);
  return sessionId;
}

describe("readContextTokens", () => {
  it("sums the last assistant record's usage, ignoring non-assistant lines after it (D1)", () => {
    const cwd = fixtureCwd("not-last-line");
    const sessionId = seedTranscript(cwd, [assistantLine(500), userLine(), userLine()]);
    assert.equal(readContextTokens(cwd, sessionId), 500);
  });

  it("returns null, never 0, when the transcript has no assistant record at all", () => {
    const cwd = fixtureCwd("no-assistant");
    const sessionId = seedTranscript(cwd, [userLine(), userLine()]);
    assert.equal(readContextTokens(cwd, sessionId), null);
  });

  it("returns null when the transcript file is missing", () => {
    const cwd = fixtureCwd("missing-file");
    assert.equal(readContextTokens(cwd, "never-written"), null);
  });

  it("returns null when the transcript file is empty", () => {
    const cwd = fixtureCwd("empty-file");
    const sessionId = seedTranscript(cwd, []);
    assert.equal(readContextTokens(cwd, sessionId), null);
  });

  it("falls back to the previous good record when the trailing line is malformed", () => {
    const cwd = fixtureCwd("malformed-tail");
    const sessionId = seedTranscript(cwd, [assistantLine(700), "{not json"]);
    assert.equal(readContextTokens(cwd, sessionId), 700);
  });

  it("returns null when session_id is empty", () => {
    const cwd = fixtureCwd("empty-session-id");
    assert.equal(readContextTokens(cwd, ""), null);
  });

  it("never reads past the trailing window: an early record outside it is invisible (D5)", () => {
    const cwd = fixtureCwd("bound-early-only");
    const filler = "x".repeat(CONTEXT_TOKENS_TAIL_BYTES + 4096);
    const sessionId = seedTranscript(cwd, [assistantLine(111), filler]);
    assert.equal(readContextTokens(cwd, sessionId), null, "the only usage record sits before the tail window and must not be found");
  });

  it("still finds a record inside the tail window of a file larger than the window (D5 positive control)", () => {
    const cwd = fixtureCwd("bound-late-found");
    const filler = "x".repeat(CONTEXT_TOKENS_TAIL_BYTES + 4096);
    const sessionId = seedTranscript(cwd, [assistantLine(111), filler, assistantLine(222)]);
    assert.equal(readContextTokens(cwd, sessionId), 222, "the late record is inside the window and the early one must not leak through");
  });

  it("walks past a trailing synthetic API-error record (usage all zero) to the real record before it", () => {
    const cwd = fixtureCwd("synthetic-api-error-tail");
    const sessionId = seedTranscript(cwd, [assistantLine(900), syntheticApiErrorLine()]);
    assert.equal(readContextTokens(cwd, sessionId), 900, "a zero-sum placeholder must never be reported as the context size");
  });
});
