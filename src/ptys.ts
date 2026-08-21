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
    if (process.env.HIVE_PTY_HEADROOM_JSON) return JSON.parse(process.env.HIVE_PTY_HEADROOM_JSON) as PtyHeadroom;
    const probe = probeForPlatform(platform());
    return probe ? safeProbe(probe) : null;
  } catch {
    return null;
  }
}

export interface PsRowWithAge extends PsRow {
  pid: number;
  ageMs: number;
}

const PS_AGE_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;

export function parseEtimeSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime) ?? /^(\d+)$/.exec(etime);
  if (!m) return null;
  if (m.length === 2) return Number(m[1]);
  const [, days, hours, minutes, seconds] = m;
  return (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parsePsSnapshotWithAge(output: string): PsRowWithAge[] {
  const rows: PsRowWithAge[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const m = PS_AGE_LINE.exec(line);
    if (!m) continue;
    const seconds = parseEtimeSeconds(m[3]);
    if (seconds === null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), ageMs: seconds * 1000, tty: m[4], comm: m[5] });
  }
  return rows;
}

export function filterOrphanLoginShellsWithAge(rows: PsRowWithAge[]): PsRowWithAge[] {
  return rows.filter(isOrphanLoginShell);
}

function psSnapshotWithAge(): PsRowWithAge[] | null {
  try {
    if (process.env.HIVE_PTY_PS_ROWS_JSON) return JSON.parse(process.env.HIVE_PTY_PS_ROWS_JSON) as PsRowWithAge[];
    return parsePsSnapshotWithAge(
      execFileSync("ps", ["-eo", "pid=,ppid=,etime=,tty=,comm="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

export function orphanLoginShellDetails(): PsRowWithAge[] | null {
  const rows = psSnapshotWithAge();
  return rows === null ? null : filterOrphanLoginShellsWithAge(rows);
}
