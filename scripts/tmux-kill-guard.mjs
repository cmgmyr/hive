#!/usr/bin/env node

import { readFileSync } from "node:fs";

function splitSegments(command) {
  return command.split(/[;&|\n]+/);
}

const TMUX_INVOCATION_RE = /(\S*\/)?\btmux\b/;
const KILL_SERVER_RE = /\bkill-server\b/;

const EXPLICIT_S_RE = /(^|[\s'"`])-S/;
const PKILL_KILLALL_RE = /\b(pkill|killall)\b/;
const NAMES_TMUX_RE = /\btmux\b/;

export function classify(command) {
  if (typeof command !== "string" || command.length === 0) {
    return { deny: false };
  }

  for (const segment of splitSegments(command)) {
    if (PKILL_KILLALL_RE.test(segment) && NAMES_TMUX_RE.test(segment)) {
      return { deny: true, reason: "pkill/killall naming tmux is the same catastrophe spelled differently" };
    }

    const tmuxMatch = TMUX_INVOCATION_RE.exec(segment);
    if (!tmuxMatch) continue;

    const invocation = segment.slice(tmuxMatch.index);
    if (KILL_SERVER_RE.test(invocation) && !EXPLICIT_S_RE.test(invocation)) {
      return {
        deny: true,
        reason: "tmux kill-server without an explicit -S can fall back to the shared socket",
      };
    }
  }

  return { deny: false };
}

const SAFE_FORM = 'tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" kill-server';

function denialMessage(reason) {
  return (
    `❌ BLOCKED: ${reason}.\n` +
    "TMUX_TMPDIR names a directory tmux must be able to reach, not a pinned server; " +
    "an unreachable one (removed, or never created) falls back to /tmp, the machine's " +
    "shared socket, and a bare kill-server there takes down every hive lead and worker " +
    "on it.\n" +
    "TMUX_TMPDIR will not save you even if the directory exists: you are inside a tmux\n" +
    "pane, and $TMUX overrides TMUX_TMPDIR outright, so the command still reaches the\n" +
    "shared server. Only -S overrides $TMUX.\n" +
    "Use the safe form instead, which has nothing to fall back to:\n" +
    `  ${SAFE_FORM}\n` +
    "Writing ABOUT this guard (a commit message, a PR title or body) can trip it too --\n" +
    "it reads the whole Bash command string with no way to tell prose from a real\n" +
    "invocation, and is not meant to try. Put the text on disk instead:\n" +
    "  git commit -F <file>\n" +
    "  gh pr create --body-file <path>\n"
  );
}

function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const command = input?.tool_input?.command ?? "";

  const result = classify(command);
  if (result.deny) {
    process.stderr.write(denialMessage(result.reason));
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
