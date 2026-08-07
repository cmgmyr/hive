// SessionStart entry point for the plugin.
//
// Why this file exists instead of pointing the hook straight at
// "${CLAUDE_PLUGIN_ROOT}/../dist/kickoff.js": ${CLAUDE_PLUGIN_ROOT} is the
// path the plugin was FOUND at, which for the documented install is the
// symlink ~/.claude/skills/hive, not the checkout. node normalizes ".."
// lexically before it touches the filesystem, so that path collapses to
// ~/.claude/skills/dist/kickoff.js and fails with MODULE_NOT_FOUND. (The
// kernel would have resolved it; node does not ask it to. Verified against
// Claude Code 2.1.220 and node 24.)
//
// A path with no ".." in it has nothing to collapse, so the symlink resolves
// normally, and node realpaths the main entry -- which puts import.meta.url
// on the real file inside the checkout and makes this relative import land in
// the real dist/. That keeps the live-pointer property: git pull && npm run
// build upgrades the hook with everything else, and no absolute path is ever
// written into a committed file.
//
// hooks.json registers this file under a bare `node`, which a version manager
// resolves from the working directory -- the directory the session is
// starting in, not the one hive was built in. So before importing
// dist/kickoff.js, which imports dist/db.js, which calls guardAbi() and
// process.exit(1)s on a mismatch from inside an import nothing downstream can
// catch, check whether THIS interpreter can actually load the addon; if it
// cannot, read the interpreter `hive setup` already pinned for this checkout
// and re-exec under it. abi.js and dispatcher.js are both deliberately
// store-free (see their own headers), so this cannot itself trip the ABI guard.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function reexecUnderPinnedInterpreter() {
  // Set only by the re-exec below, on the child. Without this a pinned
  // interpreter that also cannot load the addon would re-exec into itself
  // forever, hanging every session start -- worse than the bug it fixes.
  if (process.env.HIVE_KICKOFF_REEXEC) return;
  // This hook fires in every directory on the machine on every session
  // start, and the ABI risk above can only ever be reached once dist/kickoff.js
  // has cleared its own worker-session and hive.yml gates (see its header: "the
  // cheap file and git checks come first"). Mirror the cheapest of those two
  // here, so a directory with no hive.yml pays for neither a dispatcher import
  // nor a file read.
  //
  // The condition has to match dist/kickoff.js's gate EXACTLY, not merely
  // approximate it. This read `HIVE_AGENT_ID` alone until issue #27 gave the
  // lead an agents row of its own: HIVE_AGENT_ID is set for a lead too now,
  // and only HIVE_LEAD tells the two apart. The gate over there was updated
  // and this mirror was not, so every lead session skipped the ABI check
  // entirely and fell through to dist/kickoff.js -- which correctly does NOT
  // bail for a lead, and reached dist/db.js under whatever bare `node` the
  // directory resolved. On a one-Node machine that is harmless, which is why
  // it went unseen; on a machine running a Node per repo the lead lost its
  // whole session-start digest to an ABI mismatch the re-exec exists to fix.
  //
  // Skipping the guard is only ever safe when the session would ALSO have
  // been declined downstream. Anything this returns early for must be
  // something dist/kickoff.js refuses too, or the re-exec is being skipped
  // for a session that goes on to open the store.
  if (process.env.HIVE_AGENT_ID && process.env.HIVE_LEAD !== "1") return;
  if (!existsSync(join(process.cwd(), "hive.yml"))) return;

  // Re-exec is a fix for AN ADDON THIS INTERPRETER CANNOT LOAD, not for a path
  // difference: this interpreter may already be able to load the addon fine
  // even if it is not the one the dispatcher happens to name (a rebuild that
  // has not been re-pinned yet, for instance). checkAbi() really dlopens the
  // addon rather than trusting a require(), same reasoning as
  // .claude/rules/native-addon.md.
  //
  // "ABI mismatch" is what this said before issue #105 lane B, and it named a
  // case that is now unreachable for the shipped package. What actually
  // reaches this line is checkAbi()'s "napi" branch - a Node below
  // better-sqlite3's Node-API floor - and that is the case a different
  // interpreter is exactly the cure for, so the guard is more load-bearing
  // than the old wording implied rather than less. "missing" reaches it too
  // and a re-exec cannot cure that; it is not special-cased, because the
  // child prints the same diagnostic this process would have and the cost of
  // finding that out is one spawn at session start.
  // When it IS ok, this returns and dist/kickoff.js goes on to run in this
  // same process; if it later reaches db.js, that require() hits the cache
  // entry checkAbi() just created, so this costs nothing extra there.
  const { checkAbi } = await import("../dist/abi.js");
  if (checkAbi().ok) return;

  const { dispatcherPath, readDispatcher } = await import("../dist/dispatcher.js");
  const dispatcher = readDispatcher(dispatcherPath());
  // mine: false always carries node: null already (readDispatcher's own
  // contract), so reading .node directly matches how abi.ts's
  // workingInterpreterFromDispatcher reads this same struct.
  const node = dispatcher?.node ?? null;
  // No dispatcher (`hive setup` never run), or a dispatcher written by
  // another version with no exec line this one recognizes: nothing to re-exec
  // under, so fall through to the current interpreter unchanged.
  if (!node) return;
  // Already running under it, or the pinned interpreter no longer exists on
  // disk (a version manager removed it): nothing to gain from re-execing.
  if (node === process.execPath || !existsSync(node)) return;

  const result = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HIVE_KICKOFF_REEXEC: "1" },
  });
  // spawnSync itself failed (e.g. the file exists but is not executable):
  // fall through rather than crash a session start over it.
  if (result.error) return;
  process.exit(result.status ?? 1);
}

try {
  await reexecUnderPinnedInterpreter();
} catch {
  // process.cwd() throws if the working directory was deleted before this
  // hook ran; that used to be caught inside runKickoff's own try/catch
  // (evaluate(process.cwd()) is called from inside it) and produce the
  // required silence. This function now calls process.cwd() first, outside
  // that try/catch, so the same throw would otherwise escape as a stack
  // trace and a nonzero exit at session start -- silence is the contract
  // this hook exists under (see dist/kickoff.js's own header), so fall
  // through to runKickoff() the same as any other re-exec decision this
  // function declines to make.
}

const { runKickoff } = await import("../dist/kickoff.js");
await runKickoff(process.argv.slice(2));
