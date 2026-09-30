import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConfigSource } from "./globalConfig.js";
import type { ProjectYml } from "./projectYml.js";
import type { ProvenanceRow } from "./stateProvenance.js";

import { cutToUnitBudget } from "./slug.js";
import { FIRST_MESSAGE_SHA_ENV, TRIAGE_MESSAGE } from "./triageMessage.js";

export const OUTPUT_BUDGET = 10_000;
const CONTEXT_BUDGET = 6_000;
const BOARD_BUDGET = 1_800;

export interface KickoffResult {
  fired: boolean;

  reason?: string;
  payload?: string;

  warnings?: string[];

  firstMessage?: { message: string; source: string };
}

function currentBranch(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {

    return null;
  }
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${cutToUnitBudget(text, limit).trimEnd()}\n[truncated]`;
}

async function digest(projectPath: string, profile: string, warnings: string[]): Promise<string | null> {
  const { migrate, db } = await import("./db.js");
  const { findProjectForCwd } = await import("./context.js");
  const { ACTIVE_TIMER_WHERE } = await import("./scheduler.js");
  const { getActivePadByName } = await import("./tools/pads.js");
  const { OPEN_BLOCKERS_SQL } = await import("./tools/todos.js");
  migrate();

  const project = findProjectForCwd();
  if (!project || project.path !== projectPath) return null;

  const lines: string[] = [`[hive] Project "${project.name}" (profile: ${profile}).`];

  for (const w of warnings) lines.push(`! hive.yml: ${w}`);

  const headerLines = lines.length;

  const board = getActivePadByName(project.id, "board");
  if (board) {
    lines.push("", "BOARD (top of the pad; pad_read for the rest)", truncate(board.content.trim(), BOARD_BUDGET));
  }

  const inFlight = db
    .prepare(
      "SELECT id, title, status, slug FROM todos WHERE project_id = ? AND status = 'in_progress' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 10",
    )
    .all(project.id) as { id: number; title: string; status: string; slug: string }[];
  const ready = db
    .prepare(
      `SELECT id, title, slug FROM todos t
       WHERE t.project_id = ? AND t.status = 'open' AND t.archived_at IS NULL
         AND NOT EXISTS (${OPEN_BLOCKERS_SQL})
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id
       LIMIT 10`,
    )
    .all(project.id) as { id: number; title: string; slug: string }[];
  const blocked = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM todos t
         WHERE t.project_id = ? AND t.status IN ('open', 'in_progress') AND t.archived_at IS NULL
           AND EXISTS (${OPEN_BLOCKERS_SQL})`,
      )
      .get(project.id) as { n: number }
  ).n;

  if (inFlight.length > 0) {
    lines.push("", "IN FLIGHT");
    for (const t of inFlight) lines.push(`  #${t.id} ${t.slug ? `[${t.slug}] ` : ""}${t.title}`);
  }
  if (ready.length > 0) {
    lines.push("", "READY (unblocked, highest priority first)");
    for (const t of ready) lines.push(`  #${t.id} ${t.slug ? `[${t.slug}] ` : ""}${t.title}`);
  }
  if (blocked > 0) lines.push("", `BLOCKED: ${blocked} todo(s) waiting on a blocker.`);

  const agents = db
    .prepare(

      "SELECT name, actor_id, command, agent_state, state_changed_at, kind, tmux_target, cwd, resumed_at " +
        "FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent' ORDER BY id",
    )
    .all(project.id) as (ProvenanceRow & { name: string; tmux_target: string; cwd: string })[];
  if (agents.length > 0) {

    const { deriveProvenance, describeForHuman } = await import("./stateProvenance.js");
    lines.push("", "WORKERS (per the store, NOT probed; agent_list to confirm they are alive)");
    for (const a of agents) {
      lines.push(`  ${a.name} [${describeForHuman(deriveProvenance(a, null))}] ${a.cwd}`);
    }
  }

  const parked = (
    db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'closed' AND parked_at != ''")
      .get(project.id) as { n: number }
  ).n;
  if (parked > 0) {
    lines.push(
      "",
      `PARKED: ${parked} lane(s) paused rather than finished, waiting to be resumed. ` +
        "`hive status` lists each with its branch and the one call that brings it back.",
    );
  }

  const wakes = db
    .prepare(`SELECT COUNT(*) AS n FROM wakes WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`)
    .get(project.id) as { n: number };
  if (wakes.n > 0) lines.push("", `WAKE-UPS: ${wakes.n} pending (wake_list for detail).`);

  if (lines.length === headerLines) {
    lines.push("", "The store is empty for this project. Nothing is in flight.");
  }
  lines.push("", "Standing process for this project: run `hive runbook`.");

  return truncate(lines.join("\n"), CONTEXT_BUDGET);
}

// Exported so src/cli.ts can hand the identical text to a codex lead as its initial CLI prompt -
// codex's SessionStart hook rejects the whole payload if this rides inside hookSpecificOutput
// (see the `forCodex` branch below), so a codex lead gets it a different way, not a different
// message. Keep the two in sync by construction rather than by two literals staying equal.
export { TRIAGE_MESSAGE };

export type KickoffGate =
  | { ok: true; config: ProjectYml; warnings: string[]; sources: Record<string, ConfigSource>; profile: string }
  | { ok: false; reason: string; warnings: string[] };

// Shared with `hive lead`, which passes the first message on the command line only when this holds.
export async function kickoffGate(dir: string): Promise<KickoffGate> {
  const { activeProfile, DEFAULT_LEAD_BRANCHES, loadProjectYml } = await import("./projectYml.js");
  const { profileExists } = await import("./profiles.js");
  const { config, warnings, sources } = loadProjectYml(dir);

  const no = (reason: string): KickoffGate => ({ ok: false, reason, warnings });
  if (config == null) return no("no hive.yml here");
  const profile = activeProfile(config);

  if (!profile) return no("no profile in hive.yml");
  if (!profileExists(profile)) return no(`profile "${profile}" is not on this machine`);

  const branch = currentBranch(dir);
  const leadBranches = config.lead_branches ?? DEFAULT_LEAD_BRANCHES;
  if (branch != null && !leadBranches.includes(branch)) {
    return no(`branch "${branch}" is not a lead branch (${leadBranches.join(", ")})`);
  }
  return { ok: true, config, warnings, sources, profile };
}

export async function evaluate(cwd: string, opts: { forCodex?: boolean } = {}): Promise<KickoffResult> {

  if (process.env.HIVE_AGENT_ID && process.env.HIVE_LEAD !== "1") {
    return { fired: false, reason: "worker session (HIVE_AGENT_ID is set)" };
  }

  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return { fired: false, reason: "cwd does not exist" };
  }

  const gate = await kickoffGate(dir);
  if (!gate.ok) return { fired: false, reason: gate.reason, warnings: gate.warnings };
  const { config, warnings, sources, profile } = gate;

  const context = await digest(dir, profile, warnings);
  if (context == null) return { fired: false, reason: "not a registered hive project root", warnings };

  // Codex's SessionStartHookSpecificOutputWire is additionalProperties:false and permits only
  // hookEventName/additionalContext - initialUserMessage inside it fails the whole payload
  // ("SessionStart Failed"), silently dropping the board too. Measured, todo 567 comment 1864.
  const { resolveFirstMessage } = await import("./projectYml.js");
  const first = resolveFirstMessage(config, sources);
  const onCommandLine = process.env.HIVE_LEAD === "1" && !!process.env[FIRST_MESSAGE_SHA_ENV];
  const hookMessage = opts.forCodex || onCommandLine || first.message === "" ? null : first.message;
  const build = (text: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
        ...(hookMessage === null ? {} : { initialUserMessage: hookMessage }),
      },
    });
  let payload = build(context);
  if (payload.length > OUTPUT_BUDGET) {

    const overflow = payload.length - OUTPUT_BUDGET;
    payload = build(truncate(context, Math.max(0, context.length - overflow - 32)));
  }
  return { fired: true, payload, warnings, firstMessage: first };
}

export async function runKickoff(argv: string[] = []): Promise<void> {
  const explain = argv.includes("--explain");
  const forCodex = argv.includes("--codex");
  let result: KickoffResult;
  try {
    result = await evaluate(process.cwd(), { forCodex });
  } catch (e) {

    if (explain) console.log(`hive kickoff: silent (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }

  if (explain) for (const w of result.warnings ?? []) console.log(`! hive.yml: ${w}`);
  if (result.fired && result.payload) {
    if (explain && result.firstMessage) {
      const { message, source } = result.firstMessage;
      console.log(
        source === "empty" ? "first message: none (empty string in hive.yml)" : `first message (${source}): ${message}`,
      );
    }
    process.stdout.write(result.payload);
    if (explain) process.stdout.write("\n");
    return;
  }
  if (explain) console.log(`hive kickoff: silent (${result.reason}).`);
}

const runDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (runDirectly) await runKickoff(process.argv.slice(2));
