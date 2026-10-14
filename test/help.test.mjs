import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HELP_TOPICS, helpOverview } from "../dist/help.js";

const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/wire-surface/tools-list.snapshot.json"), "utf8"));
const helpText = [helpOverview(), ...Object.values(HELP_TOPICS)].join("\n");

function helpSignatures(text) {
  const signatures = new Map();
  const pattern = /\b([a-z][a-z0-9_]*)\(([^)]*)\)/g;
  for (const match of text.matchAll(pattern)) {
    const [, name, params] = match;
    if (!Object.hasOwn(snapshot, name)) continue;
    const names = params
      .split(",")
      .map((part) => part.split("=", 1)[0])
      .flatMap((part) => part.match(/[a-z][a-z0-9_]*/g) ?? []);
    const current = signatures.get(name) ?? new Set();
    for (const param of names) current.add(param);
    signatures.set(name, current);
  }
  return signatures;
}

describe("help text follows the registered tool surface", () => {
  it("help overview states there is no single-project fallback", () => {
    assert.match(helpOverview(), /resolution order is project_id override, session selection, worker pin/i);
    assert.match(helpOverview(), /worktree or subdirectory resolves to its\s+primary checkout/i);
    assert.match(helpOverview(), /instead of falling back to an unrelated one/i);
    assert.doesNotMatch(helpOverview(), /auto-selects? a single registered project/i);
  });

  it("help signatures match the wire surface", () => {
    const signatures = helpSignatures(helpText);
    const missingTools = Object.keys(snapshot).filter((name) => !new RegExp(`\\b${name}\\b`).test(helpText));
    assert.deepEqual(missingTools, [], `help is missing registered tools: ${missingTools.join(", ")}`);

    const mismatches = [];
    for (const [name, tool] of Object.entries(snapshot)) {
      const params = signatures.get(name) ?? new Set();
      for (const param of params) {
        if (!Object.hasOwn(tool.inputSchema.properties, param)) mismatches.push(`${name} names unknown parameter ${param}`);
      }
      for (const param of tool.inputSchema.required ?? []) {
        if (!params.has(param)) mismatches.push(`${name} omits required parameter ${param}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });
});
