import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, REPO, scratchDirs } from "./helpers.mjs";
import { renderToolsSnapshot, SNAPSHOT_PATH, sortKeysDeep, toolsByName } from "../scripts/wire-surface-snapshot.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the wire-surface tests");
after(() => cleanupTmux());

const EXPECTED_TOOL_NAMES = [
  "actor_prune",
  "agent_close",
  "agent_list",
  "agent_output",
  "agent_park",
  "agent_rename",
  "agent_resume",
  "agent_send",
  "agent_spawn",
  "agent_status",
  "help",
  "kv_delete",
  "kv_get",
  "kv_list",
  "kv_set",
  "lease_acquire",
  "lease_release",
  "pad_append",
  "pad_archive",
  "pad_delete",
  "pad_edit",
  "pad_list",
  "pad_read",
  "pad_write",
  "project_add",
  "project_list",
  "project_prune",
  "project_select",
  "todo_archive",
  "todo_block",
  "todo_comment",
  "todo_complete",
  "todo_create",
  "todo_get",
  "todo_list",
  "todo_unblock",
  "todo_update",
  "wake_cancel",
  "wake_get",
  "wake_list",
  "wake_set",
  "wake_update",
  "wake_when_idle",
  "whoami",
];

const MULTIBYTE = ["é", "€", "中", "\u{1f600}"];

function bigPayload(chars) {
  let out = "";
  for (let i = 0; i < chars; i++) {
    let h = (i * 2654435761) >>> 0;

    h = (h ^ (h >>> 15)) >>> 0;
    out += i % 997 === 0 ? MULTIBYTE[h % MULTIBYTE.length] : String.fromCharCode(32 + (h % 95));
  }
  return out;
}

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("MCP wire surface", () => {
  it("tools/list returns the exact expected tool name set", async () => {
    const listed = await mcp.request("tools/list", {});

    assert.equal(listed.result.nextCursor, undefined, "tools/list is paginating; this test only checked page one");
    const names = listed.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, EXPECTED_TOOL_NAMES);
  });

  it("no integer parameter advertises a negative lower bound", async () => {

    const listed = await mcp.request("tools/list", {});
    const offenders = [];
    let integers = 0;
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}/${i}`));
      if (!node || typeof node !== "object") return;
      if (node.type === "integer") {
        integers++;

        const lower = node.minimum ?? node.exclusiveMinimum;
        if (typeof lower !== "number" || lower < 0) offenders.push(`${path} -> ${JSON.stringify(node)}`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
    };
    for (const tool of listed.result.tools) walk(tool.inputSchema, tool.name);

    assert.ok(integers > 0, "no integer schemas found in tools/list; this assertion has nothing to check");
    assert.deepEqual(
      offenders,
      [],
      `these integer parameters advertise a negative lower bound: ${offenders.join(", ")}. ` +
        "Give each one .positive(), .nonnegative(), or its real domain bound in src/tools/, then " +
        "regenerate the snapshot with `node scripts/wire-surface-snapshot.mjs`.",
    );
  });

  it("every tool call hive suggests in its own source names real parameters", async () => {
    const listed = await mcp.request("tools/list", {});
    const declared = new Map(
      listed.result.tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))]),
    );

    const dir = join(REPO, "src");
    const files = readdirSync(dir, { recursive: true })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(dir, f));
    const offenders = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const call of source.matchAll(/\b([a-z]+_[a-z_]+)\(\{?\s*(?=\w+\s*:)/g)) {
        const tool = call[1];
        if (!declared.has(tool)) continue;

        const args = source.slice(call.index, source.indexOf(")", call.index));
        for (const key of args.matchAll(/[({,]\s*(\w+)\s*:/g)) {
          checked++;
          if (!declared.get(tool).has(key[1])) {
            offenders.push(`${file.slice(REPO.length + 1)}: ${tool}(${key[1]}: ...)`);
          }
        }
      }
    }

    assert.ok(checked > 10, `only ${checked} suggested parameters found; this assertion has stopped matching`);
    assert.deepEqual(
      offenders,
      [],
      `these suggested calls name parameters no tool declares, and would be refused with a -32602: ${offenders.join(", ")}`,
    );
  });

  it("no object anywhere in the surface accepts undeclared keys", async () => {

    const listed = await mcp.request("tools/list", {});
    assert.equal(listed.result.nextCursor, undefined, "tools/list is paginating; this assertion only saw page one");
    const offenders = [];
    let objects = 0;
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}/${i}`));
      if (!node || typeof node !== "object") return;
      if (node.type === "object") {
        objects++;
        if (node.additionalProperties !== false) offenders.push(path);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
    };
    for (const tool of listed.result.tools) walk(tool.inputSchema, tool.name);

    assert.ok(
      objects >= listed.result.tools.length && listed.result.tools.length > 0,
      `found ${objects} object schemas across ${listed.result.tools.length} tools; expected at least one root each`,
    );
    assert.deepEqual(
      offenders,
      [],
      `these object schemas do not advertise additionalProperties: false: ${offenders.join(", ")}. ` +
        "A ROOT means something bypassed the wrapper in src/strictInput.ts, applied to the server in " +
        "src/index.ts. A NESTED one means a parameter was declared with z.object; declare it with " +
        "z.strictObject instead, since the wrapper only reaches the root.",
    );
  });

  it("refuses a misspelled optional parameter instead of silently dropping it", async () => {

    const pad = await mcp.call("pad_write", { name: "strict-input-typo-case", content: "guarded" });

    await assert.rejects(
      () => mcp.call("pad_delete", { pad_id: pad.pad_id, expected_revison: pad.revision }),
      /MCP error -32602:.*Unrecognized key: "expected_revison"/,
      "a misspelled expected_revision must be refused with -32602 naming the key, not stripped",
    );

    const survived = await mcp.call("pad_read", { pad_id: pad.pad_id });
    assert.equal(survived.content, "guarded");

    const deleted = await mcp.call("pad_delete", { pad_id: pad.pad_id, expected_revision: survived.revision });
    assert.equal(deleted.deleted, true);
  });

  it("every tool's advertised shape matches the committed wire-surface snapshot", async () => {
    const listed = await mcp.request("tools/list", {});

    const actualTools = toolsByName(listed.result.tools);
    const expectedFile = readFileSync(SNAPSHOT_PATH, "utf8");

    const expectedTools = sortKeysDeep(JSON.parse(expectedFile));

    const allNames = new Set([...Object.keys(actualTools), ...Object.keys(expectedTools)]);
    const changed = [...allNames]
      .filter((name) => JSON.stringify(actualTools[name]) !== JSON.stringify(expectedTools[name]))
      .sort();

    assert.deepEqual(
      changed,
      [],
      `wire surface changed for: ${changed.join(", ")}. Compare each against the committed snapshot at ` +
        `${SNAPSHOT_PATH}. If intended (e.g. lane C's zod 4 bump), regenerate it deliberately with ` +
        "`node scripts/wire-surface-snapshot.mjs` and explain the diff per tool in the PR body.",
    );

    assert.equal(renderToolsSnapshot(listed.result.tools), expectedFile);
  });

  it("a 200KB payload round-trips through real stdio unchanged, both directions", async () => {

    const payload = bigPayload(200_000);

    const written = await mcp.call("pad_write", { name: "wire-surface-payload", content: payload });
    const read = await mcp.call("pad_read", { pad_id: written.pad_id });
    assert.equal(read.content.length, payload.length);
    assert.equal(read.content, payload);
  });
});
