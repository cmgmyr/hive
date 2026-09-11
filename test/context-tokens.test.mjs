import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-context-tokens-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = scratch;
process.env.HIVE_DATA_DIR = scratch;
const { CONTEXT_TOKENS_TAIL_BYTES, readContextTokens, readContextFill, claudeWindowPath, transcriptDir } = await import("../dist/transcript.js");

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

function fillFixture(lines, window = 1000000) {
  const path = join(scratch, `record-${seq++}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  const worker = { actor_id: `agent:${seq++}`, cwd: scratch, session_id: "", transcript_path: path };
  mkdirSync(join(scratch, "context-windows"), { recursive: true });
  writeFileSync(claudeWindowPath(worker.actor_id), JSON.stringify(window));
  return worker;
}

function codexLine(input, window = 800000) {
  return JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: input, cached_input_tokens: input - 1, output_tokens: 900 },
    total_token_usage: { input_tokens: 41000000, total_tokens: 42000000 },
    model_context_window: window,
  } } });
}

describe("readContextFill", () => {
  it("uses the latest Claude message once across duplicate content blocks, sums three input fields, and excludes output", () => {
    const last = JSON.stringify({ type: "assistant", message: { id: "last", usage: {
      input_tokens: 700, cache_read_input_tokens: 33000, cache_creation_input_tokens: 2300, output_tokens: 20000,
    } } });
    const worker = fillFixture([assistantLine(123), last, last, userLine()]);
    assert.deepEqual(readContextFill("claude", worker), { used_tokens: 36000, window_tokens: 1000000, used_percent: 4 });
  });

  it("uses Claude cwd/session fallback and returns null without an authoritative window", () => {
    const cwd = fixtureCwd("fallback");
    const session_id = seedTranscript(cwd, [assistantLine(1234)]);
    const worker = fillFixture([]);
    Object.assign(worker, { cwd, session_id, transcript_path: "" });
    assert.equal(readContextFill("claude", worker).used_tokens, 1234);
    rmSync(claudeWindowPath(worker.actor_id));
    assert.equal(readContextFill("claude", worker), null);
  });

  it("skips malformed and synthetic Claude trailing records without changing the previous numerator", () => {
    const worker = fillFixture([assistantLine(111), syntheticApiErrorLine(), '{"type":"assistant"']);
    assert.equal(readContextFill("claude", worker).used_tokens, 111);
  });

  it("uses the last Codex request and inline window without adding cached, output, or cumulative tokens", () => {
    const worker = fillFixture([codexLine(100), codexLine(240141, 828400), userLine()]);
    assert.deepEqual(readContextFill("codex", worker), { used_tokens: 240141, window_tokens: 828400, used_percent: 29 });
  });

  it("rejects cumulative-only Codex usage and invalid windows or input counts", () => {
    for (const info of [
      { total_token_usage: { input_tokens: 40000000 }, model_context_window: 800000 },
      { last_token_usage: { input_tokens: -1 }, model_context_window: 800000 },
      { last_token_usage: { input_tokens: 100 }, model_context_window: 0 },
      { last_token_usage: { input_tokens: "100" }, model_context_window: 800000 },
    ]) {
      const worker = fillFixture([JSON.stringify({ type: "event_msg", payload: { type: "token_count", info } })]);
      assert.equal(readContextFill("codex", worker), null);
    }
  });

  it("skips Codex null-info and mid-write events to the preceding usable record", () => {
    const worker = fillFixture([codexLine(567), JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }), '{"type":']);
    assert.equal(readContextFill("codex", worker).used_tokens, 567);
  });

  it("bounds Codex reads to 256 KiB and finds only records inside that tail", () => {
    const filler = "x".repeat(CONTEXT_TOKENS_TAIL_BYTES + 4096);
    assert.equal(readContextFill("codex", fillFixture([codexLine(100), filler])), null);
    assert.equal(readContextFill("codex", fillFixture([codexLine(100), filler, codexLine(200)])).used_tokens, 200);
  });

  it("returns null for empty, missing, and unusable Codex records", () => {
    const worker = fillFixture([userLine()]);
    assert.equal(readContextFill("codex", worker), null);
    rmSync(worker.transcript_path);
    assert.equal(readContextFill("codex", worker), null);
    worker.transcript_path = "";
    assert.equal(readContextFill("codex", worker), null);
  });
});
