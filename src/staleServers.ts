import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface StaleHiveServer {
  pid: number;
  ppid: number;
  startedAt: string;
  command: string;
  parentCommand: string | null;
}

export type StaleHiveServerReport =
  | { servers: StaleHiveServer[] }
  | { skipped: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const serverEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

function localLstartInstant(weekday: string, month: string, day: string, time: string, year: string): number | null {
  if (!/^[A-Z][a-z]{2}$/.test(weekday) || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) return null;
  const monthIndex = MONTHS.indexOf(month);
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (monthIndex < 0 || !match) return null;
  const date = new Date(Number(year), monthIndex, Number(day), Number(match[1]), Number(match[2]), Number(match[3]));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(match[1]) ||
    date.getMinutes() !== Number(match[2]) ||
    date.getSeconds() !== Number(match[3])
  ) {
    return null;
  }
  return date.getTime();
}

function appliedAtInstant(appliedAt: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(appliedAt)) return null;
  const instant = Date.parse(`${appliedAt.replace(" ", "T")}Z`);
  return Number.isFinite(instant) ? instant : null;
}

function runsThisServer(command: string): boolean {
  const escapedPath = serverEntrypoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const script = new RegExp(`(?:^|\\s|["'])${escapedPath}(?=$|\\s|["'])`).exec(command);
  if (!script) return false;
  const executable = command.slice(0, script.index + script[0].indexOf(serverEntrypoint)).trim();
  return /(?:^|[\\/])node(?:\.exe)?$/.test(executable);
}

export function parseStaleHiveServers(psOutput: string, appliedAt: string): StaleHiveServerReport {
  const newestMigration = appliedAtInstant(appliedAt);
  if (newestMigration === null) return { skipped: "the newest migration time is unavailable or invalid" };

  const rows: Array<{ pid: number; ppid: number; startedAt: string; started: number; command: string }> = [];
  for (const line of psOutput.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.+?)\s*$/.exec(line);
    if (!row) return { skipped: "ps returned a row that could not be parsed" };
    const started = localLstartInstant(row[3]!, row[4]!, row[5]!, row[6]!, row[7]!);
    if (started === null) return { skipped: "ps returned an invalid local start time" };
    const command = row[8]!;
    rows.push({
      pid: Number(row[1]),
      ppid: Number(row[2]),
      startedAt: `${row[3]} ${row[4]} ${row[5]} ${row[6]} ${row[7]}`,
      started,
      command,
    });
  }
  const commands = new Map(rows.map((row) => [row.pid, row.command]));
  const servers = rows
    .filter((row) => row.started < newestMigration && runsThisServer(row.command))
    .map(({ started: _started, ...row }) => ({ ...row, parentCommand: commands.get(row.ppid) ?? null }));
  return { servers };
}

export function staleHiveServers(appliedAt: string | null): StaleHiveServerReport {
  if (appliedAt === null) return { skipped: "the newest migration time is unavailable" };
  try {
    const psOutput = execFileSync("ps", ["-eo", "pid=,ppid=,lstart=,command="], { encoding: "utf8" });
    return parseStaleHiveServers(psOutput, appliedAt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { skipped: `ps could not be run: ${reason}` };
  }
}
