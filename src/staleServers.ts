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

export const STALE_SERVER_BOUNDARY_SLACK_MS = 3000;

const serverEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

export function elapsedSeconds(value: string): number | null {
  const dayForm = /^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  const fields = dayForm ? dayForm.slice(2).map(Number) : value.split(":").map(Number);
  if ((!dayForm && fields.length !== 2 && fields.length !== 3) || fields.some((field) => !Number.isSafeInteger(field) || field < 0)) {
    return null;
  }

  let total: number;
  if (dayForm) {
    const [hours, minutes, seconds] = fields;
    if (hours! > 23 || minutes! > 59 || seconds! > 59) return null;
    total = (Number(dayForm[1]) * 24 + hours!) * 3600 + minutes! * 60 + seconds!;
  } else if (fields.length === 2) {
    const [minutes, seconds] = fields;
    if (seconds! > 59) return null;
    total = minutes! * 60 + seconds!;
  } else {
    const [hours, minutes, seconds] = fields;
    if (minutes! > 59 || seconds! > 59) return null;
    total = hours! * 3600 + minutes! * 60 + seconds!;
  }
  return Number.isSafeInteger(total) ? total : null;
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

export function parseStaleHiveServers(psOutput: string, appliedAt: string, observedAt = Date.now()): StaleHiveServerReport {
  const newestMigration = appliedAtInstant(appliedAt);
  if (newestMigration === null) return { skipped: "the newest migration time is unavailable or invalid" };
  if (!Number.isFinite(observedAt)) return { skipped: "the process snapshot time is invalid" };

  const rows: Array<{ pid: number; ppid: number; elapsed: number; command: string }> = [];
  for (const line of psOutput.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!row) return { skipped: "ps returned a row that could not be parsed" };
    const elapsed = elapsedSeconds(row[3]!);
    if (elapsed === null) return { skipped: "ps returned an invalid elapsed time" };
    rows.push({ pid: Number(row[1]), ppid: Number(row[2]), elapsed, command: row[4]! });
  }
  const commands = new Map(rows.map((row) => [row.pid, row.command]));
  const servers = rows
    .map((row) => ({ ...row, started: observedAt - row.elapsed * 1000 }))
    .filter((row) => row.started < newestMigration - STALE_SERVER_BOUNDARY_SLACK_MS && runsThisServer(row.command))
    .map(({ elapsed: _elapsed, ...row }) => ({
      ...row,
      startedAt: new Date(row.started).toISOString(),
      parentCommand: commands.get(row.ppid) ?? null,
    }));
  return { servers };
}

export function staleHiveServers(appliedAt: string | null): StaleHiveServerReport {
  if (appliedAt === null) return { skipped: "the newest migration time is unavailable" };
  try {
    const psOutput = execFileSync("ps", ["-eo", "pid=,ppid=,etime=,command="], { encoding: "utf8" });
    return parseStaleHiveServers(psOutput, appliedAt, Date.now());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { skipped: `ps could not be run: ${reason}` };
  }
}
