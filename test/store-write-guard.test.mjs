import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO, scratchDirs } from "./helpers.mjs";

import { classify } from "../scripts/store-write-guard.mjs";

const GUARD_SCRIPT = join(REPO, "scripts", "store-write-guard.mjs");
const HOME = homedir();

const INCIDENT_SQL = "UPDATE scratchpads SET content=?, revision=revision+1 WHERE name='board'";
const INCIDENT_SQL_WITH_STAMP =
  "UPDATE scratchpads SET content=?, revision=revision+1, updated_at=datetime('now') WHERE name='board'";

describe("classify: denies the incident statement against the default store", () => {
  const cases = [
    [
      `python3 - <<'EOF'\nimport sqlite3, os\nconn = sqlite3.connect(os.path.expanduser("~/.hive/hive.db"))\nconn.execute("${INCIDENT_SQL}", (content,))\nconn.commit()\nEOF`,
      "python3 heredoc, path and statement on separate lines like the real incident",
    ],
    [`sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`, "bare sqlite3 call"],
    [`sqlite3 "$HOME/.hive/hive.db" "${INCIDENT_SQL}"`, "$HOME spelling"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      const result = classify(command);
      assert.equal(result.deny, true, command);
      assert.match(result.reason, /project_id/);
    });
  }
});

describe("classify: denies the incident correlated across a real command separator, review round 2 finding 1", () => {
  const cases = [
    [
      `python3 -c "import sqlite3; c=sqlite3.connect('${HOME}/.hive/hive.db'); c.execute('${INCIDENT_SQL}')"`,
      "python3 one-liner, semicolon-joined inside one shell argument -- segmenting on ; broke this",
    ],
    [
      `python3 -c "import sqlite3, os; c=sqlite3.connect(os.path.expanduser('~/.hive/hive.db')); c.execute('${INCIDENT_SQL}')"`,
      "the same shape with the ~ spelling",
    ],
    [`echo "${INCIDENT_SQL}" | sqlite3 ~/.hive/hive.db`, "piped into sqlite3 -- segmenting on | broke this"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, true, command);
    });
  }
});

describe("classify: denies this repo's own INSERT OR IGNORE idiom and other SQL shapes WRITE_RE missed, review round 2 finding 3", () => {
  const cases = [
    ['sqlite3 ~/.hive/hive.db "INSERT OR IGNORE INTO scratchpads (id) VALUES (1)"', "INSERT OR IGNORE INTO, used nine times in src/"],
    ['sqlite3 ~/.hive/hive.db "UPDATE OR REPLACE scratchpads SET content=1"', "UPDATE OR REPLACE"],
    ['sqlite3 ~/.hive/hive.db "CREATE TABLE evil (id)"', "CREATE TABLE"],
    ['sqlite3 ~/.hive/hive.db "DROP VIEW some_view"', "DROP VIEW"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, true, command);
    });
  }
});

describe("classify: denies rm of the store's database file, review round 2 finding 3", () => {
  const cases = [
    ["rm ~/.hive/hive.db", "bare rm"],
    ["rm -f ~/.hive/hive.db", "rm -f"],
    [`rm -f "${HOME}/.hive/hive.db"`, "literal homedir, quoted"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, true, command);
    });
  }
});

describe("classify: rm-of-store detection is correlated, not a bare rm keyword", () => {
  it("an unrelated rm of a scratch file alongside an unrelated default-store read is allowed", () => {
    const command = 'sqlite3 -json ~/.hive/hive.db "SELECT * FROM scratchpads" && rm /tmp/scratch/leftover.db';
    assert.equal(classify(command).deny, false, command);
  });
  it("rm of a scratch store's own db file is allowed", () => {
    const { dataDir } = scratchDirs();
    assert.equal(classify(`rm ${join(dataDir, "hive.db")}`).deny, false);
  });
});

describe("classify: denies the trigger's own bypass, stamping updated_at does not save you", () => {
  const cases = [
    [`sqlite3 ~/.hive/hive.db "${INCIDENT_SQL_WITH_STAMP}"`, "bare sqlite3 call"],
    [
      `python3 - <<'EOF'\nimport sqlite3, os\nconn = sqlite3.connect(os.path.expanduser("~/.hive/hive.db"))\nconn.execute("${INCIDENT_SQL_WITH_STAMP}", (content,))\nconn.commit()\nEOF`,
      "python3 heredoc",
    ],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, true, command);
    });
  }
});

describe("classify: allows reads against the default store", () => {
  const cases = [
    ['sqlite3 ~/.hive/hive.db "SELECT * FROM scratchpads WHERE name=\'board\'"', "bare SELECT"],
    ["sqlite3 -json ~/.hive/hive.db \"SELECT id, name FROM scratchpads\"", "sqlite3 -json read, the board's own recommended form"],
    ["ls -la ~/.hive", "no SQL at all"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, false, command);
    });
  }
});

describe("classify: allows routine reads under ~/.hive that are not the database file, review round 1", () => {
  const cases = [
    ['grep -rn "update" ~/.hive/profiles/orchestration/runbook.md', "grepping prose containing the word update"],
    ["cat ~/.hive/profiles/orchestration/worker.md | grep -i delete", "grepping prose containing the word delete"],
    ["ls ~/.hive/backups && npm update", "an unrelated npm update alongside a directory listing"],
    [
      "hive pad lessons > /tmp/x && grep -c INSERT ~/.hive/profiles/orchestration/runbook.md",
      "bare INSERT with no INTO, in a doc, in a separate segment",
    ],
    [
      "cat ~/.hive/profiles/orchestration/worker.md",
      "a profile-directory read with no write keyword and no .db suffix at all",
    ],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, false, command);
    });
  }
});

describe("classify: allows a write against a real scratch store", () => {
  it("scratchDirs()-shaped data dir, the same shape the suite uses", () => {
    const { dataDir } = scratchDirs();
    const scratchDb = join(dataDir, "hive.db");
    const command = `sqlite3 ${scratchDb} "${INCIDENT_SQL}"`;
    assert.equal(classify(command).deny, false, command);
  });

  it("a scratch HIVE_DATA_DIR under /tmp, no default-store spelling present", () => {
    const command = 'sqlite3 /tmp/hive-test-abc123/data/hive.db "UPDATE scratchpads SET content=? WHERE id=1"';
    assert.equal(classify(command).deny, false, command);
  });
});

describe("classify: HIVE_ALLOW_DEFAULT_STORE=1 is the documented escape hatch", () => {
  it("prefixed on the incident statement", () => {
    const command = `HIVE_ALLOW_DEFAULT_STORE=1 sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`;
    assert.equal(classify(command).deny, false, command);
  });

  it("export form", () => {
    const command = `export HIVE_ALLOW_DEFAULT_STORE=1\nsqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`;
    assert.equal(classify(command).deny, false, command);
  });

  it("known limit: a coincidentally assignment-shaped phrase inside quoted prose also escapes, accepted rather than parsing quotes", () => {
    const command = `echo "note: setting HIVE_ALLOW_DEFAULT_STORE=1 is not the same as doing it" && sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`;
    assert.equal(classify(command).deny, false, command);
  });

  it("known limit: an env prefix on one clause unblocks an unrelated raw mutation in another, review round 2 finding 6", () => {
    const command = `HIVE_ALLOW_DEFAULT_STORE=1 node one-off.mjs && sqlite3 ~/.hive/hive.db "DELETE FROM scratchpads"`;
    assert.equal(classify(command).deny, false, command);
  });
});

describe("classify: known limit, dropping segmentation denies an unrelated pair sharing one command, review round 2 finding 5", () => {
  it("a live-store READ on one clause and a scratch-store WRITE on another are denied together", () => {
    const command = `sqlite3 ~/.hive/hive.db "SELECT * FROM scratchpads" && sqlite3 /tmp/scratch/hive.db "${INCIDENT_SQL}"`;
    assert.equal(classify(command).deny, true, command);
  });
});

describe("classify: prose mentioning the store with no mutation is allowed", () => {
  const cases = [
    ["echo 'the default store lives at ~/.hive/hive.db'", "no SQL keyword at all"],
    ["cat docs/patterns.md | grep '.hive'", "grepping for the store path in a doc"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      assert.equal(classify(command).deny, false, command);
    });
  }
});

describe("classify: edge inputs", () => {
  it("empty command does not deny", () => {
    assert.equal(classify("").deny, false);
  });
  it("missing command does not throw", () => {
    assert.equal(classify(undefined).deny, false);
  });
});

function runGuard(command) {
  try {
    const stdout = execFileSync("node", [GUARD_SCRIPT], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("wrapper: denies via exit code 2 + stderr, never stdout", () => {
  it("the incident statement", () => {
    const result = runGuard(`sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /BLOCKED/);
  });

  it("denial message names the escape hatch verbatim", () => {
    const result = runGuard(`sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`);
    assert.match(result.stderr, /HIVE_ALLOW_DEFAULT_STORE=1/);
  });

  it("denial message names the prose escape for writing about the guard", () => {
    const result = runGuard(`sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`);
    assert.match(result.stderr, /git commit -F <file>/);
    assert.match(result.stderr, /gh pr create --body-file <path>/);
  });
});

describe("wrapper: allows via exit 0 and no output", () => {
  it("a read against the default store", () => {
    const result = runGuard('sqlite3 ~/.hive/hive.db "SELECT * FROM scratchpads"');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("an ordinary command", () => {
    const result = runGuard("echo hello");
    assert.equal(result.status, 0);
  });
});

function runGuardRaw(stdin) {
  try {
    const stdout = execFileSync("node", [GUARD_SCRIPT], { input: stdin, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("wrapper: malformed stdin fails open deliberately rather than via an uncaught crash, review round 2 finding 4", () => {
  it("empty stdin exits 0, not the exit-1 an uncaught JSON.parse throw would produce", () => {
    assert.equal(runGuardRaw("").status, 0);
  });
  it("non-JSON stdin exits 0", () => {
    assert.equal(runGuardRaw("not json at all").status, 0);
  });
});

function runGuardViaSymlink(command) {
  const dir = mkdtempSync(join(tmpdir(), "hive-store-guard-symlink-"));
  const link = join(dir, "store-write-guard.mjs");
  symlinkSync(GUARD_SCRIPT, link);
  try {
    const stdout = execFileSync("node", [link], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("wrapper: entry-point detection survives a symlinked invocation path, review round 2 finding 2", () => {
  it("still denies the incident statement when node is invoked through a symlink to the guard", () => {
    const result = runGuardViaSymlink(`sqlite3 ~/.hive/hive.db "${INCIDENT_SQL}"`);
    assert.equal(result.status, 2, "a symlinked invocation must not fail open");
    assert.match(result.stderr, /BLOCKED/);
  });
});

describe("module load: does not throw when process.argv[1] is unusable, review round 3", () => {
  it("importing the module the way `node -e` does (no real argv[1]) succeeds and exports classify", () => {
    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(GUARD_SCRIPT)}).then(m => console.log(typeof m.classify)).catch(e => { console.error(e.message); process.exit(1); })`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.trim(), "function");
  });
});

describe("settings.json wires the guard for Bash, alongside the tmux guard", () => {
  const settings = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8"));
  const preToolUse = settings.hooks?.PreToolUse ?? [];
  const bashEntries = preToolUse.filter((entry) => entry.matcher === "Bash");

  it("does not add a second Bash matcher block", () => {
    assert.equal(bashEntries.length, 1, "expected exactly one PreToolUse entry matching Bash");
  });

  it("the single Bash matcher's hooks array carries both guards", () => {
    const commands = bashEntries[0].hooks.map((h) => h.command);
    assert.ok(
      commands.some((c) => c.includes("scripts/tmux-kill-guard.mjs")),
      `no Bash PreToolUse command references scripts/tmux-kill-guard.mjs, saw: ${commands.join(", ")}`,
    );
    assert.ok(
      commands.some((c) => c.includes("scripts/store-write-guard.mjs")),
      `no Bash PreToolUse command references scripts/store-write-guard.mjs, saw: ${commands.join(", ")}`,
    );
  });
});
