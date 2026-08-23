import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-codex-notify-unreachable-"));
process.env.HIVE_DATA_DIR = join(scratch, "data");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { codexHomeDir, ensureCodexHome } = await import("../dist/codexHome.js");

const fakeAuth = join(scratch, "fake-auth.json");
writeFileSync(fakeAuth, JSON.stringify({ tokens: "not real" }));

const cwd = join(scratch, "repo");
mkdirSync(cwd, { recursive: true });

function writtenHooks(key) {
  ensureCodexHome({ key, actorId: "agent:42", cwd, brief: "hello worker", authSource: fakeAuth });
  return JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8")).hooks;
}

// src/hook.ts's "notify" case is Claude-Code-Notification-only and is proven unreachable for codex
// by this file, not merely unused: hive's own generation code is the sole author of every argv
// string it bakes into a worker's hooks.json (src/hooks.ts's hookEntry), so "unreachable" is a fact
// about THAT file, checkable directly, rather than an observation about what nobody has wired yet.
describe("a codex worker's generated hooks.json never routes an event to the notify argv label", () => {
  it("carries no hookEntry(\"notify\") command anywhere in the file - if a future lane wires one (Notification, or PermissionRequest reusing the notify bucket), this goes red and the choice has to be made deliberately, not fall through unnoticed (todo 525)", () => {
    const hooks = writtenHooks("notify-unreachable-1");
    const commands = Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((h) => h.command)));
    assert.ok(commands.length > 0, "sanity: the fixture must actually wire at least one event");
    assert.equal(
      commands.some((command) => command.endsWith(" notify")),
      false,
      `expected no command ending in " notify", got: ${JSON.stringify(commands)}`,
    );
  });

  it("never wires PermissionRequest at all - blocked-on-human comes from the pane title (C1), not this hook (research pad 229, H5)", () => {
    const hooks = writtenHooks("notify-unreachable-2");
    assert.equal("PermissionRequest" in hooks, false);
  });

  it("never wires Notification at all - codex has no such event (research pad 229, H1/H2)", () => {
    const hooks = writtenHooks("notify-unreachable-3");
    assert.equal("Notification" in hooks, false);
  });
});
