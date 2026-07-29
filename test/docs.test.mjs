import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLI, runCli, scratchDirs } from "./helpers.mjs";

// A command nobody can find is not shipped. The list of commands lives in one
// place in the source, so both checks read it from there rather than keeping a
// copy that drifts the first time someone adds a command.
const dirs = scratchDirs();
const REPO = new URL("..", import.meta.url).pathname;
const readRepo = (file) => readFileSync(join(REPO, file), "utf8");

const COMMANDS = (() => {
  const table = /const COMMANDS = \[([\s\S]*?)\];/.exec(readFileSync(CLI, "utf8"));
  assert.ok(table, "COMMANDS table not found in dist/cli.js");
  return [...table[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
})();

describe("docs keep up with the CLI", () => {
  it("lists every command in hive --help", async () => {
    const { stdout } = await runCli(["--help"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    for (const command of COMMANDS) {
      assert.match(stdout, new RegExp(`hive ${command}\\b`), `hive --help omits "${command}"`);
    }
  });

  it("documents every command in the README", () => {
    const readme = readRepo("README.md");
    for (const command of COMMANDS) {
      assert.match(readme, new RegExp(`hive ${command}\\b`), `README omits "${command}"`);
    }
  });

  it("tells a reader to re-pin the interpreter after an update", () => {
    const readme = readRepo("README.md");
    // The Updating section used to promise no reinstall and no
    // re-registration "on any machine". True until npm install rebuilds the
    // addon under a different Node than the one the dispatcher names.
    assert.match(readme, /## Updating[\s\S]*?hive setup\s+# re-pin/);
    assert.doesNotMatch(readme, /no re-registration, on any machine/);
    assert.match(readme, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  });

  it("records why a passing require proves nothing", () => {
    const claudeMd = readRepo("CLAUDE.md");
    assert.match(claudeMd, /ABI-locked to the interpreter that built it/);
    assert.match(claudeMd, /does NOT load it: the binding loads lazily inside `new Database\(\)`/);
    assert.match(claudeMd, /hive setup/);
  });
});
