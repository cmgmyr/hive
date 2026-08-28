#!/usr/bin/env node

import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const HELP = `Usage: node scripts/tmux-trace.mjs <trace-dir> [--young-ms=N] [--prune] [--json]

Reduces the tmux server logs a traced test run leaves behind (HIVE_TMUX_TRACE=<dir>
with test/helpers.mjs's isolateTmux) into one row per pane: which tmux command
CREATED it, whether it was a bare login shell, and how old it was when whatever
destroyed it did so.

  --young-ms=N   the age under which a destroy is reported as a wedge candidate
                 (default 15, from todo 472's fork-to-setsid measurement)
  --prune        delete the raw logs after reducing; they carry the full
                 environment of every process the server spawned
  --json         emit the rows as JSON instead of a report
  --help         print this and exit
`;

const DEFAULT_YOUNG_MS = 15;

const CAUSE_WINDOW_MS = 100;

const SPAWN = /^(\d+\.\d+) spawn_pane: \[([a-z-]+)\//;
const ADD_PANE = /^(\d+\.\d+) window_add_pane: (@\d+)(?: after (%\d+))?/;
const SPAWN_CMD = /^(\d+\.\d+) spawn_pane: cmd=/;
const SPAWN_CWD = /^(\d+\.\d+) spawn_pane: cwd=(.*)$/;
const WINDOW_GONE = /^(\d+\.\d+) window (@\d+) destroyed/;
const SESSION_GONE = /^(\d+\.\d+) session (\S+) destroyed \(([^)]+)\)/;
const COMMAND = /^(\d+\.\d+) cmdq_fire_command <([^>]+)>: \(\d+\) (.*)$/;
const DESTROY_VERB = /^(kill-session|kill-window|kill-pane|respawn-pane|respawn-window)\b/;
const KILL_PANE_TARGET = /^kill-pane\b.*-t\s+"?(%\d+)"?/;

export const UNRESOLVED =
  "unresolved: a kill-pane in this window named a pane id the log never tied to a create, " +
  "and tmux logs no per-pane destroy line";

export function reduceTraceLog(text, { file = "" } = {}) {
  const panes = [];
  const commands = [];
  const causes = [];
  const unmatchedKills = [];
  let open = null;

  for (const line of text.split("\n")) {
    const spawn = SPAWN.exec(line);
    if (spawn) {
      open = {
        file,
        verb: spawn[2],
        createTs: Number(spawn[1]) * 1000,
        bare: true,
        window: null,
        pane: null,
        cwd: null,
        destroyTs: null,
        cause: null,
      };
      panes.push(open);
      continue;
    }
    const add = ADD_PANE.exec(line);
    if (add && open && open.window === null) {
      open.window = add[2];
      open.pane = add[3] ?? null;
      continue;
    }
    if (open && SPAWN_CMD.test(line)) {
      open.bare = false;
      continue;
    }
    const cwd = SPAWN_CWD.exec(line);
    if (cwd && open) {
      open.cwd = cwd[2];
      continue;
    }
    const command = COMMAND.exec(line);
    if (command) {
      const verb = DESTROY_VERB.exec(command[3]);
      if (!verb) continue;
      const ts = Number(command[1]) * 1000;
      commands.push({ file, ts, client: command[2], command: command[3] });

      const target = KILL_PANE_TARGET.exec(command[3])?.[1];
      if (target) {
        const hit = panes.find((pane) => pane.pane === target && pane.destroyTs === null);
        if (hit) {
          hit.destroyTs = ts;
          hit.cause = "kill-pane";
        } else {
          unmatchedKills.push({ ts });
        }
      }
      continue;
    }
    const session = SESSION_GONE.exec(line);
    if (session) {
      causes.push({ ts: Number(session[1]) * 1000, cause: `${session[3]} (session ${session[2]})` });
      continue;
    }
    const gone = WINDOW_GONE.exec(line);
    if (gone) {
      const ts = Number(gone[1]) * 1000;
      for (const pane of panes) {
        if (pane.window !== gone[2] || pane.destroyTs !== null) continue;
        // An unmatched kill-pane may have destroyed this pane long before its window went,
        // and only a window that held two panes can outlive one, so single-pane ones are exact.
        const shared = panes.filter((other) => other.window === pane.window).length > 1;
        if (shared && unmatchedKills.some((kill) => kill.ts >= pane.createTs && kill.ts <= ts)) {
          pane.cause = UNRESOLVED;
          continue;
        }
        pane.destroyTs = ts;
        pane.cause = causeFor(ts, causes, commands);
      }
    }
  }
  return { panes, commands };
}

function causeFor(ts, causes, commands) {
  const nearest = (rows, field) =>
    rows.filter((row) => row.ts <= ts && ts - row.ts <= CAUSE_WINDOW_MS).sort((a, b) => b.ts - a.ts)[0]?.[field] ?? null;
  return nearest(causes, "cause") ?? nearest(commands, "command") ?? "no kill command logged (automatic teardown)";
}

export function ageMs(pane) {
  return pane.destroyTs === null ? null : pane.destroyTs - pane.createTs;
}

export function bucket(age, youngMs) {
  assertYoungMs(youngMs);
  if (age === null) return "age not measured";
  if (age < youngMs) return `under ${youngMs}ms - WEDGE CANDIDATE`;
  const edges = [...new Set([youngMs, 100, 1000])].filter((edge) => edge > youngMs).sort((a, b) => a - b);
  let low = youngMs;
  for (const edge of edges) {
    if (age < edge) return `${low}-${edge}ms`;
    low = edge;
  }
  return `over ${low}ms`;
}

export function assertYoungMs(youngMs) {
  if (!Number.isFinite(youngMs) || youngMs <= 0) {
    throw new Error(`--young-ms must be a positive number of milliseconds, got ${String(youngMs)}`);
  }
}

function logFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...logFiles(path));
    else if (/^tmux-server-\d+\.log$/.test(entry.name)) found.push(path);
  }
  return found;
}

export function report(panes, commands, { youngMs }) {
  const lines = [];
  const bare = panes.filter((p) => p.bare);
  lines.push(
    `${panes.length} pane(s) created across the trace: ${bare.length} bare login shell(s), ` +
      `${panes.length - bare.length} with a command.`,
  );

  const buckets = new Map();
  for (const pane of panes) {
    const key = `${bucket(ageMs(pane), youngMs)} | ${pane.verb} -> ${pane.cause ?? "still alive"} | ${pane.bare ? "BARE" : "commanded"}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  lines.push("", "create verb -> destroy cause, by age:");
  for (const [key, count] of [...buckets].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(count).padStart(5)}  ${key}`);

  const candidates = bare.filter((p) => ageMs(p) !== null && ageMs(p) < youngMs);
  lines.push("", `bare panes destroyed under ${youngMs}ms (the wedge conjunction): ${candidates.length}`);
  for (const pane of candidates.sort((a, b) => ageMs(a) - ageMs(b)).slice(0, 40)) {
    lines.push(`  ${ageMs(pane).toFixed(3)}ms  ${pane.verb} -> ${pane.cause}`);
    lines.push(`          cwd ${pane.cwd ?? "unknown"}`);
    lines.push(`          ${pane.file}`);
  }

  const byVerb = new Map();
  for (const c of commands) {
    const verb = c.command.split(/\s+/)[0];
    byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1);
  }
  lines.push("", "destroy commands the servers were asked to run:");
  for (const [verb, count] of [...byVerb].sort((a, b) => b[1] - a[1])) lines.push(`  ${String(count).padStart(5)}  ${verb}`);
  const unresolved = panes.filter((p) => p.cause === UNRESOLVED).length;
  if (byVerb.has("kill-pane")) {
    lines.push(
      "  NOTE: tmux logs no per-pane destroy line. A kill-pane naming a pane id this log tied to a",
      "  create is dated exactly; one naming an id it never saw created (the first pane of a window",
      `  is never named at its create) leaves every pane in that window UNDATED - ${unresolved} here.`,
      "  So this instrument UNDER-reports young destroys and never over-reports them.",
    );
  }
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const dir = args.find((a) => !a.startsWith("-"));
  const youngMs = Number(args.find((a) => a.startsWith("--young-ms="))?.split("=")[1] ?? DEFAULT_YOUNG_MS);
  assertYoungMs(youngMs);
  if (!dir || !statSync(dir).isDirectory()) throw new Error(`not a trace directory: ${dir}`);

  const files = logFiles(dir);
  const panes = [];
  const commands = [];
  for (const file of files) {
    const reduced = reduceTraceLog(readFileSync(file, "utf8"), { file });
    panes.push(...reduced.panes);
    commands.push(...reduced.commands);
  }

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ files: files.length, panes, commands }, null, 2)}\n`);
  } else {
    process.stdout.write(`${files.length} traced tmux server log(s) under ${dir}\n`);
    process.stdout.write(`${report(panes, commands, { youngMs }).join("\n")}\n`);
  }

  if (args.includes("--prune")) {
    for (const file of files) rmSync(file, { force: true });
    process.stdout.write(`\npruned ${files.length} raw log(s); they carried the spawned environment.\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(e?.stack ?? String(e));
    process.exitCode = 1;
  }
}
