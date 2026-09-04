import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { resolveTranscriptDir, transcriptDir, transcriptDirName } from "../dist/transcript.js";

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
