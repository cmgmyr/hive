import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

import { findOrphanShells, killPid, parseEtimeSeconds, parsePsRows } from "./sweep-scratch.mjs";

const AGE_SLACK_MS = 2000;

const TERM_SETTLE_MS = 500;

const DEFAULT_BUDGET_MS = 20_000;

export function noReapRequested() {
  return process.env.HIVE_TEST_NO_REAP === "1";
}

function psRows() {
  const injected = process.env.HIVE_REAP_PS_ROWS_FILE;
  if (injected) return JSON.parse(readFileSync(injected, "utf8"));
  const field = platform() === "linux" ? "args" : "comm";
  return parsePsRows(
    execFileSync("ps", ["-eo", `pid=,ppid=,etime=,tty=,${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

export async function orphanShellRows() {
  try {
    const { isOrphanLoginShell } = await import("../dist/ptys.js");
    return { rows: findOrphanShells(psRows(), 0, isOrphanLoginShell), unavailable: null };
  } catch (e) {
    return { rows: [], unavailable: e?.message ?? String(e) };
  }
}

// A SUPPORTING bound, not a second independent guard: the 2s slack admits a shell created
// up to 2s before a short run, so only the pid-set bracket spares every pre-existing shell.
export function youngerThanTheRun(row, maxAgeMs) {
  // findOrphanShells reads an unparseable etime as age 0, which is the SAFE direction for
  // sweep-scratch's age FLOOR and the fail-open direction for this ceiling. Unreadable age
  // means unknown age, and unknown age is old enough to predate this run.
  const seconds = parseEtimeSeconds(row.etime ?? "");
  if (seconds === null) return false;
  return seconds * 1000 <= maxAgeMs + AGE_SLACK_MS;
}

export function newlyWedged(beforePids, afterRows, { maxAgeMs }) {
  const before = beforePids instanceof Set ? beforePids : new Set(beforePids);
  return afterRows.filter((row) => !before.has(row.pid)).filter((row) => youngerThanTheRun(row, maxAgeMs));
}

export async function stillOrphanLoginShells(rows) {
  const fresh = await orphanShellRows();
  if (fresh.unavailable) return { rows: [], unavailable: fresh.unavailable };
  const live = new Map(fresh.rows.map((row) => [row.pid, row]));
  return { rows: rows.filter((row) => live.has(row.pid)), unavailable: null };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function reapWedged(rows, { budgetMs = DEFAULT_BUDGET_MS, settleMs = TERM_SETTLE_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  const reaped = [];
  const survived = [];
  const alreadyGone = [];
  const signalled = [];
  for (const row of rows) {
    try {
      process.kill(row.pid, "SIGTERM");
      signalled.push(row);
    } catch (e) {
      if (e?.code === "ESRCH") alreadyGone.push(row);
      else survived.push({ ...row, reason: e?.message ?? String(e) });
    }
  }
  if (signalled.length > 0) await new Promise((r) => setTimeout(r, settleMs));

  for (const row of signalled) {
    if (!isAlive(row.pid)) {
      reaped.push({ ...row, escalated: false });
      continue;
    }
    if (Date.now() >= deadline) {
      survived.push({ ...row, reason: "not escalated: the reaper's time budget ran out" });
      continue;
    }
    try {
      const result = await killPid(row.pid);
      if (result.alive) survived.push({ ...row, reason: "still alive after SIGKILL" });
      else reaped.push({ ...row, escalated: result.escalated });
    } catch (e) {
      survived.push({ ...row, reason: e?.message ?? String(e) });
    }
  }
  return { reaped, survived, alreadyGone };
}

export function describeWedgedReap(result) {
  if (result.skipped) return [`skipped: ${result.skipped}`];
  if (result.unavailable) return [`unavailable: ${result.unavailable}`];
  const { reaped = [], survived = [], alreadyGone = [], droppedByRecheck = 0 } = result;
  const dropped =
    droppedByRecheck > 0
      ? `; ${droppedByRecheck} bracketed pid(s) had stopped being orphaned login shells by the time it signalled, and were spared`
      : "";
  if (reaped.length === 0 && survived.length === 0 && alreadyGone.length === 0) {
    return droppedByRecheck > 0
      ? [`reaped 0 orphaned login shell(s)${dropped}`]
      : [`nothing to reap: this run created no orphaned login shells (${result.bracketed ?? 0} bracketed before it)`];
  }
  const escalated = reaped.filter((row) => row.escalated).length;
  const lines = [
    `reaped ${reaped.length} orphaned login shell(s) this run created and left behind` +
      (escalated > 0 ? `, ${escalated} of them only on SIGKILL` : "") +
      (alreadyGone.length > 0 ? `; ${alreadyGone.length} had already gone before the reaper signalled` : "") +
      dropped,
  ];
  for (const row of survived) {
    lines.push(`  pid ${row.pid} (tty ${row.tty}, ${row.comm}) LEFT IN PLACE: ${row.reason}`);
  }
  return lines;
}
