#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function splitSegments(command) {
  return command.split(/[;&|\n]+/);
}

const TMUX_INVOCATION_RE = /(\S*\/)?\btmux\b/;
const KILL_SERVER_RE = /\bkill-server\b/;

const EXPLICIT_S_RE = /(^|[\s'"`])-S/;
const PKILL_KILLALL_RE = /(?<![\w-])(pkill|killall5?)(?![\w-])/;
const PGREP_RE = /(?<![\w-])pgrep(?![\w-])/;
const PIPED_PS_RE = /(?<![\w-])ps(?![\w-])[^\n]*\|/;
const KILL_RE = /(?<![\w-])kill(?![\w-])/;
const KILL_ARGS_RE = /(?:^|[\s(`'"/])kill\s+(.*)$/;

function killsPidMinusOne(segment) {
  const match = KILL_ARGS_RE.exec(segment);
  if (!match) return false;
  const tokens = match[1]
    .split(/\s+/)
    .filter((token) => token !== "" && !/^\d*[<>]/.test(token))
    .map((token) => token.replace(/^["'`(]+|["'`)]+$/g, ""));
  return tokens.slice(1).includes("-1");
}

export function classify(command) {
  if (typeof command !== "string" || command.length === 0) {
    return { deny: false };
  }

  if (PKILL_KILLALL_RE.test(command)) {
    return { deny: true, kind: "pattern-kill", reason: "pkill/killall selects processes by pattern" };
  }
  if (KILL_RE.test(command)) {
    if (PGREP_RE.test(command)) {
      return { deny: true, kind: "pattern-kill", reason: "a kill fed by pgrep selects processes by pattern" };
    }
    if (PIPED_PS_RE.test(command)) {
      return { deny: true, kind: "pattern-kill", reason: "a kill fed by ps selects processes by pattern" };
    }
  }

  for (const segment of splitSegments(command)) {
    if (killsPidMinusOne(segment)) {
      return { deny: true, kind: "pattern-kill", reason: "kill to pid -1 signals every process you own" };
    }

    const tmuxMatch = TMUX_INVOCATION_RE.exec(segment);
    if (!tmuxMatch) continue;

    const invocation = segment.slice(tmuxMatch.index);
    if (KILL_SERVER_RE.test(invocation) && !EXPLICIT_S_RE.test(invocation)) {
      return {
        deny: true,
        kind: "tmux",
        reason: "tmux kill-server without an explicit -S can fall back to the shared socket",
      };
    }
  }

  return { deny: false };
}

const SAFE_FORM = 'tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" kill-server';

const PROSE_ESCAPE =
  "Writing ABOUT this guard (a commit message, a PR title or body) can trip it too --\n" +
  "it reads the whole Bash command string with no way to tell prose from a real\n" +
  "invocation, and is not meant to try. Put the text on disk instead:\n" +
  "  git commit -F <file>\n" +
  "  gh pr create --body-file <path>\n";

function patternKillMessage(reason) {
  return (
    `❌ BLOCKED: ${reason}.\n` +
    "A pattern kill signals every process of yours whose argv contains the text, which\n" +
    "is usually more than you meant. On macOS the pattern tool stops reading options at\n" +
    "the first pattern, so an option typed after it (-P 1) becomes another pattern and\n" +
    'matches everything with a "1" in its argv, hive leads and servers included. kill\n' +
    "to pid -1 signals everything you own.\n" +
    "Kill a process you started by the pid you recorded when you started it:\n" +
    "  your-command & pid=$!\n" +
    '  kill "$pid"\n' +
    PROSE_ESCAPE
  );
}

function denialMessage(result) {
  if (result.kind === "pattern-kill") return patternKillMessage(result.reason);
  return (
    `❌ BLOCKED: ${result.reason}.\n` +
    "TMUX_TMPDIR names a directory tmux must be able to reach, not a pinned server; " +
    "an unreachable one (removed, or never created) falls back to /tmp, the machine's " +
    "shared socket, and a bare kill-server there takes down every hive lead and worker " +
    "on it.\n" +
    "TMUX_TMPDIR will not save you even if the directory exists: you are inside a tmux\n" +
    "pane, and $TMUX overrides TMUX_TMPDIR outright, so the command still reaches the\n" +
    "shared server. Only -S overrides $TMUX.\n" +
    "Use the safe form instead, which has nothing to fall back to:\n" +
    `  ${SAFE_FORM}\n` +
    PROSE_ESCAPE
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const command = input?.tool_input?.command ?? "";

  const result = classify(command);
  if (result.deny) {
    process.stderr.write(denialMessage(result));
    process.exit(2);
  }
  process.exit(0);
}

function isDirectInvocation() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    // realpathSync throws on a path that does not resolve (e.g. argv1 stringified from
    // undefined under `node -e`); a throw here is a module-load crash the hook contract
    // cannot see as a denial, so treat "can't tell" the same as "not the entry point".
    return false;
  }
}

if (isDirectInvocation()) {
  main();
}
