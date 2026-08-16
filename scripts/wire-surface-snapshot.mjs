#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const SNAPSHOT_PATH = join(REPO, "test/fixtures/wire-surface/tools-list.snapshot.json");

export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeysDeep(value[k])]));
  }
  return value;
}

export function toolsByName(tools) {
  return sortKeysDeep(Object.fromEntries(tools.map(({ name, ...rest }) => [name, rest])));
}

export function renderToolsSnapshot(tools) {
  return `${JSON.stringify(toolsByName(tools), null, 2)}\n`;
}

function captureLiveTools() {
  const dataDir = mkdtempSync(join(tmpdir(), "hive-wire-snapshot-"));
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(REPO, "dist/index.js")], {
      env: { ...process.env, HIVE_DATA_DIR: dataDir, HIVE_AUTO_ATTACH: "0" },
      stdio: ["pipe", "pipe", "inherit"],
    });

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
