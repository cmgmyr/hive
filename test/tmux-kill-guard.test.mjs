import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

import { classify } from "../scripts/tmux-kill-guard.mjs";

// Todo 417. No store, no tmux, no network -- classify() is pure and the
// wrapper/wiring checks below only spawn the guard script itself or read
// committed JSON, so this file needs none of test/CLAUDE.md's isolation
// machinery (isolateTmux, scratch dirs).

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

// Review round 1 (todo 417 comment 1101), finding 1, BLOCKING: an earlier
// line's own -S used to vouch for a later bare kill-server in the same
// multi-line Bash-tool command, because splitSegments() only split on
// [;&|] and a newline-joined debug block is one string with no such
// character in it. This is the incident's own shape -- the fatal command
// was the LAST line of a block whose earlier lines were already tmux calls.
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

// Review round 1, finding 2, BLOCKING: TMUX_INVOCATION_RE required tmux to
// be preceded by whitespace or a segment boundary, so a quote hid the
// invocation from it entirely -- the exact bypass the original todo
// predicted ("a bare 'denied' earns a retry with `sh -c`").
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

// A quote hiding the INVOCATION must still deny; a quote hiding only the
// -S FLAG must still allow -- the fix is symmetric, not one-directional.
describe("classify: a quoted -S is still recognised as the safe form", () => {
  it('tmux "-S" /tmp/scratch-socket kill-server', () => {
    assert.equal(classify('tmux "-S" /tmp/scratch-socket kill-server').deny, false);
  });
});

// Review round 1, finding 3, SHOULD FIX: EXPLICIT_S_RE used to test the
// whole segment, so an -S belonging to something else entirely -- here, an
// env-var VALUE that happens to spell "-S", sitting before the tmux
// invocation even starts -- vouched for the kill. Scoping the check to the
// tmux invocation's own span (from where "tmux" starts onward) closes this
// without needing a real shell parser.
describe("classify: an -S that does not belong to the tmux invocation does not vouch for it", () => {
  it("sort -S 1G tmux kill-server", () => {
    // A prior command's own -S flag, whitespace-bounded and genuinely
    // matchable by EXPLICIT_S_RE, sitting BEFORE the tmux invocation in the
    // same segment. Scoping the check to the invocation's own span (from
    // where "tmux" starts onward) is what tells these apart; a whole-segment
    // check cannot, because to a whole-segment regex an -S anywhere in the
    // string looks identical regardless of which command it belongs to.
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

// The wrapper is what Claude Code actually invokes. Exercising classify()
// alone would not catch a wrapper that classifies correctly but emits the
// wrong protocol (todo 417 step 1a measured exit-code-2 + stderr as the
// shape this installed Claude Code honours), or that forgets to print the
// safe form the denial message is supposed to lead with.
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

  // Review round 2 (todo 417 comment 1103): measured live that TMUX_TMPDIR
  // cannot protect a worker at all from inside a tmux pane, even when the
  // directory it names exists -- $TMUX overrides it outright. Only -S
  // overrides $TMUX. The denial message used to explain only the
  // directory-fallback failure mode, which reads as "keep the directory
  // alive and you're fine" -- false for every hive worker, which always
  // runs inside a pane.
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

// Pins that the hook stays wired into THIS repo's tracked settings, not
// only that the script itself classifies correctly -- a future edit that
// unwires the hook (renames the matcher, points the command elsewhere,
// deletes the block) would leave classify()'s own tests green while the
// guard stopped firing for real.
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
