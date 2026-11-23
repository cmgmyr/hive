import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATA_DIR } from "./dataDir.js";
import { parseEtimeSeconds } from "./etime.js";
import { parseStoreTimestamp } from "./storeClock.js";

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

export function readProcessEnvironment(pid: number): string | null {
  try {
    return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "status" in error && error.status === 1 &&
      "stdout" in error && String(error.stdout ?? "").trim() === "" &&
      "stderr" in error && (String(error.stderr ?? "").trim() === "" || /no such process|process id .* (?:not found|does not exist)/i.test(String(error.stderr)))
    ) {
      return null;
    }
    throw error;
  }
}

const serverEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");

export const elapsedSeconds = parseEtimeSeconds;

function appliedAtInstant(appliedAt: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(appliedAt)) return null;
  const instant = parseStoreTimestamp(appliedAt);
  return Number.isFinite(instant) ? instant : null;
}

function runsThisServer(command: string): boolean {
  const escapedPath = serverEntrypoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const script = new RegExp(`(?:^|\\s|["'])${escapedPath}(?=$|\\s|["'])`).exec(command);
  if (!script) return false;
  const executable = command.slice(0, script.index + script[0].indexOf(serverEntrypoint)).trim();
  return /(?:^|[\\/])node(?:\.exe)?$/.test(executable);
}

function canonicalDataDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function processUsesDataDir(psOutput: string, dataDir: string): boolean | null {
  if (psOutput.trim() === "") return false;
  if (!runsThisServer(psOutput)) return false;
  const store = /(?:^|\s)HIVE_DATA_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|$)/.exec(psOutput);
  const path = store ? store[1]!.trim() || DEFAULT_DATA_DIR : /(?:^|\s)PATH=/.test(psOutput) ? DEFAULT_DATA_DIR : null;
  if (path === null) return null;
  return canonicalDataDir(path) === canonicalDataDir(dataDir);
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

export function staleHiveServers(
  appliedAt: string | null,
  dataDir = DEFAULT_DATA_DIR,
  readEnvironment = readProcessEnvironment,
): StaleHiveServerReport {
  if (appliedAt === null) return { skipped: "the newest migration time is unavailable" };
  try {
    const psOutput = execFileSync("ps", ["-eo", "pid=,ppid=,etime=,command="], { encoding: "utf8" });
    const parsed = parseStaleHiveServers(psOutput, appliedAt, Date.now());
    if ("skipped" in parsed) return parsed;
    const servers: StaleHiveServer[] = [];
    for (const server of parsed.servers) {
      const envOutput = readEnvironment(server.pid);
      if (envOutput === null) continue;
      const sameStore = processUsesDataDir(envOutput, dataDir);
      if (sameStore === null) return { skipped: "ps returned environment output that could not be parsed" };
      if (sameStore) servers.push(server);
    }
    return { servers };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { skipped: `ps could not be run: ${reason}` };
  }
}
