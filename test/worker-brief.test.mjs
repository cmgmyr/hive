import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// brief.js resolves paths from HIVE_DATA_DIR at import time, so point it at a
// scratch dir before the dynamic import below. It reads dataDir.js and never
// db.js, so importing it creates no store.
const scratch = mkdtempSync(join(tmpdir(), "hive-brief-"));
process.env.HIVE_DATA_DIR = scratch;
const {
  agentBriefPath,
  isClaudeCommand,
  paneAnnouncement,
  readAgentBrief,
  workerBrief,
  workerCommandString,
  writeAgentBrief,
} = await import("../dist/brief.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

const ctx = {
  name: "api-worker",
  actorId: "agent:7",
  projectName: "hive",
  projectPath: "/Users/x/Code/hive",
  cwd: "/Users/x/Code/hive/wt/api",
};

describe("recognising claude", () => {
  it("sees through an absolute path and trailing arguments", () => {
    // hive.yml can say `lead: /opt/homebrew/bin/claude --model opus`, and
    // agent_spawn can be handed the same. One predicate answers for the lead
    // command, the worker command, and the flags each gets.
    for (const command of ["claude", "claude --model opus", "/opt/homebrew/bin/claude", "  claude  "]) {
      assert.equal(isClaudeCommand(command), true, command);
    }
    for (const command of ["codex", "claude-code", "/usr/bin/env claude", ""]) {
      assert.equal(isClaudeCommand(command), false, command);
    }
  });

  it("gives an absolute-path claude worker the same flags as a bare one", () => {
    const cmd = workerCommandString({
      command: "/opt/homebrew/bin/claude",
      settingsPath: "/data/hooks.json",
      briefPath: "/data/briefs/agent-7.md",
    });
    assert.match(cmd, /--settings/);
    assert.match(cmd, /--append-system-prompt-file/);
  });
});

describe("worker command string", () => {
  it("gives a claude worker both the hooks file and the brief", () => {
    const cmd = workerCommandString({
      command: "claude",
      settingsPath: "/data/hooks.json",
      briefPath: "/data/briefs/agent-7.md",
    });
    assert.equal(cmd, "claude --settings /data/hooks.json --append-system-prompt-file /data/briefs/agent-7.md");
  });

  it("keeps model first and extra args last", () => {
    const cmd = workerCommandString({
      command: "claude",
      model: "opus",
      extraArgs: ["--dangerously-skip-permissions"],
      settingsPath: "/data/hooks.json",
      briefPath: "/data/briefs/agent-7.md",
    });
    assert.match(cmd, /^claude --model opus --settings .* --append-system-prompt-file .* --dangerously-skip-permissions$/);
  });

  it("passes neither flag to a non-claude command", () => {
    const cmd = workerCommandString({
      command: "codex",
      model: "gpt-5",
      extraArgs: ["--yolo"],
      settingsPath: "/data/hooks.json",
      briefPath: "/data/briefs/agent-7.md",
    });
    assert.equal(cmd, "codex --model gpt-5 --yolo");
    assert.doesNotMatch(cmd, /--append-system-prompt-file|--settings/);
  });

  it("quotes paths that need it, since the string is handed to a shell", () => {
    const cmd = workerCommandString({
      command: "claude",
      briefPath: "/data/my briefs/agent-7.md",
    });
    assert.match(cmd, /--append-system-prompt-file '\/data\/my briefs\/agent-7.md'/);
  });
});

describe("worker brief file", () => {
  it("round-trips per agent under the data dir", () => {
    const path = writeAgentBrief(7, workerBrief(ctx));
    assert.equal(path, agentBriefPath(7));
    assert.equal(path, join(scratch, "briefs", "agent-7.md"));

    const onDisk = readFileSync(path, "utf8");
    assert.match(onDisk, /You are agent "api-worker" \(actor id: agent:7\)/);
    assert.match(onDisk, /HIVE_PROJECT_LOCK=1/);
    assert.equal(readAgentBrief(7), onDisk);
  });

  it("returns null for an agent that was never briefed", () => {
    assert.equal(readAgentBrief(4242), null);
  });
});

describe("project posture file", () => {
  it("writes one rendered file per project, overwriting in place", async () => {
    const { projectPosturePath, writeProjectPosture } = await import("../dist/brief.js");
    const first = writeProjectPosture(3, "Lead for cmgmyr/hive.");
    assert.equal(first, projectPosturePath(3));
    assert.equal(first, join(scratch, "postures", "project-3.md"));
    assert.equal(readFileSync(first, "utf8"), "Lead for cmgmyr/hive.\n");

    // Bounded by project count and derived from the profile, so `hive lead`
    // overwrites rather than accumulating a file per run.
    writeProjectPosture(3, "Lead for someone/else.");
    assert.equal(readFileSync(first, "utf8"), "Lead for someone/else.\n");
    assert.notEqual(projectPosturePath(4), first);
  });
});

describe("pane announcement", () => {
  const line = paneAnnouncement(ctx);

  it("stays on one line", () => {
    // It is typed with send-keys -l before claude enables bracketed paste; a
    // newline would submit half a sentence.
    assert.equal(line.includes("\n"), false);
  });

  it("marks itself as hive's, not the human's", () => {
    assert.match(line, /^\[hive\] /);
  });

  it("carries the identity the transcript will not have", () => {
    for (const fragment of ["api-worker", "agent:7", "hive", ctx.cwd, "whoami"]) {
      assert.ok(line.includes(fragment), `announcement should mention ${fragment}: ${line}`);
    }
  });
});
