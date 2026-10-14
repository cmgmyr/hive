import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("kv non-JSON tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
let mcp;
let projectId;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  await mcp.call("whoami");
  projectId = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir).id;
});

after(async () => {
  await mcp?.close();
  cleanupTmux();
});

describe("legacy kv values", () => {
  it("kv_get returns a legacy non-JSON value as its raw string", async () => {
    db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, ?, ?)").run(
      projectId,
      "legacy",
      "raw value",
    );

    const got = await mcp.call("kv_get", { key: "legacy" });

    assert.equal(got.found, true);
    assert.equal(got.value, "raw value");
  });

  it("kv_list returns a legacy non-JSON scheduler row without throwing", async () => {
    db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, ?, ?)").run(
      projectId,
      "hive:queen-page-claim",
      "",
    );

    const listed = await mcp.call("kv_list", { prefix: "hive:queen-page-" });

    assert.deepEqual(
      listed.entries.map(({ key, value }) => ({ key, value })),
      [{ key: "hive:queen-page-claim", value: "" }],
    );
  });

  it("kv_list prefix matches wildcard punctuation, backslash, non-ASCII, and case exactly", async () => {
    await mcp.call("kv_set", { key: "tmux_tested_version", value: "exact" });
    await mcp.call("kv_set", { key: "tmuxAtested_version", value: "underscore wildcard" });
    await mcp.call("kv_set", { key: "tmux%tested_version", value: "percent" });
    await mcp.call("kv_set", { key: "TMUX_tested_version", value: "different case" });
    await mcp.call("kv_set", { key: "tmux\\tested_version", value: "backslash" });
    await mcp.call("kv_set", { key: "préfix_key", value: "unicode" });

    const listed = await mcp.call("kv_list", { prefix: "tmux_" });
    const backslash = await mcp.call("kv_list", { prefix: "tmux\\" });
    const unicode = await mcp.call("kv_list", { prefix: "pré" });

    assert.deepEqual(listed.entries.map(({ key }) => key), ["tmux_tested_version"]);
    assert.deepEqual(backslash.entries.map(({ key }) => key), ["tmux\\tested_version"]);
    assert.deepEqual(unicode.entries.map(({ key }) => key), ["préfix_key"]);
  });
});
