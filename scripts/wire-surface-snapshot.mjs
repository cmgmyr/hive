#!/usr/bin/env node
// Regenerates test/fixtures/wire-surface/tools-list.snapshot.json from a
// real, built server's tools/list response. Also the ONE place the
// snapshot's serialization is defined - test/wire-surface.test.mjs imports
// sortKeysDeep and renderToolsSnapshot from here rather than keeping its own
// copy. Counselors round 2, item 5: the test's message says "regenerate it
// deliberately" and previously gave no way to do that, so a hand-rolled
// regeneration would have had to reproduce sortKeysDeep + JSON.stringify(_,
// null, 2) + the trailing newline exactly. A near-miss there produces a
// whole-file diff that looks like a real wire-surface change (e.g. lane C's
// zod 4 bump) and is really just the writer disagreeing with the reader.
//
// Usage: node scripts/wire-surface-snapshot.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const SNAPSHOT_PATH = join(REPO, "test/fixtures/wire-surface/tools-list.snapshot.json");

// Deterministic normalisation for the snapshot: sort OBJECT keys at every
// level, so lane C's reviewer gets a diff keyed by property name rather than
// one that reorders every tool because zod 4 changed emission order.
//
// Arrays are deliberately left UNSORTED, and that is a real, accepted
// residual - counselors round 2, item 3 caught an earlier version of this
// comment claiming the file was "stable regardless of declaration order,"
// which is false. `required` is emitted in the tool's zod shape declaration
// order (src/tools/*.ts), so a pure no-op reorder of two fields in one
// tool's inputSchema - a refactor a client cannot observe - fails the test
// that imports this function. That trade is kept anyway: sorting `required`
// would mean sorting arrays generally, and `enum` order (and any future
// positional construct, like a tuple's `prefixItems`) IS genuinely
// client-visible - a model reads `enum` in the order it is presented.
// Keyword-aware sorting (sort `required`, leave `enum` alone) was
// considered and rejected: it is cleverness this lane does not need, and an
// occasional false failure on a `required` reorder is a cheap price next to
// silently losing a real `enum` reorder.
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]));
  }
  return value;
}

// tools/list's `tools` array -> the canonical snapshot object, keyed by
// name (minus `name` itself, redundant with the key). The WHOLE tool
// object, not just inputSchema - counselors round 2, item 4, the biggest
// gap in an earlier version of this lane. tools/list also returns
// description, execution, and (when present) title, annotations, and
// outputSchema; none of that was pinned before, so an SDK bump that changed
// how descriptions or annotations are emitted would have passed untouched.
// description is the more behaviourally load-bearing half of the wire
// surface - it is what steers the model - so an inputSchema-only snapshot
// was checking the less important half.
export function toolsByName(tools) {
  return sortKeysDeep(Object.fromEntries(tools.map(({ name, ...rest }) => [name, rest])));
}

// The exact bytes that belong on disk: pretty-printed, trailing newline.
// test/wire-surface.test.mjs's byte-exact backstop assertion compares
// against exactly this.
export function renderToolsSnapshot(tools) {
  return `${JSON.stringify(toolsByName(tools), null, 2)}\n`;
}

// Spawns the BUILT server (dist/index.js, not src/) over real stdio and
// returns its tools/list result - `npm run build` first is the caller's
// job, the same precondition every other script here has.
function captureLiveTools() {
  const dataDir = mkdtempSync(join(tmpdir(), "hive-wire-snapshot-"));
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(REPO, "dist/index.js")], {
      env: { ...process.env, HIVE_DATA_DIR: dataDir, HIVE_AUTO_ATTACH: "0" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    // Same StringDecoder reason as test/helpers.mjs's McpClient, and it
    // matters MORE here: this is the process that WRITES the fixture, so a
    // multibyte sequence split across two `data` events would be decoded as
    // two U+FFFD halves and committed as the new expected value. No tool
    // description contains non-ASCII today, which makes this latent rather
    // than live - but descriptions are prose, and the day one gains an
    // accented character is not the day to discover this.
    child.stdout.setEncoding("utf8");
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for tools/list from dist/index.js"));
    }, 10_000);
    const finish = (fn) => {
      clearTimeout(timer);
      child.kill();
      rmSync(dataDir, { recursive: true, force: true });
      fn();
    };
    child.on("error", (err) => finish(() => reject(err)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          finish(() => resolve(msg.result.tools));
          return;
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wire-surface-snapshot", version: "0" } },
      })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const tools = await captureLiveTools();
  writeFileSync(SNAPSHOT_PATH, renderToolsSnapshot(tools));
  console.log(`wrote ${SNAPSHOT_PATH} (${tools.length} tools)`);
}
