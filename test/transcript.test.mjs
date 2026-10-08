import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  RECENT_TOOL_CALLS,
  readRecentToolCalls,
  resolveTranscriptDir,
  transcriptDir,
  transcriptDirName,
} from "../dist/transcript.js";

const scratch = mkdtempSync(join(tmpdir(), "hive-transcript-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = scratch;
});

describe("transcriptDirName", () => {

  it("replaces every slash and dot with a dash", () => {
    assert.equal(transcriptDirName("/Users/devs/Code/devteam/hive"), "-Users-devs-Code-devteam-hive");
  });

  it("gives /.claude two dashes, one per character, not one merged separator", () => {
    assert.equal(
      transcriptDirName("/Users/devs/Code/devteam/hive/.claude/worktrees/issue-14-janitor-probe"),
      "-Users-devs-Code-devteam-hive--claude-worktrees-issue-14-janitor-probe",
    );
  });
});

describe("transcriptDir", () => {
  it("joins the encoded name under CLAUDE_CONFIG_DIR/projects", () => {
    assert.equal(
      transcriptDir("/Users/devs/Code/devteam/hive"),
      join(scratch, "projects", "-Users-devs-Code-devteam-hive"),
    );
  });

  it("falls back to ~/.claude only when CLAUDE_CONFIG_DIR is unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const dir = transcriptDir("/Users/devs/Code/devteam/hive");
    assert.ok(dir.endsWith(join(".claude", "projects", "-Users-devs-Code-devteam-hive")), dir);
  });
});

describe("resolveTranscriptDir", () => {

  it("returns the directory when it exists on disk", () => {
    const cwd = "/some/worker/cwd";
    const encoded = transcriptDirName(cwd);
    mkdirSync(join(scratch, "projects", encoded), { recursive: true });

    assert.equal(resolveTranscriptDir(cwd), join(scratch, "projects", encoded));
  });

  it("returns null when nothing was ever written there", () => {
    assert.equal(resolveTranscriptDir("/never/ran/here"), null);
  });
});

const lines = (...records) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const claudeCall = (name, input, timestamp) => ({
  type: "assistant",
  timestamp,
  message: { content: [{ type: "tool_use", name, input }] },
});
const claudeText = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const codexCall = (name, args, timestamp) => ({
  type: "response_item",
  timestamp,
  payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c1" },
});
const worker = (path, extra = {}) => ({ actor_id: "agent:1", cwd: "/work/cwd", session_id: "", transcript_path: path, ...extra });

describe("readRecentToolCalls", () => {
  it("256 KiB tail and eight-call cap exclude oversized older records", () => {
    const file = join(scratch, "cap.jsonl");
    const filler = claudeText("x".repeat(300 * 1024));
    const reads = Array.from({ length: 10 }, (_, i) => claudeCall("Read", { file_path: `/f${i}` }, `2026-10-08T10:00:${String(i).padStart(2, "0")}Z`));
    writeFileSync(file, lines(claudeCall("Bash", { command: "old-marker" }), filler, ...reads));
    const { calls, truncated } = readRecentToolCalls("claude", worker(file));
    assert.equal(RECENT_TOOL_CALLS, 8);
    assert.deepEqual(calls.map((c) => c.input.file_path), reads.slice(2).map((_, i) => `/f${i + 2}`));
    assert.equal(truncated, true);
    assert.equal(calls.some((c) => c.input.command === "old-marker"), false);
    writeFileSync(file, lines(claudeCall("Bash", { command: "old-marker" }), filler));
    assert.deepEqual(readRecentToolCalls("claude", worker(file)).calls, [], "a clipped tail never reaches the record before the filler");
  });

  it("Claude Codex and literal orchestration map without evaluating code", () => {
    const claude = join(scratch, "claude-map.jsonl");
    writeFileSync(claude, lines(
      claudeCall("Edit", { file_path: "/a" }, "2026-10-08T10:00:00Z"),
      { type: "user", message: { content: [{ type: "tool_result", content: "tool_use Bash $cg-review" }] } },
      claudeText("> $cg-review quoted from the user"),
      claudeText("starting\n$cg-review --effort=medium"),
      claudeCall("Bash", { command: "npm test" }),
    ));
    const fromClaude = readRecentToolCalls("claude", worker(claude)).calls;
    assert.deepEqual(fromClaude.map((c) => c.name), ["Edit", "Skill", "Bash"]);
    assert.equal(fromClaude[1].input.skill, "cg-review");
    assert.equal(fromClaude[0].at, "2026-10-08T10:00:00Z");
    assert.equal(fromClaude[2].at, null);

    const codex = join(scratch, "codex-map.jsonl");
    writeFileSync(codex, lines(
      codexCall("exec_command", { cmd: "git status" }, "2026-10-08T11:00:00Z"),
      codexCall("write_stdin", { session_id: 1, chars: "" }),
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" } },
      { type: "response_item", payload: { type: "function_call_output", output: "git commit" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$cg-review" }] } },
      codexCall("functions.exec", { source: "await tools.exec_command({cmd: 'git commit'})" }),
      codexCall("mcp__hive__todo_update", { todo_id: 1 }),
    ));
    const fromCodex = readRecentToolCalls("codex", worker(codex)).calls;
    assert.deepEqual(fromCodex.map((c) => c.name), ["Bash", "apply_patch", "exec", "todo_update"]);
    assert.deepEqual(fromCodex[0].input, { command: "git status" });
    assert.equal(fromCodex[2].input.source.includes("git commit"), true, "the orchestration source is carried as text, never run or unpacked");
  });

  it("malformed clipped missing tails never borrow another session", () => {
    const config = mkdtempSync(join(scratch, "borrow-"));
    process.env.CLAUDE_CONFIG_DIR = config;
    const cwd = "/borrow/cwd";
    const dir = join(config, "projects", transcriptDirName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other-session.jsonl"), lines(claudeCall("Edit", { file_path: "/other" })));
    const own = { cwd, session_id: "mine", transcript_path: "", actor_id: "agent:1" };
    assert.deepEqual(readRecentToolCalls("claude", own), { calls: [], truncated: false }, "no file for this session id means no calls");
    assert.deepEqual(readRecentToolCalls("claude", { ...own, session_id: "" }).calls, []);
    assert.deepEqual(readRecentToolCalls("codex", { ...own, session_id: "other-session" }).calls, [], "codex with no recorded path has nothing to read");

    writeFileSync(join(dir, "mine.jsonl"), lines(
      "{not json",
      claudeCall("Read", { file_path: "/ok" }),
      "[1,2,3]",
      JSON.stringify(claudeCall("Edit", { file_path: "/cut" })).slice(0, 40),
    ).replace(/\n$/, ""));
    assert.deepEqual(readRecentToolCalls("claude", own).calls.map((c) => c.name), ["Read"]);
  });

  it("call timestamps stay null when the record has none", () => {
    const file = join(scratch, "stamps.jsonl");
    writeFileSync(file, lines(claudeCall("Read", {}, "2026-10-08T10:00:00Z"), claudeCall("Grep", {}, "")));
    assert.deepEqual(readRecentToolCalls("claude", worker(file)).calls.map((c) => c.at), ["2026-10-08T10:00:00Z", null]);
  });
});
