import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-brief-"));
process.env.HIVE_DATA_DIR = scratch;
const {
  agentBriefPath,
  harnessBriefVars,
  isClaudeCommand,
  mergedBriefVars,
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

  it("titles a claude worker with its hive name", () => {
    const cmd = workerCommandString({
      command: "claude",
      displayName: "api-worker",
      settingsPath: "/data/hooks.json",
    });
    assert.match(cmd, /--name api-worker/);
  });

  it("does not pass --name to a non-claude command", () => {
    const cmd = workerCommandString({ command: "codex", displayName: "api-worker" });
    assert.equal(cmd, "codex");
  });

  it("quotes a name with spaces, since the string is handed to a shell", () => {
    const cmd = workerCommandString({ command: "claude", displayName: "api worker" });
    assert.match(cmd, /--name 'api worker'/);
  });

  it("yields to an explicit --name in extra args rather than passing two", () => {
    for (const flag of ["--name", "-n"]) {
      const cmd = workerCommandString({
        command: "claude",
        displayName: "api-worker",
        extraArgs: [flag, "chosen"],
      });
      assert.equal(cmd, `claude ${flag} chosen`, flag);
    }
  });

  it("yields to the joined and attached forms too", () => {
    for (const arg of ["--name=chosen", "-n=chosen", "-nchosen"]) {
      const cmd = workerCommandString({
        command: "claude",
        displayName: "api-worker",
        extraArgs: [arg],
      });
      assert.equal(cmd, `claude ${arg}`, arg);
    }
  });

  it("does not mistake an unrelated long flag for a name", () => {
    const cmd = workerCommandString({
      command: "claude",
      displayName: "api-worker",
      extraArgs: ["--no-color"],
    });
    assert.equal(cmd, "claude --name api-worker --no-color");
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

    assert.match(onDisk, /Run whoami to confirm scope, then wait for your assignment\./);
    assert.equal(readAgentBrief(7), onDisk);
  });

  it("returns null for an agent that was never briefed", () => {
    assert.equal(readAgentBrief(4242), null);
  });
});

describe("a profile's own worker.md still gets the wait-for-assignment instruction", () => {

  it("appends the instruction after a profile's own worker.md content", () => {
    const profileDir = join(scratch, "profiles", "test-profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "worker.md"), "Custom orchestration brief for {{agent_name}}.");

    const rendered = workerBrief({ ...ctx, profile: "test-profile" });
    assert.match(rendered, /^Custom orchestration brief for api-worker\./);
    assert.match(rendered, /Run whoami to confirm scope, then wait for your assignment\.$/);
  });

  it("still falls through to the default brief for a profile with no worker.md", () => {
    const profileDir = join(scratch, "profiles", "posture-only-profile");
    mkdirSync(profileDir, { recursive: true });

    const rendered = workerBrief({ ...ctx, profile: "posture-only-profile" });
    assert.match(rendered, /\[HIVE CONTEXT\]/);
    assert.match(rendered, /Run whoami to confirm scope, then wait for your assignment\./);
  });
});

describe("harnessBriefVars", () => {
  it("sets harness_codex, not harness_claude, for a codex command", () => {
    assert.deepEqual(harnessBriefVars("codex"), { harness_codex: "1" });
  });

  it("sets harness_claude for a claude command", () => {
    assert.deepEqual(harnessBriefVars("claude"), { harness_claude: "1" });
  });

  it("sets harness_claude for an unrecognised harness, since a presence-conditional has no else", () => {
    assert.deepEqual(harnessBriefVars("unknown"), { harness_claude: "1" });
    assert.deepEqual(harnessBriefVars(""), { harness_claude: "1" });
  });
});

describe("worker.md renders the right harness-conditional block", () => {
  const fixtureBrief = [
    "before",
    "<!--if:harness_claude-->",
    "claude-text",
    "<!--end-->",
    "<!--if:harness_codex-->",
    "codex-text",
    "<!--end-->",
    "after",
  ].join("\n");

  function renderFor(harnessName, extraVars = {}) {
    const profileName = `harness-fixture-${harnessName}-${Object.keys(extraVars).join(",")}`;
    const profileDir = join(scratch, "profiles", profileName);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "worker.md"), fixtureBrief);
    return workerBrief({
      ...ctx,
      profile: profileName,
      vars: mergedBriefVars(extraVars, harnessName),
    });
  }

  it("a codex worker sees codex-text and not claude-text", () => {
    const rendered = renderFor("codex");
    assert.match(rendered, /codex-text/);
    assert.doesNotMatch(rendered, /claude-text/);
  });

  it("a claude worker sees claude-text and not codex-text", () => {
    const rendered = renderFor("claude");
    assert.match(rendered, /claude-text/);
    assert.doesNotMatch(rendered, /codex-text/);
  });

  it("an unrecognised harness command still renders claude-text, not neither block", () => {
    const rendered = renderFor("unknown");
    assert.match(rendered, /claude-text/);
    assert.doesNotMatch(rendered, /codex-text/);
  });

  it("a project var literally named codex does not change which block a claude worker sees", () => {

    const rendered = renderFor("claude", { codex: "1" });
    assert.match(rendered, /claude-text/);
    assert.doesNotMatch(rendered, /codex-text/);
  });

  it("a project var named harness_claude does not survive a codex spawn", () => {
    const rendered = renderFor("codex", { harness_claude: "1" });
    assert.match(rendered, /codex-text/);
    assert.doesNotMatch(rendered, /claude-text/);
  });

  it("a project var named harness_codex does not survive a claude spawn", () => {
    const rendered = renderFor("claude", { harness_codex: "1" });
    assert.match(rendered, /claude-text/);
    assert.doesNotMatch(rendered, /codex-text/);
  });
});

describe("mergedBriefVars", () => {
  it("strips a project's own harness_claude before a codex spawn, rather than leaving both set", () => {
    assert.deepEqual(mergedBriefVars({ harness_claude: "1" }, "codex"), { harness_codex: "1" });
  });

  it("strips a project's own harness_codex before a claude spawn, rather than leaving both set", () => {
    assert.deepEqual(mergedBriefVars({ harness_codex: "1" }, "claude"), { harness_claude: "1" });
  });

  it("passes an unrelated project var through untouched", () => {
    assert.deepEqual(mergedBriefVars({ foo: "bar" }, "claude"), { foo: "bar", harness_claude: "1" });
  });

  it("handles no project vars at all", () => {
    assert.deepEqual(mergedBriefVars(undefined, "codex"), { harness_codex: "1" });
  });
});

describe("project posture file", () => {
  it("writes one rendered file per project, overwriting in place", async () => {
    const { projectPosturePath, writeProjectPosture } = await import("../dist/brief.js");
    const first = writeProjectPosture(3, "Lead for cmgmyr/hive.");
    assert.equal(first, projectPosturePath(3));
    assert.equal(first, join(scratch, "postures", "project-3.md"));
    assert.equal(readFileSync(first, "utf8"), "Lead for cmgmyr/hive.\n");

    writeProjectPosture(3, "Lead for someone/else.");
    assert.equal(readFileSync(first, "utf8"), "Lead for someone/else.\n");
    assert.notEqual(projectPosturePath(4), first);
  });
});
