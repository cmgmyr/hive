import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs, seedLeadRow, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the sender-tag site and behavior tests");
const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

export function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

export const ALLOWLIST = [
  { path: "src/tmux.ts", marker: "export async function sendText" },
  { path: "src/tools/agents.ts", marker: "`/rename ${newName}`" },
  { path: "src/tools/agents.ts", marker: "target,\n              outgoing" },
  { path: "src/scheduler.ts", marker: "prefix + body + noticeStalenessNote" },
];

export function sendTextSites(contents, path) {
  const sites = [];
  for (const match of contents.matchAll(/sendText\(/g)) {
    const line = contents.slice(0, match.index).split("\n").length;
    const end = contents.indexOf(");", match.index);
    const call = contents.slice(match.index - 30, end < 0 ? match.index + 300 : end + 2);
    sites.push({ path, line, call });
  }
  return sites;
}

function allowed(site) {
  return ALLOWLIST.some((entry) => entry.path === site.path && site.call.includes(entry.marker));
}

describe("agent_send sender tags cover every sendText site", () => {
  it("the allowlist is non-empty and rejects an untagged site", () => {
    assert.ok(ALLOWLIST.length > 0, "empty ALLOWLIST cannot protect the sendText invariant");
    assert.equal(allowed({ path: "src/tools/agents.ts", call: "sendText(target,\n              rawText" }), false);
  });

  it("every source sendText site is a tagged delivery, wake, slash command, or definition", () => {
    const sites = trackedFiles(REPO)
      .filter((path) => path.startsWith("src/") && path.endsWith(".ts"))
      .flatMap((path) => sendTextSites(readFileSync(`${REPO}/${path}`, "utf8"), path));
    const uncovered = sites.filter((site) => !allowed(site));
    assert.deepEqual(uncovered, [], `unallowlisted sendText sites:\n${JSON.stringify(uncovered, null, 2)}`);
  });
});

// The site walk above proves every sendText call is TEXTUALLY near an allowlisted marker. It does not
// prove a tag actually reaches the pane: the two describe blocks below run the real code, which the walk
// cannot, and are what the A2 fix round added after two scratch-worktree mutations (senderTag forced to
// "", and the tagged content corrupted while the call-site text was left alone) both left the walk green.

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { senderTag } = await import("../dist/leadMessage.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

const FIXTURES = join(REPO, "test", "fixtures", "panes");
const fakeClaude = makeFakeClaude(dirs.tmp);
const replayFixture = (file) => `cat '${join(FIXTURES, file)}'; sleep 600`;

let mcp;
let projectId;

before(async () => {
  const { id } = db
    .prepare("INSERT INTO projects (name, path) VALUES ('sender-tag-behavior', ?) RETURNING id")
    .get(dirs.projectDir);
  projectId = id;
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "60", "-c", dirs.projectDir]);
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
});

after(async () => {
  if (mcp) await mcp.close();
  cleanup(sessionName());
});

describe("todo 914 A2: senderTag returns the exact decided string per sender kind (comment 4055)", () => {
  it("a lead-kind row tags as [hive:lead], with no name", () => {
    seedLeadRow(db, projectId, dirs.projectDir);
    assert.equal(senderTag(projectId, "lead:999"), "[hive:lead] ");
  });

  it("an agents-row sender (a worker) tags as [hive:worker <name>], with a trailing space", () => {
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, command, cwd, kind, status)
       VALUES (?, 'agent:st-worker', 'cg-812', 'claude', ?, 'agent', 'running')`,
    ).run(projectId, dirs.projectDir);
    assert.equal(senderTag(projectId, "agent:st-worker"), "[hive:worker cg-812] ");
  });

  it("a sender with no agents row in this project tags as [hive:agent <name>], from its actor record (A7)", () => {
    db.prepare("INSERT INTO actors (id, name, kind) VALUES ('agent:st-stranger', 'faraway-worker', 'agent')").run();
    assert.equal(senderTag(projectId, "agent:st-stranger"), "[hive:agent faraway-worker] ");
  });
});

describe("todo 914 A2: an ordinary short worker-bound send opens with the tag on the real pane", () => {
  it("a lead's short assignment to a worker arrives opening with [hive:lead] - the over-300 pointer is not the only tagged path", NEEDS_TMUX, async () => {
    const workerName = "st-a2-worker";
    await mcp.call("agent_spawn", {
      name: workerName,
      command: fakeClaude(replayFixture("ready-idle.txt")),
      extra_args: [],
      placement: "window",
    });
    await until(async () => (await mcp.call("agent_output", { name: workerName })).output.trim() !== "");

    // A lead row may already exist for this project (the senderTag describe block above seeds one at
    // the same fixed actor_id), and seedLeadRow's name is unique per project - so reuse it if present
    // rather than colliding with it.
    const existingLead = db.prepare("SELECT actor_id FROM agents WHERE project_id = ? AND kind = 'lead'").get(projectId);
    if (!existingLead) seedLeadRow(db, projectId, dirs.projectDir);
    const leadActorId = existingLead ? existingLead.actor_id : "lead:999";
    const asLead = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: leadActorId } });
    await asLead.start();
    try {
      await asLead.call("agent_send", { name: workerName, text: "short assignment, well under the threshold" });
    } finally {
      await asLead.close();
    }

    await until(async () =>
      (await mcp.call("agent_output", { name: workerName })).output.includes("short assignment"),
    );
    const { output } = await mcp.call("agent_output", { name: workerName });
    const unwrapped = output.replace(/\s+/g, "");
    assert.ok(
      unwrapped.includes("[hive:lead]shortassignment,wellunderthethreshold"),
      `an ordinary (non-shortened) worker-bound send must open with the tag, got: ${JSON.stringify(output)}`,
    );
  });
});
