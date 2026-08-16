import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

export interface PtyHeadroom {

  allocated: number;
  max: number;

  orphanLoginShells: number;
  source: string;
}

export interface PsRow {
  tty: string;
  ppid: number;

  comm: string;
}

const PS_LINE = /^\s*(\S+)\s+(\d+)\s+(.+?)\s*$/;

export function parsePsSnapshot(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({ tty: m[1], ppid: Number(m[2]), comm: m[3] });
  }
  return rows;
}

export function countAllocatedTtys(rows: PsRow[]): number {
  return new Set(rows.filter((r) => /^ttys/.test(r.tty)).map((r) => r.tty)).size;
}

export function isOrphanLoginShell(row: PsRow): boolean {
  if (row.ppid !== 1) return false;
  const arg0 = row.comm.split(/\s+/, 1)[0] ?? row.comm;
  const base = arg0.split("/").pop() ?? arg0;
  return base.startsWith("-");
}

export function countOrphanLoginShells(rows: PsRow[]): number {
  return rows.filter(isOrphanLoginShell).length;
}

function psSnapshot(field: "comm" | "args"): PsRow[] {
  return parsePsSnapshot(
    execFileSync("ps", ["-eo", `tty=,ppid=,${field}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

export function ptyWarnThreshold(max: number): number {
  return Math.max(32, Math.floor(max / 10));
}

export function isLowHeadroom(headroom: Pick<PtyHeadroom, "allocated" | "max">): boolean {
  const free = headroom.max - headroom.allocated;
  return free < ptyWarnThreshold(headroom.max);
}

function isRealCount(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

const SYSCTL = "/usr/sbin/sysctl";

function darwinHeadroom(): PtyHeadroom {
  const max = Number(
    execFileSync(SYSCTL, ["-n", "kern.tty.ptmx_max"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
  );
  if (!isRealCount(max) || max === 0) throw new Error("sysctl kern.tty.ptmx_max did not report a usable number");

  const rows = psSnapshot("comm");
  return {
    allocated: countAllocatedTtys(rows),
    max,
    orphanLoginShells: countOrphanLoginShells(rows),
    source: `${SYSCTL} -n kern.tty.ptmx_max, ps -eo tty=,ppid=,comm=`,
  };
}

function linuxHeadroom(): PtyHeadroom {
  const max = Number(readFileSync("/proc/sys/kernel/pty/max", "utf8").trim());
  const allocated = Number(readFileSync("/proc/sys/kernel/pty/nr", "utf8").trim());
  if (!isRealCount(max) || max === 0 || !isRealCount(allocated)) {
    throw new Error("/proc/sys/kernel/pty/{max,nr} did not report usable numbers");
  }

  let orphanLoginShells = 0;
  try {
    orphanLoginShells = countOrphanLoginShells(psSnapshot("args"));
  } catch {

  }
  return { allocated, max, orphanLoginShells, source: "/proc/sys/kernel/pty/{max,nr}" };
}

export function probeForPlatform(osPlatform: string): (() => PtyHeadroom) | null {
  if (osPlatform === "darwin") return darwinHeadroom;
  if (osPlatform === "linux") return linuxHeadroom;
  return null;
}

export function safeProbe(probe: () => PtyHeadroom): PtyHeadroom | null {
  try {
    return probe();
  } catch {
    return null;
  }
}

export function ptyHeadroom(): PtyHeadroom | null {

  try {
    const probe = probeForPlatform(platform());
    return probe ? safeProbe(probe) : null;
  } catch {
    return null;
  }
}
