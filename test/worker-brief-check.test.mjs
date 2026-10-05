import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-worker-brief-check-"));
process.env.HIVE_DATA_DIR = scratch;
const { mergedBriefVars, workerBrief } = await import("../dist/brief.js");

after(() => rmSync(scratch, { recursive: true, force: true }));

const ctx = {
  name: "api-worker",
  actorId: "agent:7",
  projectName: "hive",
  projectPath: "/Users/x/Code/hive",
  cwd: "/Users/x/Code/hive/wt/api",
};

function renderShipped(vars) {
  return workerBrief({ ...ctx, profile: "orchestration", vars });
}

describe("shipped orchestration worker.md: before-you-report-done block (todo 792)", () => {
  it("ends the profile's own text with the block, ahead of hive's wait-for-assignment line", () => {
    const rendered = renderShipped(mergedBriefVars({}, "claude"));
    const blockAt = rendered.indexOf("BEFORE YOU REPORT DONE");
    const waitAt = rendered.indexOf("Run whoami to confirm scope, then wait for your assignment.");
    assert.notEqual(blockAt, -1, "the block must render at all");
    assert.ok(blockAt < waitAt, "the block must come before hive's own closing line");
  });

  it("carries the always-true steps regardless of check", () => {
    const rendered = renderShipped(mergedBriefVars({}, "claude"));
    assert.match(rendered, /1\. `git -C <your worktree> status`/);
    assert.match(rendered, /2\. Rebuild before any screenshot/);
    assert.match(rendered, /4\. Run the scoped checks again after your last edit/);
    assert.match(rendered, /5\. Commit; do not push\./);
    assert.match(rendered, /6\. Report on the todo:.*You do not complete the todo\./);
    assert.match(rendered, /7\. Run the readers the brief names/);
  });

  it("renders step 3 with the project's check command when vars.check is set", () => {
    const rendered = renderShipped(mergedBriefVars({ check: "npm run lint && npx tsc --noEmit" }, "claude"));
    assert.match(rendered, /3\. Run this project's gates and fix what they find: npm run lint && npx tsc --noEmit/);
  });

  it("drops step 3 entirely, without renumbering, when vars.check is unset", () => {
    const rendered = renderShipped(mergedBriefVars({}, "claude"));
    assert.doesNotMatch(rendered, /Run this project's gates and fix what they find/);
    assert.doesNotMatch(rendered, /^3\./m);
    assert.match(rendered, /4\. Run the scoped checks again/);
  });

  it("says nothing machine-specific: no signing flag, no unshipped skill name, no personal path", () => {
    // Forbidden substrings are built at runtime, not spelled out here, so this
    // test itself does not become a tracked-tree leak.
    const rendered = renderShipped(mergedBriefVars({ check: "npm run build" }, "claude"));
    const forbidden = [
      "gpg-sign",
      ["cg", "review"].join("-"),
      ["cg", "architecture-review"].join("-"),
      ["/code", "review"].join("-"),
      ["codex", "review"].join(" "),
      ["/Users/", "ch", "ris"].join(""),
    ];
    for (const needle of forbidden) {
      assert.ok(!rendered.toLowerCase().includes(needle.toLowerCase()), `must not contain ${needle}`);
    }
  });

  it("names no harness-specific reader command, since neither harness's default is a hive feature", () => {
    const codex = renderShipped(mergedBriefVars({}, "codex"));
    const claude = renderShipped(mergedBriefVars({}, "claude"));
    for (const rendered of [codex, claude]) {
      assert.match(rendered, /7\. Run the readers the brief names, with this harness's own review command, and post their findings raw\./);
    }
  });
});

describe("shipped orchestration: one dispatch and completion owner across the three files", () => {
  it("worker.md assigns by todo id and leaves completion to the lead", () => {
    const rendered = renderShipped(mergedBriefVars({}, "claude"));
    assert.match(rendered, /todo_get on the ids your brief names/);
    assert.match(rendered, /Do not take work off todo_list yourself/);
    assert.doesNotMatch(rendered, /todo_list\(is_blocked=false/);
    assert.doesNotMatch(rendered, /then todo_complete/);
  });

  it("runbook.md and posture.md say only the lead completes a todo", async () => {
    const { readProfileFile } = await import("../dist/profiles.js");
    assert.match(readProfileFile("orchestration", "runbook.md"), /a worker never completes its own todo/);
    assert.match(readProfileFile("orchestration", "posture.md"), /Only you complete a todo/);
  });

  it("posture.md carries the model-tier rule and no model id", async () => {
    const { readProfileFile } = await import("../dist/profiles.js");
    const posture = readProfileFile("orchestration", "posture.md");
    assert.match(posture, /strongest model tier/);
    assert.doesNotMatch(posture, /claude-|gpt-|opus|sonnet|haiku/i);
  });

  it("carries no opt-in mode var", async () => {
    const { readProfileFile } = await import("../dist/profiles.js");
    for (const f of ["posture.md", "runbook.md", "worker.md"]) {
      assert.doesNotMatch(readProfileFile("orchestration", f), /orchestration_workflow/);
    }
  });
});
