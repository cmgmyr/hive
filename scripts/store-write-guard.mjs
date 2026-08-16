#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cached once: a hook process is one-shot, so os.homedir() cannot change under it.
const HOME = homedir();
const HOME_REF = `(?:~|\\$\\{?HOME\\}?|${escapeRegExp(HOME)})`;
// Requires the .db file itself, not just the .hive directory -- profiles/, backups/,
// briefs/ and postures/ live under .hive too and reading them is not a store write.
const STORE_DB_PATTERN = `${HOME_REF}/\\.hive/\\S*\\.db\\b`;
const DEFAULT_STORE_RE = new RegExp(STORE_DB_PATTERN);
const WRITE_RE =
  /\bUPDATE\s+(?:OR\s+\w+\s+)?\S+\s+SET\b|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bDELETE\s+FROM\b|\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b|\bALTER\s+TABLE\b|\bREPLACE\s+INTO\b|\bCREATE\s+TABLE\b/i;
// Correlated, not a bare `\brm\b` under WRITE_RE: an unscoped "rm" would deny any
// unrelated `rm somefile` sharing a compound command with an unrelated store read.
// This requires rm and the store's own db path in the same clause.
const RM_STORE_RE = new RegExp(`\\brm\\b[^;&|\\n]*?${STORE_DB_PATTERN}`);
// A real "is it quoted" check needs shell parsing this guard doesn't do; anchoring to a
// leading-assignment position breaks the common `export X=1 && cmd` idiom, so this stays
// a loose word-boundary match -- an accidental unblock from a coincidental quoted phrase
// is cheaper than breaking the documented escape hatch.
const ALLOW_ENV_RE = /\bHIVE_ALLOW_DEFAULT_STORE=1\b/;

export function classify(command) {
  if (typeof command !== "string" || command.length === 0) {
    return { deny: false };
  }
  if (ALLOW_ENV_RE.test(command)) return { deny: false };

  // Whole-command, not per-segment: a `;` or `|` CORRELATES a producer with the
  // database consumer (a python one-liner, a piped sqlite3 call) rather than
  // separating unrelated clauses, so segmenting on them re-opened the incident
  // itself. The cost -- a read of the live store on one clause and a write to
  // a different, scratch database on another -- is accepted; see the denial
  // message and the reference doc.
  if (DEFAULT_STORE_RE.test(command) && WRITE_RE.test(command)) {
    return {
      deny: true,
      reason: "a raw SQL mutation against the default hive store's database file bypasses project_id scoping",
    };
  }
  if (RM_STORE_RE.test(command)) {
    return { deny: true, reason: "removing the default hive store's database file destroys the live store" };
  }

  return { deny: false };
}

function denialMessage(reason) {
  return (
    `❌ BLOCKED: ${reason}.\n` +
    "Nothing at the database level requires a WHERE clause to name project_id, and pad, todo\n" +
    "and kv names are unique PER PROJECT, not globally -- `WHERE name='board'` matches every\n" +
    "project's board. This is the exact incident that put hive's board into sideproj's (todo\n" +
    "331): a raw UPDATE with no project_id predicate, run from a Claude Code session in hive's\n" +
    "own checkout, silently overwrote another project's row.\n" +
    "Stamping updated_at yourself does not fix this -- the store's own trigger only catches a\n" +
    "stale row, not a correctly-stamped write that is missing the project_id predicate.\n" +
    "Use the real tool layer instead: pad_write/pad_edit/pad_append, todo_update, kv_set --\n" +
    "they always scope by project_id and stamp updated_at correctly. For a large pad, a read\n" +
    "via `sqlite3 -json` is fine; only a write needs the tool layer.\n" +
    "If this really is a deliberate one-off against the live store (e.g. the runbook's\n" +
    "orphan-actor sweep), set HIVE_ALLOW_DEFAULT_STORE=1 in front of the command.\n" +
    "If the ~/.hive path here is only a READ and the write in this command targets a\n" +
    "different database, split them into two separate Bash calls -- this guard matches\n" +
    "the whole command, not just the clause that touches the store.\n" +
    "Writing ABOUT this guard (a commit message, a PR title or body quoting the SQL) can trip\n" +
    "it too -- it reads the whole Bash command string with no way to tell prose from a real\n" +
    "invocation. Put the text on disk instead:\n" +
    "  git commit -F <file>\n" +
    "  gh pr create --body-file <path>\n"
  );
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    // Denying on a payload shape this guard doesn't recognise would block every
    // Bash call the day Claude Code changes that shape; this is the second line
    // of defence (the trigger is the first), not the only one, so fail open.
    process.exit(0);
  }
  const command = input?.tool_input?.command ?? "";

  const result = classify(command);
  if (result.deny) {
    process.stderr.write(denialMessage(result.reason));
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
