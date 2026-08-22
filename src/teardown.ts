import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TEARDOWN_LOG = "teardowns.jsonl";

// A backstop against a runaway writer, not a retention policy.
export const TEARDOWN_MAX_RECORDS = 200;

export const NOT_ATTRIBUTED = "not attributed";
export const TEARDOWN_TRIGGER = "no panes on the socket";

export type WindowBasis = "observed" | "inferred";

export interface TeardownMember {
  agent_id: number;
  project_id: number | null;
  name: string;
  actor_id: string;
  kind: string;
  cwd: string;
  tmux_target: string;
  pane_pid: string;
  session_id: string;
  agent_state: string;
  last_evidence_at: string;
  swept: boolean;
}

export interface TeardownWindow {
  from: string;
  to: string;
  basis: WindowBasis;
  width_seconds: number;
}

export interface TeardownRecord {
  detected_at: string;
  socket: string;
  trigger: string;
  attribution: string;
  window: TeardownWindow;
  crew: TeardownMember[];
}

export function teardownLogPath(dataDir: string): string {
  return join(dataDir, TEARDOWN_LOG);
}

export function sqlNow(now: Date = new Date()): string {
  return now.toISOString().replace("T", " ").slice(0, 23);
}

const sqlToDate = (ts: string): Date => new Date(`${ts.replace(" ", "T")}Z`);

export function teardownWindow(from: string, to: string, basis: WindowBasis): TeardownWindow {
  const seconds = (sqlToDate(to).getTime() - sqlToDate(from).getTime()) / 1000;
  return { from, to, basis, width_seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 };
}

export function appendTeardown(dataDir: string, record: TeardownRecord): void {
  const path = teardownLogPath(dataDir);
  const line = JSON.stringify(record);
  const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  if (existing.length + 1 > TEARDOWN_MAX_RECORDS) {

    // Trimming rewrites the whole file, so it goes via a temp path and a rename: a crash mid-write
    // would otherwise cost the entire log, and this file is the only durable trace of the thing it
    // describes.
    const staging = `${path}.trimming`;
    writeFileSync(staging, `${[...existing, line].slice(-TEARDOWN_MAX_RECORDS).join("\n")}\n`);
    renameSync(staging, path);
    return;
  }
  appendFileSync(path, `${line}\n`);
}

// Every field a reader DEREFERENCES is checked, members included. project_id is deliberately not
// required: a record written before that field existed is readable, and its members count as
// unknown-project rather than costing the whole record.
function isTeardownMember(v: unknown): v is TeardownMember {
  const m = v as TeardownMember | null;
  return (
    typeof m === "object" &&
    m !== null &&
    typeof m.agent_id === "number" &&
    typeof m.actor_id === "string" &&
    typeof m.name === "string" &&
    typeof m.cwd === "string" &&
    typeof m.session_id === "string" &&
    typeof m.swept === "boolean"
  );
}

function isTeardownRecord(v: unknown): v is TeardownRecord {
  const r = v as TeardownRecord | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.detected_at === "string" &&
    typeof r.socket === "string" &&
    typeof r.attribution === "string" &&
    typeof r.window === "object" &&
    r.window !== null &&
    typeof r.window.from === "string" &&
    typeof r.window.to === "string" &&
    typeof r.window.width_seconds === "number" &&
    Array.isArray(r.crew) &&
    r.crew.every(isTeardownMember)
  );
}

// This file sits in the user's data dir and doctor is what people run once things are ALREADY
// broken, so a record hive did not write must cost that record and never the report.
export function readTeardowns(dataDir: string): TeardownRecord[] {
  const path = teardownLogPath(dataDir);
  if (!existsSync(path)) return [];
  const records: TeardownRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTeardownRecord(parsed)) records.push(parsed);
    } catch {
      // A half-written last line costs the reader that record, never the whole file.
    }
  }
  return records;
}

export function describeTeardownWindow(w: TeardownWindow): string {
  const width = w.width_seconds < 90 ? `${Math.round(w.width_seconds)}s` : `${Math.round(w.width_seconds / 60)}m`;
  return w.basis === "observed"
    ? `between ${w.from} and ${w.to} (${width} wide; hive was watching this socket and saw it alive at the start of that window)`
    : `between ${w.from} and ${w.to} (${width} wide; NO hive process survived to watch, so the start is only the newest evidence in the store, not a sighting)`;
}
