import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProvenanceRow } from "./stateProvenance.js";

import { cutToUnitBudget } from "./slug.js";

export const OUTPUT_BUDGET = 10_000;
const CONTEXT_BUDGET = 6_000;
const BOARD_BUDGET = 1_800;

export interface KickoffResult {
  fired: boolean;

  reason?: string;
  payload?: string;

  warnings?: string[];
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
      "SELECT id, title, status FROM todos WHERE project_id = ? AND status = 'in_progress' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 10",
    )
    .all(project.id) as { id: number; title: string; status: string }[];
  const ready = db
    .prepare(
      `SELECT id, title FROM todos t
       WHERE t.project_id = ? AND t.status = 'open' AND t.archived_at IS NULL
         AND NOT EXISTS (${OPEN_BLOCKERS_SQL})
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id
       LIMIT 10`,
    )
    .all(project.id) as { id: number; title: string }[];
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
    for (const t of inFlight) lines.push(`  #${t.id} ${t.title}`);
  }
  if (ready.length > 0) {
    lines.push("", "READY (unblocked, highest priority first)");
    for (const t of ready) lines.push(`  #${t.id} ${t.title}`);
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
    .prepare(`SELECT COUNT(*) AS n FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`)
    .get(project.id) as { n: number };
  if (wakes.n > 0) lines.push("", `WAKE-UPS: ${wakes.n} pending (wake_list for detail).`);

  if (lines.length === headerLines) {
    lines.push("", "The store is empty for this project. Nothing is in flight.");
  }
  lines.push("", "Standing process for this project: run `hive runbook`.");

  return truncate(lines.join("\n"), CONTEXT_BUDGET);
}

const TRIAGE_MESSAGE =
  "Start with morning triage. Run `hive runbook` for this project's standing process, then " +
  "reconcile the state hive just injected against what is really there (agent_list, todo_list, " +
  "wake_list) and report it in a few lines. Propose today's lanes and confirm them with me before " +
  "dispatching anything.";

export async function evaluate(cwd: string): Promise<KickoffResult> {

  if (process.env.HIVE_AGENT_ID && process.env.HIVE_LEAD !== "1") {
    return { fired: false, reason: "worker session (HIVE_AGENT_ID is set)" };
  }

  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return { fired: false, reason: "cwd does not exist" };
  }

  if (!existsSync(join(dir, "hive.yml"))) return { fired: false, reason: "no hive.yml here" };

  const { activeProfile, DEFAULT_LEAD_BRANCHES, loadProjectYml } = await import("./projectYml.js");
  const { profileExists } = await import("./profiles.js");
  const { config, warnings } = loadProjectYml(dir);

  const silent = (reason: string): KickoffResult => ({ fired: false, reason, warnings });
  const profile = activeProfile(config);

  if (!profile) return silent("no profile in hive.yml");
  if (!profileExists(profile)) return silent(`profile "${profile}" is not on this machine`);

  const branch = currentBranch(dir);
  const leadBranches = config?.lead_branches ?? DEFAULT_LEAD_BRANCHES;
  if (branch != null && !leadBranches.includes(branch)) {
    return silent(`branch "${branch}" is not a lead branch (${leadBranches.join(", ")})`);
  }

  const context = await digest(dir, profile, warnings);
  if (context == null) return silent("not a registered hive project root");

  const build = (text: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: text,
        initialUserMessage: TRIAGE_MESSAGE,
      },
    });
  let payload = build(context);
  if (payload.length > OUTPUT_BUDGET) {

    const overflow = payload.length - OUTPUT_BUDGET;
    payload = build(truncate(context, Math.max(0, context.length - overflow - 32)));
  }
  return { fired: true, payload, warnings };
}

export async function runKickoff(argv: string[] = []): Promise<void> {
  const explain = argv.includes("--explain");
  let result: KickoffResult;
  try {
    result = await evaluate(process.cwd());
  } catch (e) {

    if (explain) console.log(`hive kickoff: silent (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }

  if (explain) for (const w of result.warnings ?? []) console.log(`! hive.yml: ${w}`);
  if (result.fired && result.payload) {
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
