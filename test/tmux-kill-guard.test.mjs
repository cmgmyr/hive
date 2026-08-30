import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

import { classify } from "../scripts/tmux-kill-guard.mjs";

const GUARD_SCRIPT = join(REPO, "scripts", "tmux-kill-guard.mjs");

describe("classify: denies a bare tmux kill-server", () => {
  const cases = [
    ["tmux kill-server", "plain form"],
    ["tmux kill-server 2>/dev/null", "with redirection"],
    ["TMUX_TMPDIR=/tmp/scratch tmux kill-server", "with an env prefix, the exact incident shape"],
    ["tmux kill-server; rm -rf /tmp/scratch", "as the first of several segments"],
    ["cd /some/dir && tmux kill-server", "as a later segment"],
    ["/usr/local/bin/tmux kill-server", "invoked by full path"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      const result = classify(command);
      assert.equal(result.deny, true, command);
      assert.match(result.reason, /kill-server/);
    });
  }
});

describe("classify: denies pkill/killall naming tmux", () => {
  const cases = ["pkill tmux", "pkill -f tmux", "killall tmux", "killall -9 tmux"];
  for (const command of cases) {
    it(command, () => {
      const result = classify(command);
      assert.equal(result.deny, true, command);
    });
  }
});

describe("classify: allows the safe -S form", () => {
  const cases = [
    'tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" kill-server',
    "tmux -S /tmp/scratch-socket kill-server",
    "tmux kill-server -S /tmp/scratch-socket",
    "tmux -Sfoo kill-server",
  ];
  for (const command of cases) {
    it(command, () => {
      assert.equal(classify(command).deny, false, command);
    });
  }
});

describe("classify: allows ordinary tmux commands", () => {
  const cases = [
    "tmux new-session -d -s scratch",
    "tmux list-panes -s -t =scratch",
    "tmux send-keys -t %3 'echo hi' Enter",
    "tmux kill-session -t scratch",
    "tmux kill-pane -t %3",
  ];
  for (const command of cases) {
    it(command, () => {
      assert.equal(classify(command).deny, false, command);
    });
  }
});

describe("classify: allows commands with no tmux in them", () => {
  const cases = ["echo hello", "ls -la", "git status", "npm test", "pkill -f some-other-process"];
  for (const command of cases) {
    it(command, () => {
      assert.equal(classify(command).deny, false, command);
    });
  }
});

describe("classify: a multi-line block does not let an earlier -S vouch for a later bare kill-server", () => {
  const cases = [
    ["tmux -S /tmp/scratch/sock new-session -d\ntmux kill-server", "review's own verbatim repro"],
    [
      'export TMUX_TMPDIR=/tmp/dbg\ntmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" list-sessions\ntmux kill-server\nrm -rf "$TMUX_TMPDIR"',
      "the incident's own four-line shape: setup, a safe -S call, the bare kill, cleanup",
    ],
    ["grep -S foo bar.txt\ntmux kill-server", "an unrelated -S on an earlier, unrelated line"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      const result = classify(command);
      assert.equal(result.deny, true, command);
    });
  }
});

describe("classify: a quote does not hide the invocation from the guard", () => {
  const cases = [
    ['sh -c "tmux kill-server"', "double-quoted, the bypass the todo predicted"],
    ["sh -c 'tmux kill-server'", "single-quoted"],
    ['bash -c "tmux kill-server"', "bash -c, not just sh -c"],
  ];
  for (const [command, why] of cases) {
    it(why, () => {
      const result = classify(command);
      assert.equal(result.deny, true, command);
    });
  }
});

describe("classify: a quoted -S is still recognised as the safe form", () => {
  it('tmux "-S" /tmp/scratch-socket kill-server', () => {
    assert.equal(classify('tmux "-S" /tmp/scratch-socket kill-server').deny, false);
  });
});

describe("classify: an -S that does not belong to the tmux invocation does not vouch for it", () => {
  it("sort -S 1G tmux kill-server", () => {

    assert.equal(classify("sort -S 1G tmux kill-server").deny, true);
  });
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
  it("bare kill-server", () => {
    const result = runGuard("tmux kill-server");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /BLOCKED/);
  });

  it("denial message names the safe -S form verbatim", () => {
    const result = runGuard("tmux kill-server");
    assert.match(result.stderr, /tmux -S "\$TMUX_TMPDIR\/tmux-\$\(id -u\)\/default" kill-server/);
  });

  it("denial message names the prose escape, not a fix to tell prose from a real command", () => {
    const result = runGuard("tmux kill-server");
    assert.match(result.stderr, /git commit -F <file>/);
    assert.match(result.stderr, /gh pr create --body-file <path>/);
  });

  it("denial message says TMUX_TMPDIR cannot save you from inside a pane, and names $TMUX by name", () => {
    const result = runGuard("tmux kill-server");
    assert.match(result.stderr, /\$TMUX/);
    assert.match(result.stderr, /even if the directory exists/);
  });

  it("a multi-line block reaching the guard via the real stdin wrapper, not just classify() directly", () => {
    const result = runGuard("tmux -S /tmp/scratch/sock new-session -d\ntmux kill-server");
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  });

  it("sh -c wrapping reaching the guard via the real stdin wrapper", () => {
    const result = runGuard('sh -c "tmux kill-server"');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  });
});

describe("wrapper: allows via exit 0 and no output", () => {
  it("the safe -S form", () => {
    const result = runGuard('tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" kill-server');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  it("an ordinary command", () => {
    const result = runGuard("echo hello");
    assert.equal(result.status, 0);
  });
});

function runGuardRaw(rawInput) {
  try {
    const stdout = execFileSync("node", [GUARD_SCRIPT], { input: rawInput, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("wrapper: fails open on malformed stdin rather than crashing", () => {
  it("exits 0 on stdin that is not valid JSON", () => {
    const result = runGuardRaw("not json at all");
    assert.equal(result.status, 0);
  });

  it("exits 0 on empty stdin", () => {
    const result = runGuardRaw("");
    assert.equal(result.status, 0);
  });
});

function runGuardViaSymlink(command) {
  const dir = mkdtempSync(join(tmpdir(), "hive-tmux-guard-symlink-"));
  const link = join(dir, "tmux-kill-guard.mjs");
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
  it("still denies a bare kill-server when node is invoked through a symlink to the guard", () => {
    const result = runGuardViaSymlink("tmux kill-server");
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

describe("settings.json wires the guard for Bash", () => {
  const settings = JSON.parse(readFileSync(join(REPO, ".claude", "settings.json"), "utf8"));

  it("registers a PreToolUse hook matching Bash", () => {
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    const bashEntry = preToolUse.find((entry) => entry.matcher === "Bash");
    assert.ok(bashEntry, "no PreToolUse entry matches Bash");
  });

  it("points at the tracked guard script", () => {
    const preToolUse = settings.hooks.PreToolUse;
    const bashEntry = preToolUse.find((entry) => entry.matcher === "Bash");
    const commands = bashEntry.hooks.map((h) => h.command);
    assert.ok(
      commands.some((c) => c.includes("scripts/tmux-kill-guard.mjs")),
      `no Bash PreToolUse command references scripts/tmux-kill-guard.mjs, saw: ${commands.join(", ")}`,
    );
  });
});
