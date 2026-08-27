import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-harness-wrapper-matching-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { harnessFor, resolvedCommandPrefix } = await import("../dist/harnesses.js");

const RESOLVES = [
  // already worked before this fix - kept as a control so a regression here fails loudly
  ["claude", "claude", "bare command, no prefix"],
  ["/opt/homebrew/bin/claude", "claude", "absolute path, no prefix"],
  ["claude --model opus", "claude", "trailing flags, no prefix"],
  ["codex", "codex", "bare command, no prefix"],
  ["/opt/homebrew/bin/codex --sandbox read-only", "codex", "absolute path plus flags"],

  // the todo's six measured cases, claude side
  ["FOO=1 claude", "claude", "single env-var prefix"],
  ["/usr/bin/env claude", "claude", "env wrapper by absolute path"],
  ["nice claude", "claude", "nice wrapper, no flags"],

  // extensions the design checkpoint proposed and the lead ruled on
  ["FOO=1 BAR=2 claude", "claude", "multiple env-var assignments"],
  ["env FOO=1 claude", "claude", "wrapper then assignment - env's own idiom for the child's env"],
  ["nice env claude", "claude", "stacked wrappers"],

  // codex gets the same treatment - same underlying bug, same fix site
  ["FOO=1 codex", "codex", "single env-var prefix, codex"],
  ["nice codex", "codex", "nice wrapper, codex"],
  ["/usr/bin/env codex", "codex", "env wrapper by absolute path, codex"],
];

const STAYS_UNKNOWN = [
  // the required negative control: the wrapper IS the point
  [
    "my-claude-wrapper",
    "a user's own differently-named script - must never resolve just because it launches claude internally",
  ],
  ["my-codex-wrapper", "same negative control, codex side"],

  // an assignment's VALUE containing the harness name must not leak into the match
  ["FOO=claude bar", "the resolved head is `bar`, not the string `claude` that appears as a value"],

  // a wrapper-shaped name that is not in the fixed set
  ["myenv claude", "`myenv` is not `env` - the set is exact names, not a prefix or substring test"],

  // deliberately excluded wrappers - different trust boundary (executing user), not just unconsidered
  ["sudo claude", "sudo changes the executing user; excluded on purpose, not an oversight"],
  ["doas claude", "doas, same reasoning as sudo"],
  ["sudo codex", "same exclusion, codex side"],

  // bare wrapper names with nothing to wrap
  ["env", "no command follows env to resolve to"],
  ["nice", "no command follows nice to resolve to"],

  ["nice -n 10 claude", "the realistic nice invocation - the walk stops at `-n`, not a known wrapper"],
  ["arch -x86_64 claude", "the realistic arch invocation - the walk stops at `-x86_64`"],
  ["env -i claude", "env's -i (clear environment) flag - the walk stops at `-i`"],
  ["time -p claude", "time's -p flag - the walk stops at `-p`"],
  ["nice -n 10 codex", "wrapper-flag gap applies identically to codex - nice"],
  ["arch -x86_64 codex", "wrapper-flag gap applies identically to codex - arch"],
  ["env -i codex", "wrapper-flag gap applies identically to codex - env"],
  ["time -p codex", "wrapper-flag gap applies identically to codex - time"],
];

describe("harnessFor resolves through env-var prefixes and known wrappers (todo 521)", () => {
  for (const [command, expected, why] of RESOLVES) {
    it(`"${command}" resolves to ${expected} - ${why}`, () => {
      assert.equal(harnessFor(command).name, expected);
    });
  }
});

describe("harnessFor still refuses everything outside that fixed, narrow set (todo 521 negative control)", () => {
  for (const [command, why] of STAYS_UNKNOWN) {
    it(`"${command}" stays unknown - ${why}`, () => {
      assert.equal(harnessFor(command).name, "unknown");
    });
  }
});

describe("resolvedCommandPrefix keeps everything through the resolved command token, drops what follows (todo 521, agent_resume)", () => {
  for (const [command, expected] of [
    ["claude", "claude"],
    ["claude --model opus", "claude"],
    ["nice claude", "nice claude"],
    ["nice claude --model opus --name x", "nice claude"],
    ["FOO=1 claude", "FOO=1 claude"],
    ["env FOO=1 claude --resume sess-1", "env FOO=1 claude"],
    ["nice env claude", "nice env claude"],
    ["", ""],
  ]) {
    it(`"${command}" -> "${expected}"`, () => {
      assert.equal(resolvedCommandPrefix(command), expected);
    });
  }
});
