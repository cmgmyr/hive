#!/usr/bin/env node

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

const DEFAULT_AGE_HOURS = 12;
const DEFAULT_BUDGET_MS = 30_000;

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

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

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

export function parseEtimeSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime) ?? /^(\d+)$/.exec(etime);
  if (!m) return null;
  if (m.length === 2) return Number(m[1]);
  const [, days, hours, minutes, seconds] = m;
  return (
    (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

function liveShellRows() {

  if (process.env.SWEEP_PS_ROWS_JSON) return JSON.parse(process.env.SWEEP_PS_ROWS_JSON);

  const field = platform() === "linux" ? "args" : "comm";
  const out = execFileSync("ps", ["-eo", `pid=,ppid=,etime=,tty=,${field}=`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parsePsRows(out);
}

export function findOrphanShells(rows, ageFloorMs, isOrphanLoginShell) {
  return rows
    .filter((r) => r.tty !== "??" && r.tty !== "?")
    .filter((r) => isOrphanLoginShell({ ppid: r.ppid, comm: r.comm }))
    .map((r) => ({ ...r, ageMs: (parseEtimeSeconds(r.etime) ?? 0) * 1000 }))
    .filter((r) => r.ageMs >= ageFloorMs);
}

export async function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if (e?.code === "ESRCH") return { escalated: false, alive: false };
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

export function liveSuiteLockHolder(lockPath = process.env.SWEEP_SUITE_LOCK_PATH || resolveLockPath()) {
  try {
    const found = readSuiteLockHolder(lockPath);
    if (found === null || found.record.corrupt) return null;
    return suiteLockHolderAlive(found.record.pid) ? found.record : null;
  } catch {
    return null;
  }
}

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
    if (/no server running|error connecting to/.test(stderr)) return { ok: true };
    return { ok: false, reason: stderr || e?.code || String(e?.message ?? e) };
  }
}

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
    return null;
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
    return null;
  }
}

function assertLiveSessionIntact(session, baseline) {
  if (baseline === null) return;
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

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

    console.log(`  pid ${s.pid}  ppid ${s.ppid}  age ${(s.ageMs / 3_600_000).toFixed(2)}h (${s.etime})  tty ${s.tty}  ${s.comm}`);
  }

  const entries = scratch?.entries ?? [];
  console.log(`\nold scratch tmux servers (age >= ${opts.ageHours}h): ${entries.length}`);
  for (const e of entries) {
    const names = e.state === "live" ? sessionNamesFor(e.socket, Math.min(2000, opts.budgetMs)) : null;
    const label = names === null ? e.state.toUpperCase() : `sessions: ${names.join(", ") || "none"}`;
    console.log(`  ${e.socket}  ${label}  age ${(e.ageMs / 3_600_000).toFixed(1)}h`);
  }

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exitCode = 1;
  });
}
