import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// SessionStart entry point. This runs on EVERY session start in EVERY
// directory on the machine, so it is built to say nothing as fast as
// possible: the cheap file and git checks come first, and the database is
// only opened once a directory has proven it is a hive lead checkout.
//
// Silence is the contract. hive.yml is committed, so a teammate without the
// profile it names, or a session on a feature branch, must get no output and
// no error -- just a note from hive doctor.

// Claude Code caps hook output (additionalContext, systemMessage, plain
// stdout) at 10,000 characters and spills the rest to a file. Everything
// below is budgeted to stay well inside that.
export const OUTPUT_BUDGET = 10_000;
const CONTEXT_BUDGET = 6_000;
const BOARD_BUDGET = 1_800;

export interface KickoffResult {
  fired: boolean;
  // Why it stayed silent, for `hive kickoff --explain` and the tests. Never
  // printed during a real session start.
  reason?: string;
  payload?: string;
}

function currentBranch(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a git repo, or no commits yet.
    return null;
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n[truncated]`;
}

// The live digest. Imported lazily by run() so a directory that fails an
// earlier gate never opens the store.
async function digest(projectPath: string, profile: string): Promise<string | null> {
  const { migrate, db } = await import("./db.js");
  const { findProjectForCwd } = await import("./context.js");
  const { ACTIVE_TIMER_WHERE } = await import("./scheduler.js");
  const { getActivePadByName } = await import("./tools/pads.js");
  const { OPEN_BLOCKERS_SQL } = await import("./tools/todos.js");
  migrate();

  // Registered, and the session is at its root. A worktree resolves to the
  // primary checkout's project, so this is what keeps the kickoff off
  // worker checkouts even when they sit on a lead branch.
  const project = findProjectForCwd();
  if (!project || project.path !== projectPath) return null;

  const lines: string[] = [`[hive] Project "${project.name}" (profile: ${profile}).`];

  const board = getActivePadByName(project.id, "board");
  if (board) {
    lines.push("", "BOARD (top of the pad; pad_read for the rest)", truncate(board.content.trim(), BOARD_BUDGET));
  }

  const inFlight = db
    .prepare(
      "SELECT id, title, status FROM todos WHERE project_id = ? AND status = 'in_progress' ORDER BY updated_at DESC LIMIT 10",
    )
    .all(project.id) as { id: number; title: string; status: string }[];
  const ready = db
    .prepare(
      `SELECT id, title FROM todos t
       WHERE t.project_id = ? AND t.status = 'open'
         AND NOT EXISTS (${OPEN_BLOCKERS_SQL})
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, id
       LIMIT 10`,
    )
    .all(project.id) as { id: number; title: string }[];
  const blocked = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM todos t
         WHERE t.project_id = ? AND t.status IN ('open', 'in_progress')
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
      "SELECT name, agent_state, tmux_target, cwd FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent' ORDER BY id",
    )
    .all(project.id) as { name: string; agent_state: string; tmux_target: string; cwd: string }[];
  if (agents.length > 0) {
    // Rows only; liveness would mean shelling out to tmux on every session
    // start. hive doctor and agent_list are where dead rows get resolved.
    lines.push("", "WORKERS (per the store; agent_list confirms they are alive)");
    for (const a of agents) lines.push(`  ${a.name} [${a.agent_state}] ${a.cwd}`);
  }

  const wakes = db
    .prepare(`SELECT COUNT(*) AS n FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`)
    .get(project.id) as { n: number };
  if (wakes.n > 0) lines.push("", `WAKE-UPS: ${wakes.n} pending (wake_list for detail).`);

  if (lines.length === 1) lines.push("", "The store is empty for this project. Nothing is in flight.");
  lines.push("", "Standing process for this project: run `hive runbook`.");

  return truncate(lines.join("\n"), CONTEXT_BUDGET);
}

const TRIAGE_MESSAGE =
  "Start with morning triage. Run `hive runbook` for this project's standing process, then " +
  "reconcile the state hive just injected against what is really there (agent_list, todo_list, " +
  "wake_list) and report it in a few lines. Propose today's lanes and confirm them with me before " +
  "dispatching anything.";

export async function evaluate(cwd: string): Promise<KickoffResult> {
  // 1. A hive-spawned worker gets its brief from agent_spawn, not from this.
  if (process.env.HIVE_AGENT_ID) return { fired: false, reason: "worker session (HIVE_AGENT_ID is set)" };

  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return { fired: false, reason: "cwd does not exist" };
  }

  // 2. No hive.yml, no kickoff. This is the check that keeps the hook free
  // in every unrelated directory: it runs before the store is opened.
  if (!existsSync(join(dir, "hive.yml"))) return { fired: false, reason: "no hive.yml here" };

  // 3. A profile this machine actually has. A hive.yml naming one it does
  // not is silence, not an error.
  //
  // Everything below is imported lazily for the same reason the store is:
  // projectYml pulls in the YAML parser, which is ~15ms of module evaluation
  // that every directory on the machine would otherwise pay to reach a
  // decision the two checks above already made.
  const { activeProfile, DEFAULT_LEAD_BRANCHES, loadProjectYml } = await import("./projectYml.js");
  const { profileExists } = await import("./profiles.js");
  const { config } = loadProjectYml(dir);
  const profile = activeProfile(config);
  if (!profile) return { fired: false, reason: "no profile in hive.yml" };
  if (!profileExists(profile)) return { fired: false, reason: `profile "${profile}" is not on this machine` };

  // 4. A lead branch. A worktree on a feature branch is a worker's, not a
  // lead's. A project outside git has no branch to be wrong about.
  const branch = currentBranch(dir);
  const leadBranches = config?.lead_branches ?? DEFAULT_LEAD_BRANCHES;
  if (branch != null && !leadBranches.includes(branch)) {
    return { fired: false, reason: `branch "${branch}" is not a lead branch (${leadBranches.join(", ")})` };
  }

  // 5. Registered, and this is its root. First gate that needs the store.
  const context = await digest(dir, profile);
  if (context == null) return { fired: false, reason: "not a registered hive project root" };

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
    // The digest is already capped, so only JSON escaping can push it over.
    // Trim the context and serialize again: slicing the finished JSON would
    // buy a length limit at the price of output Claude Code cannot parse.
    const overflow = payload.length - OUTPUT_BUDGET;
    payload = build(truncate(context, Math.max(0, context.length - overflow - 32)));
  }
  return { fired: true, payload };
}

export async function runKickoff(argv: string[] = []): Promise<void> {
  const explain = argv.includes("--explain");
  let result: KickoffResult;
  try {
    result = await evaluate(process.cwd());
  } catch (e) {
    // A hook that fails is a hook that interrupts the human's session start.
    // Whatever went wrong (a locked store, a corrupt hive.yml), silence is
    // the correct output; hive doctor is where problems get reported.
    if (explain) console.log(`hive kickoff: silent (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }
  if (result.fired && result.payload) {
    process.stdout.write(result.payload);
    if (explain) process.stdout.write("\n");
    return;
  }
  if (explain) console.log(`hive kickoff: silent (${result.reason}).`);
}

// Direct entry. The plugin's SessionStart hook runs this file rather than
// cli.js, whose top-level imports would open the store in every directory on
// the machine before a single gate had been evaluated.
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
