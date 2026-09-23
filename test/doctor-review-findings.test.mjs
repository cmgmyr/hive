import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, after } from "node:test";

import {
  McpClient,
  failureCount,
  isolateTmux,
  makeFakeClaude,
  runCli,
  scratchDirs,
  warningCount,
} from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the doctor review-findings tests");
after(() => cleanupTmux());
process.env.CODEX_HOME = scratchDirs().tmp;

const TAGS = ["from-review-a", "from-review-b"];

function configureTags(dirs, tags = TAGS) {
  writeFileSync(join(dirs.projectDir, "hive.yml"), `review_tags: [${tags.join(", ")}]\n`);
  return dirs;
}

async function seed(dirs, fn) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

const TMUX_DIR = dirname(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());

function isolatedDoctorEnv(dirs) {
  const configDir = join(dirs.tmp, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const claudeBin = makeFakeClaude(dirs.tmp)();
  return {
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,

    tmp: dirs.tmp,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-here"),

      PATH: `${dirname(process.execPath)}:${TMUX_DIR}:${dirname(claudeBin)}:/usr/bin:/bin`,
    },
  };
}

describe("hive doctor: review findings (todo 349, made configurable in todo 748)", () => {
  it("says the project configured no review_tags, rather than counting against tags hive invented", async () => {
    const dirs = scratchDirs();
    writeFileSync(join(dirs.projectDir, "hive.yml"), "placement: split\n");
    await seed(dirs, async (mcp) => {
      await mcp.call("todo_create", { title: "a todo nobody tagged", tags: ["from-review-a"] });
    });

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: no review_tags configured; nothing to track\./);
    assert.doesNotMatch(stdout, /warn {2}review findings/);
  });

  it("names no config file while reporting that, so doctor stays silent about an unremarkable hive.yml", async () => {
    const dirs = scratchDirs();
    writeFileSync(join(dirs.projectDir, "hive.yml"), "placement: split\n");
    await seed(dirs, async (mcp) => {
      await mcp.call("todo_create", { title: "a todo nobody tagged", tags: ["from-review-a"] });
    });

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: /);
    assert.doesNotMatch(stdout, /hive\.yml/);
  });

  it("reads 0 tracked, not silence, when tags are configured and nothing carries one", async () => {
    const dirs = configureTags(scratchDirs());
    await seed(dirs, async (mcp) => {
      await mcp.call("todo_create", { title: "untagged todo" });
    });

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(
      stdout,
      /info {2}review findings: 0 tracked \(tagged from-review-a, from-review-b\): 0 triaged, 0 untriaged\./,
    );
    assert.doesNotMatch(stdout, /warn {2}review findings/);
  });

  it("counts a comment, completed, or archived finding as triaged, and an untagged one not at all", async () => {
    const dirs = configureTags(scratchDirs());
    const ids = await seed(dirs, async (mcp) => {
      const commented = await mcp.call("todo_create", { title: "triaged by comment", tags: ["from-review-a"] });
      await mcp.call("todo_comment", { todo_id: commented.todo_id, body: "read and dispatched" });

      const completed = await mcp.call("todo_create", { title: "triaged by completion", tags: ["from-review-b"] });
      await mcp.call("todo_update", { todo_id: completed.todo_id, status: "completed" });

      const archived = await mcp.call("todo_create", { title: "triaged by archive", tags: ["from-review-a"] });
      await mcp.call("todo_archive", { todo_id: archived.todo_id });

      await mcp.call("todo_create", { title: "irrelevant untagged todo" });

      return { commented, completed, archived };
    });

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(
      stdout,
      /info {2}review findings: 3 tracked \(tagged from-review-a, from-review-b\): 3 triaged, 0 untriaged\./,
    );
    assert.doesNotMatch(stdout, /warn {2}review findings/);
    for (const id of Object.values(ids).map((t) => t.todo_id)) {
      assert.doesNotMatch(stdout, new RegExp(`todo ${id}\\b`));
    }
  });

  it("names an untriaged finding by id and does not fold it into 'All good.'", async () => {
    const dirs = configureTags(scratchDirs());
    const isolated = isolatedDoctorEnv(dirs);

    const clean = await runCli(["doctor"], isolated);
    assert.match(clean.stdout, /All good\./, clean.stdout);

    const untriaged = await seed(dirs, async (mcp) => {
      const triaged = await mcp.call("todo_create", { title: "already handled", tags: ["from-review-a"] });
      await mcp.call("todo_comment", { todo_id: triaged.todo_id, body: "rejected: not a bug" });
      return await mcp.call("todo_create", { title: "left rotting", tags: ["from-review-b"] });
    });

    const { stdout } = await runCli(["doctor"], isolated);
    assert.match(
      stdout,
      /info {2}review findings: 2 tracked \(tagged from-review-a, from-review-b\): 1 triaged, 1 untriaged\./,
    );
    assert.match(stdout, new RegExp(`warn {2}review findings: 1 untriaged: todo ${untriaged.todo_id}\\.`));
    assert.doesNotMatch(stdout, /All good\./, stdout);
  });

  it("tracks a per-round suffix of a configured tag as that tag, not as untagged", async () => {
    const dirs = configureTags(scratchDirs());
    const untriaged = await seed(dirs, (mcp) =>
      mcp.call("todo_create", { title: "finding from round 23", tags: ["from-review-a-23"] }),
    );

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(
      stdout,
      /info {2}review findings: 1 tracked \(tagged from-review-a, from-review-b\): 0 triaged, 1 untriaged\./,
    );
    assert.match(stdout, new RegExp(`warn {2}review findings: 1 untriaged: todo ${untriaged.todo_id}\\.`));
  });

  it("does not match a tag that only shares a prefix with no separator", async () => {
    const dirs = configureTags(scratchDirs());
    await seed(dirs, (mcp) => mcp.call("todo_create", { title: "unrelated todo", tags: ["from-review-annex"] }));

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(
      stdout,
      /info {2}review findings: 0 tracked \(tagged from-review-a, from-review-b\): 0 triaged, 0 untriaged\./,
    );
  });

  it("reports exactly the tags hive.yml names, so the list is the project's and not hive's", async () => {
    const dirs = configureTags(scratchDirs(), ["needs-triage"]);
    const untriaged = await seed(dirs, (mcp) =>
      mcp.call("todo_create", { title: "external report", tags: ["needs-triage"] }),
    );

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: 1 tracked \(tagged needs-triage\): 0 triaged, 1 untriaged\./);
    assert.match(stdout, new RegExp(`warn {2}review findings: 1 untriaged: todo ${untriaged.todo_id}\\.`));
  });

  it("is non-gating: --strict does not turn it into a problem", async () => {
    const dirs = configureTags(scratchDirs());
    await seed(dirs, async (mcp) => {
      await mcp.call("todo_create", { title: "left rotting", tags: ["from-review-a"] });
    });

    const isolated = isolatedDoctorEnv(dirs);
    const plain = await runCli(["doctor"], isolated);
    const strict = await runCli(["doctor", "--strict"], isolated);
    assert.match(plain.stdout, /warn {2}review findings: 1 untriaged/);

    assert.equal(warningCount(strict.stdout), warningCount(plain.stdout), strict.stdout);

    assert.equal(
      failureCount(strict.stdout),
      failureCount(plain.stdout),
      "a non-gating warn must not change the problem count under --strict",
    );
  });
});
