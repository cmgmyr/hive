import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CLI, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
const { cleanup: cleanupTmux } = isolateTmux("the docs tests");
after(() => cleanupTmux());

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

  it("names the guards that make test isolation structural, and they exist", () => {
    // CLAUDE.md used to assert "real data stays untouched" as a property when
    // it was a convention, and it was false on the day it mattered. It now
    // names what enforces it instead, which is only worth more than the old
    // sentence for as long as the things it names are real.
    const claudeMd = readRepo("CLAUDE.md");
    assert.match(claudeMd, /Test isolation is enforced, not conventional/);
    assert.match(claudeMd, /The data dir is read at call time/);
    // The exact old claim, not the phrase: the invariant quotes it to say what
    // it replaced, and a check that cannot tell a quotation from a claim is
    // the kind that gets deleted rather than satisfied.
    assert.doesNotMatch(claudeMd, /scratch directories; real data stays untouched/);

    // One definition of "cited", used by both halves below. Building a regex
    // per file to ask whether a literal string appears would let the two
    // halves disagree about what a citation even looks like.
    const cited = new Set([...claudeMd.matchAll(/`((?:src|test)\/[\w.-]+\.(?:ts|mjs))`/g)].map((m) => m[1]));

    // The guards themselves, by name. Losing any of these means the invariant
    // stopped saying where the enforcement lives.
    for (const file of ["src/dataDir.ts", "src/db.ts", "test/helpers.mjs"]) {
      assert.ok(cited.has(file), `CLAUDE.md should name ${file}, cites: ${[...cited].join(", ")}`);
    }
    // And every repo path it cites has to be on disk. Renaming a test file is
    // exactly the change that leaves a doc naming a guard nobody can find,
    // which is how the last claim rotted.
    for (const path of cited) {
      assert.ok(existsSync(join(REPO, path)), `CLAUDE.md cites ${path}, which does not exist`);
    }
  });
});
