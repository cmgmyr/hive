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
    assert.match(rendered, /4\. One full test suite at a time on this machine/);
    assert.match(rendered, /5\. Commit; do not push\./);
    assert.match(rendered, /6\. Run the readers the assignment names/);
  });

  it("renders step 3 with the project's check command when vars.check is set", () => {
    const rendered = renderShipped(mergedBriefVars({ check: "npm run lint && npx tsc --noEmit" }, "claude"));
    assert.match(rendered, /3\. Run this project's gates and fix what they find: npm run lint && npx tsc --noEmit/);
  });

  it("drops step 3 entirely, without renumbering, when vars.check is unset", () => {
    const rendered = renderShipped(mergedBriefVars({}, "claude"));
    assert.doesNotMatch(rendered, /Run this project's gates and fix what they find/);
    assert.doesNotMatch(rendered, /^3\./m);
    assert.match(rendered, /4\. One full test suite at a time on this machine/);
  });

  it("says nothing machine-specific: no signing flag, no unshipped skill name, no personal path", () => {
    // Forbidden substrings are built at runtime, not spelled out here, so this
    // test itself does not become a tracked-tree leak (test/no-local-leaks.test.mjs).
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
      assert.match(rendered, /6\. Run the readers the assignment names, with this harness's own review\s+command, and post their findings raw\./);
    }
  });
});
