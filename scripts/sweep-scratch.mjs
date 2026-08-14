#!/usr/bin/env node
// Todo 402. A dev-only sweep for what a full-suite run leaves behind on the
// machine that ran it: orphaned login shells still holding ptys, and old
// scratch tmux servers `hive doctor` already names but deliberately does not
// reap (test/CLAUDE.md, todo 375). NOT a CLI verb, NOT a doctor flag, NOT
// shipped - a script for people developing hive, because only they run the
// suite that causes this. The full spec and the manual sweep it replaces are
// on todo 402; this file implements it, it does not re-argue it.
//
// DRY RUN BY DEFAULT. `--kill` is required to touch anything. Read every
// comment below before changing what gets reaped or how - two dead-ends
// already paid for the two rules that matter most:
//   .claude/sessions/dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-pid.md
//   .claude/sessions/dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md
//
// dist/ imports are deferred into main() rather than hoisted, matching
// test/CLAUDE.md's "keep dist/ imports inside functions" - this script opens
// no store and sets no HIVE_DATA_DIR, but a top-level import would still run
// ahead of --help, which must work with no build present at all.
//
// A NOTE ON THIS FILE'S OWN SAFETY SHAPE, not a testing detail: this
// script's SAFE configuration (a realistic age floor) is the INCONVENIENT
// one to test against, because it makes the candidate list empty for
// anything a test just spawned, and an empty candidate list is an empty
// test. Its DANGEROUS configuration - a floor low enough to catch a fresh
// fixture - is the convenient one, and reaching for it while testing is the
// same mistake this script exists to prevent a human from making on a real
// machine, just moved into the test suite. It happened once while building
// this file (--age-hours=0 against the real shell population) and was one
// step from happening a second time while testing the guard below against
// it. `SWEEP_PS_ROWS_JSON` (liveShellRows) and `SWEEP_SUITE_LOCK_PATH`
// (liveSuiteLockHolder) exist so a test can stay at a realistic floor and
// still have something real to find: close the candidate set to exactly
// what the test owns instead of lowering the floor to catch it. Keep this
// shape for anything added later - if a new safe default is inconvenient to
// test honestly, that is the sign a seam is missing, not that the floor
// should move.
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

import { isAlive as suiteLockHolderAlive, readHolder as readSuiteLockHolder, resolveLockPath } from "./suite-lock.mjs";

const HELP = `Usage: node scripts/sweep-scratch.mjs [--kill] [--age-hours=N] [--budget-ms=N]

Reaps two populations a full \`npm test\` run leaves behind:
  1. orphaned login shells holding ptys (ppid 1, a real pty, older than the age floor)
  2. old scratch tmux servers (hive-tmux-* sockets under the temp dir, live server excluded)

Dry run by default: prints what it would kill and exits. Pass --kill to act.

  --kill            actually reap what is found (default: report only)
  --age-hours=N     age floor in hours (default: 12)
  --budget-ms=N     time budget for probing scratch tmux sockets (default: 30000)
  --help            print this and exit
`;

// A JUDGEMENT, argued rather than inherited from the manual sweep that used
// it. This tool is destructive and runs on a machine that routinely carries
// several concurrent lanes plus a lead, each doing its own scoped runs,
// rebases and doctor calls over the course of a normal session - unlike
// doctor's own 1h floor (ORPHAN_MIN_AGE_MS, src/tmux.ts), which only has to
// outlive one ~3-minute suite run, this floor has to outlive a whole work
// session so a sibling's still-relevant debris is never mistaken for garbage.
// 12h comfortably clears an ordinary session while staying far short of the
// multi-day-old debris this script exists to remove (10.4h and 62.2h orphans
// observed the night this was specified, oldest from two days prior).
const DEFAULT_AGE_HOURS = 12;
const DEFAULT_BUDGET_MS = 30_000;

// How long to wait for SIGTERM to land before escalating, per candidate.
// Short: everything observed the night this was specified died on TERM
// within a couple of poll intervals, and a wedge that needs KILL is the
// interesting case worth reporting, not one worth waiting out at length.
const TERM_GRACE_MS = 2000;
const TERM_POLL_MS = 100;

function parseArgs(argv) {
  const opts = { kill: false, ageHours: DEFAULT_AGE_HOURS, budgetMs: DEFAULT_BUDGET_MS, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--kill") opts.kill = true;
    else if (arg.startsWith("--age-hours=")) opts.ageHours = Number(arg.slice("--age-hours=".length));
    else if (arg.startsWith("--budget-ms=")) opts.budgetMs = Number(arg.slice("--budget-ms=".length));
    else throw new Error(`unrecognised argument: ${arg} (--help for usage)`);
  }
  if (!Number.isFinite(opts.ageHours) || opts.ageHours < 0) throw new Error("--age-hours must be a non-negative number");
  if (!Number.isFinite(opts.budgetMs) || opts.budgetMs < 0) throw new Error("--budget-ms must be a non-negative number");
  return opts;
}

// ---------------------------------------------------------------------------
// Population 1: orphaned login shells holding ptys.
// ---------------------------------------------------------------------------

// pid + ppid + etime + tty + comm, in that order. `comm`/`args` is last and
// unanchored (it can contain spaces) - the same shape src/ptys.ts's own
// PS_LINE regex uses, one field wider.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

// Exported for the enumeration test: given ps(1) text, which rows does this
// parse - the fixture-testable half, per test/CLAUDE.md ("a test asserting a
// number read off the box it runs on cannot fail").
export function parsePsRows(output) {
  const rows = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], tty: m[4], comm: m[5] });
  }
  return rows;
}

// ps(1)'s etime: `SS`, `MM:SS`, `HH:MM:SS`, or `D-HH:MM:SS`. Exported for the
// same fixture-testable reason as parsePsRows.
export function parseEtimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime) ?? /^(\d+)$/.exec(etime);
  if (!m) return null;
  if (m.length === 2) return Number(m[1]); // bare seconds
  const [, days, hours, minutes, seconds] = m;
  return (
    (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

function liveShellRows() {
  // SWEEP_PS_ROWS_JSON - see the file header for what this is really for.
  if (process.env.SWEEP_PS_ROWS_JSON) return JSON.parse(process.env.SWEEP_PS_ROWS_JSON);

  // `comm=` on darwin, `args=` on linux - src/ptys.ts's isOrphanLoginShell
  // comment explains why: linux's `comm=` cannot carry a login shell's
  // leading dash, only `args=` (reconstructed from argv[0]) can.
  const field = platform() === "linux" ? "args" : "comm";
  const out = execFileSync("ps", ["-eo", `pid=,ppid=,etime=,tty=,${field}=`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parsePsRows(out);
}

// Reuses isOrphanLoginShell (src/ptys.ts) rather than a second copy of the
// ppid/dash predicate - one source of truth for what counts as orphaned,
// shared with `hive doctor`'s own count. The tty filter is this script's own
// addition on top, narrower than upstream and never wider: "holding a pty"
// is part of todo 402's own definition of the population, and excluding a
// non-pty row can only shrink the candidate set, never grow it.
export function findOrphanShells(rows, ageFloorMs, isOrphanLoginShell) {
  return rows
    .filter((r) => r.tty !== "??" && r.tty !== "?")
    .filter((r) => isOrphanLoginShell({ ppid: r.ppid, comm: r.comm }))
    .map((r) => ({ ...r, ageMs: (parseEtimeSeconds(r.etime) ?? 0) * 1000 }))
    .filter((r) => r.ageMs >= ageFloorMs);
}

// SIGTERM first, always. Escalates to SIGKILL only if the process is still
// alive after the grace window, and says so - a script that reaches for -9
// by default hides the case where something was genuinely stuck (todo 402's
// own point: all 396 died on TERM the night this was specified).
export async function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if (e?.code === "ESRCH") return { escalated: false, alive: false }; // already gone
    throw e;
  }
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return { escalated: false, alive: false };
    await new Promise((r) => setTimeout(r, TERM_POLL_MS));
  }
  if (!isAlive(pid)) return { escalated: false, alive: false };
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if (e?.code !== "ESRCH") throw e;
  }
  await new Promise((r) => setTimeout(r, TERM_POLL_MS));
  return { escalated: true, alive: isAlive(pid) };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Population 2: old scratch tmux servers.
// ---------------------------------------------------------------------------

// THE GUARD A FULL SUITE RUN DEPENDS ON. orphanScratchServers() excludes only
// THIS process's own live socket (tmuxSocketPath against its own env) - it
// has no way to know about a SIBLING process's scratch socket, so another
// lane's full suite, mid-run, looks exactly like debris from here. Measured
// live: a dry run at --age-hours=0 against a real concurrently-running suite
// offered up that suite's own live scratch socket and eleven of its own
// freshly orphaned shells. At the 12h default this cannot happen, but the
// age floor is the ONLY thing standing between this script and a running
// suite, and the age floor is exactly the knob someone lowers when a machine
// is out of ptys - which is the moment a live suite is most likely to be the
// thing consuming them. todo 401's suite lock (scripts/suite-lock.mjs)
// already names a live holder for this exact reason; reusing it here rather
// than re-deriving "is a suite running" independently.
//
// SCOPED TO SERVERS, NOT SHELLS, on purpose. A server this population would
// reap is either live (an in-progress suite file's own socket, if it is the
// lock holder's) or wedged (already unreachable) - reaping a LIVE one is the
// direct hit the finding above describes. An orphaned shell (ppid 1) has
// already lost the tmux server that would have delivered anything to it;
// nothing a running suite still depends on is listening through it, so
// killing one mid-run costs nothing a live suite could notice. If that
// argument turns out wrong for some shell shape, it is a narrower fix than
// gating the whole script on the lock.
//
// FAILS OPEN, DELIBERATELY: if the lock check itself cannot run (no git, a
// transient fs error), this returns null rather than blocking every reap
// over a guard that is additive on top of the pre-existing socket-exclusion
// and wedged-pid safety net, not a replacement for it.
//
// `lockPath` is testing-only, exactly the shape HIVE_TMUX_TIMEOUT_MS already
// uses elsewhere in this project: the real path is ONE FILE SHARED BY EVERY
// WORKTREE of this checkout (resolveLockPath keys it on git-common-dir), so
// a test writing a fake holder record there would race whatever lane is
// actually running a suite on this machine right now - the exact hazard
// this guard exists to prevent, triggered by testing the guard itself.
// SWEEP_SUITE_LOCK_PATH lets a test point this at a throwaway file instead;
// left unset, production always resolves the real one.
export function liveSuiteLockHolder(lockPath = process.env.SWEEP_SUITE_LOCK_PATH || resolveLockPath()) {
  try {
    const found = readSuiteLockHolder(lockPath);
    if (found === null || found.record.corrupt) return null;
    return suiteLockHolderAlive(found.record.pid) ? found.record : null;
  } catch {
    return null;
  }
}

// A live (answering) candidate is reaped the recorded safe way - by SOCKET,
// never by pid (dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-pid.md).
// A server that answered "no server running" between the probe and here is
// swallowed, not reported as a failure: it is the outcome we wanted, arrived
// at through a harmless race with whatever else is on the machine.
function reapLiveServer(socket, timeoutMs) {
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { ok: true };
  } catch (e) {
    const stderr = (typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString() ?? "").trim();
    if (/no server running|error connecting to/.test(stderr)) return { ok: true }; // already gone
    return { ok: false, reason: stderr || e?.code || String(e?.message ?? e) };
  }
}

// The wedged case: kill-server BLOCKS against a server that never answers,
// so it is never attempted here at all
// (dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md). The
// fallback resolves BOTH live identifiers - socket (already excluded by
// orphanScratchServers' own enumeration, re-checked here as the dead-end
// asks) and the CURRENT process's own live server pid, when it is running
// inside one - and refuses to act unless lsof names exactly one pid for this
// specific socket file. An ambiguous or empty answer is left alone rather
// than guessed at; that is this population's version of the empty-list guard
// below, applied per-candidate instead of to the whole run.
export function reapWedgedServer(socket, livePid) {
  let out;
  try {
    out = execFileSync("lsof", ["-t", socket], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return { ok: false, reason: "lsof could not resolve a pid for this socket" };
  }
  const pids = [...new Set(out.split("\n").filter(Boolean).map(Number))].filter((p) => p !== livePid);
  if (pids.length !== 1) {
    return { ok: false, reason: `lsof named ${pids.length} candidate pid(s) for this socket, refusing to guess` };
  }
  return { ok: true, pid: pids[0] };
}

// Reporting only - a second, best-effort probe of a LIVE candidate for the
// session names a human reads to recognise what it is. orphanScratchServers'
// own probe already paid the cost of learning it answers; this is a second
// fork rather than plumbing the names through that return, because doctor's
// consumer has no use for them and this is the only caller that does.
function sessionNamesFor(socket, timeoutMs) {
  try {
    const out = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    }).trim();
    return out === "" ? [] : out.split("\n");
  } catch {
    return null; // best-effort: report the socket without names rather than fail the whole sweep over it
  }
}

function resolveLivePid() {
  if (!process.env.TMUX) return null;
  try {
    return Number(execFileSync("tmux", ["display-message", "-p", "#{pid}"], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Live-session verification, run after EVERY destructive step, not once at
// the end (dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md's
// own instruction). Safe on a machine with no hive session at all: no
// baseline means nothing to protect, never "reap everything".
// ---------------------------------------------------------------------------

function livePaneIds(session) {
  try {
    const out = execFileSync("tmux", ["list-panes", "-s", "-t", session, "-F", "#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      killSignal: "SIGKILL",
    }).trim();
    return out === "" ? [] : out.split("\n");
  } catch {
    return null; // no such session (or tmux not reachable) - nothing to verify
  }
}

function assertLiveSessionIntact(session, baseline) {
  if (baseline === null) return; // no live session existed before the sweep either
  const now = livePaneIds(session);
  const before = new Set(baseline);
  const after = new Set(now ?? []);
  const missing = [...before].filter((p) => !after.has(p));
  if (missing.length > 0) {
    throw new Error(
      `ABORTING: the live session ${session} lost pane(s) ${missing.join(", ")} during the sweep. ` +
        "Stop and investigate before running again - this must never happen.",
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // A deliberate one-off against the real store, exactly what storeDir()'s
  // own refusal (src/dataDir.ts) names as the escape hatch for: sessionName()
  // below only computes a TAG from the data dir path, it opens no database,
  // but the guard is guilty-until-proven-innocent about anything outside
  // hive's own CLI/MCP/hooks entrypoints. Set only if the caller has not
  // already decided this for itself.
  process.env.HIVE_ALLOW_DEFAULT_STORE ??= "1";

  const { isOrphanLoginShell, ptyHeadroom } = await import("../dist/ptys.js");
  const { orphanScratchServers, sessionName } = await import("../dist/tmux.js");

  const ageFloorMs = opts.ageHours * 60 * 60 * 1000;
  const session = sessionName();
  const baseline = livePaneIds(session);

  const before = ptyHeadroom();
  if (before) {
    console.log(`ptys before: ${before.allocated} of ${before.max} in use, ${before.max - before.allocated} free`);
  } else {
    console.log("ptys before: unavailable on this platform");
  }

  const shells = findOrphanShells(liveShellRows(), ageFloorMs, isOrphanLoginShell);
  const scratch = orphanScratchServers({ minAgeMs: ageFloorMs, budgetMs: opts.budgetMs });

  console.log(`\norphaned login shells (age >= ${opts.ageHours}h): ${shells.length}`);
  for (const s of shells) {
    // The parsed age, in the SAME unit as the threshold just printed above -
    // not the raw etime. "age 01:56" beside "age >= 12h" reads as an hour
    // fifty-six to a human deciding whether to pass --kill; it is one minute
    // fifty-six. parseEtimeSeconds is already correct (etime is kept too,
    // as the exact source value), this is a display fix only.
    console.log(`  pid ${s.pid}  ppid ${s.ppid}  age ${(s.ageMs / 3_600_000).toFixed(2)}h (${s.etime})  tty ${s.tty}  ${s.comm}`);
  }

  const entries = scratch?.entries ?? [];
  console.log(`\nold scratch tmux servers (age >= ${opts.ageHours}h): ${entries.length}`);
  for (const e of entries) {
    const names = e.state === "live" ? sessionNamesFor(e.socket, Math.min(2000, opts.budgetMs)) : null;
    const label = names === null ? e.state.toUpperCase() : `sessions: ${names.join(", ") || "none"}`;
    console.log(`  ${e.socket}  ${label}  age ${(e.ageMs / 3_600_000).toFixed(1)}h`);
  }

  // Checked once, up front, even in a dry run - a human deciding whether to
  // pass --kill should see this before deciding, not discover it only after.
  const suiteHolder = entries.length > 0 ? liveSuiteLockHolder() : null;
  if (suiteHolder) {
    console.log(
      `\nNOTE: the suite lock is held by pid ${suiteHolder.pid} (branch ${suiteHolder.branch}, ` +
        `worktree ${suiteHolder.worktree}) - scratch tmux servers will not be reaped while a live suite run holds it.`,
    );
  }

  if (!opts.kill) {
    console.log("\nDRY RUN: nothing was killed. Pass --kill to reap the above.");
    return;
  }

  // GUARD THE EMPTY-LIST CASE EXPLICITLY. Nothing below this line runs a
  // tmux/kill call with an empty argument list - each loop below simply does
  // not iterate when its population is empty, which is the same guarantee
  // stated where it matters rather than left to fall out of the loop shape
  // by accident. The message itself is gated the same way: printing
  // "reaping..." with nothing to reap reads as an action that did not
  // happen.
  if (shells.length + entries.length === 0) {
    console.log("\nnothing to reap.");
    return;
  }
  console.log("\nreaping...");

  for (const s of shells) {
    const result = await killPid(s.pid);
    console.log(
      `  pid ${s.pid}: ${result.escalated ? "needed SIGKILL after SIGTERM" : "died on SIGTERM"}` +
        (result.alive ? " (STILL ALIVE - left in place)" : ""),
    );
    assertLiveSessionIntact(session, baseline);
  }

  if (suiteHolder) {
    console.log(`  skipping ${entries.length} scratch tmux server(s): suite lock held by pid ${suiteHolder.pid} (see note above)`);
  } else {
    const livePid = resolveLivePid();
    for (const e of entries) {
      if (e.state === "live") {
        const result = reapLiveServer(e.socket, Math.min(5000, opts.budgetMs));
        console.log(`  ${e.socket}: ${result.ok ? "killed" : `FAILED (${result.reason})`}`);
      } else {
        const resolved = reapWedgedServer(e.socket, livePid);
        if (!resolved.ok) {
          console.log(`  ${e.socket}: WEDGED, skipped (${resolved.reason})`);
        } else {
          const result = await killPid(resolved.pid);
          console.log(
            `  ${e.socket}: WEDGED, pid ${resolved.pid} ${result.escalated ? "needed SIGKILL after SIGTERM" : "died on SIGTERM"}` +
              (result.alive ? " (STILL ALIVE - left in place)" : ""),
          );
        }
      }
      assertLiveSessionIntact(session, baseline);
    }
  }

  const after = ptyHeadroom();
  if (after) {
    console.log(`\nptys after: ${after.allocated} of ${after.max} in use, ${after.max - after.allocated} free`);
  } else {
    console.log("\nptys after: unavailable on this platform");
  }
}

// Only run when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exitCode = 1;
  });
}
