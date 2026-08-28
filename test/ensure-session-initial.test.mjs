import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/tmux.ts"), "utf8");

it("pins ensureSession's required initial argument and explicit bare marker", () => {
  assert.match(source, /export type InitialPane = \{ envFlags: string\[\]; command: string \} \| \{ bare: true \};/);
  assert.match(source, /export function ensureSession\(name: string, cwd: string, initial: InitialPane\): SessionStart/);
});
