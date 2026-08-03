import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Type-only: erased at compile time, so this costs nothing on the cold path
// every session start pays (unlike a value import of stateProvenance.js,
// which stays inside digest() below for that reason).
import type { ProvenanceRow } from "./stateProvenance.js";

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
  // hive.yml parse warnings, present once the file has been read. Absent for
  // the gates that decline before that (worker session, no hive.yml here):
  // nothing was parsed, so there is nothing to report. hive doctor is the
  // check that looks at a project's config from anywhere.
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
async function digest(projectPath: string, profile: string, warnings: string[]): Promise<string | null> {
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

  // Directly under the header, above everything that can grow. truncate cuts
  // from the end, so a warning placed here survives a board that fills the
  // whole budget; below the board it would be the first thing lost, and a
  // warning the lead never sees is no warning. `! ` matches what `hive lead`
  // and `hive start` print for the same messages.
  for (const w of warnings) lines.push(`! hive.yml: ${w}`);
  // Where the state sections start. "Nothing is in flight" is about the store,
  // so it must not be silenced by a warning having been pushed above it.
  const headerLines = lines.length;

  const board = getActivePadByName(project.id, "board");
  if (board) {
    lines.push("", "BOARD (top of the pad; pad_read for the rest)", truncate(board.content.trim(), BOARD_BUDGET));
  }

  // archived_at IS NULL throughout (#15): this digest is the first thing a
  // lead reads at cold boot, which is exactly when a closed lane's archived
  // scaffolding must stay invisible - the same reasoning as cmdStatus's
  // open-todos count in src/cli.ts.
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
      "SELECT name, actor_id, command, agent_state, state_changed_at, kind, tmux_target, cwd FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent' ORDER BY id",
    )
    .all(project.id) as (ProvenanceRow & { name: string; tmux_target: string; cwd: string })[];
  if (agents.length > 0) {
    // Rows only; liveness would mean shelling out to tmux on every session
    // start. hive doctor and agent_list are where dead rows get resolved, so
    // alive is passed as null (not probed) rather than guessed.
    const { deriveProvenance, describeForHuman } = await import("./stateProvenance.js");
    lines.push("", "WORKERS (per the store, NOT probed; agent_list to confirm they are alive)");
    for (const a of agents) {
      lines.push(`  ${a.name} [${describeForHuman(deriveProvenance(a, null))}] ${a.cwd}`);
    }
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
  // 1. A hive-spawned worker gets its brief from agent_spawn, not from this.
  // HIVE_LEAD, not HIVE_AGENT_ID alone: issue #27 gave the lead an agents row
  // too, so HIVE_AGENT_ID is now set for both. This still has to stay a plain
  // env check, not a database lookup - it is the check that keeps this hook
  // free in every unrelated directory on the machine, and it runs before
  // check 2 opens hive.yml, let alone the store two gates further down.
  //
  // === "1", not truthiness (issue #27's L4 fix round, DECISION 7a): a
  // worker's env carries HIVE_LEAD unset today, but a truthy check treats
  // ANY non-empty value as "this is the lead", including the literal string
  // "0" - the one value a future caller would most plausibly write meaning
  // false. That would let a worker past the one gate that exists specifically
  // to keep it from opening the store at all.
  if (process.env.HIVE_AGENT_ID && process.env.HIVE_LEAD !== "1") {
    return { fired: false, reason: "worker session (HIVE_AGENT_ID is set)" };
  }

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
  const { config, warnings } = loadProjectYml(dir);
  // Every gate from here on carries the warnings out, so `hive kickoff
  // --explain` can report a malformed hive.yml even for a session start that
  // declined.
  const silent = (reason: string): KickoffResult => ({ fired: false, reason, warnings });
  const profile = activeProfile(config);
  // Still silence, even when `warnings` is non-empty. A hive.yml broken badly
  // enough to lose its `profile` key is exactly the case where hive does not
  // know whether this directory is a lead checkout at all, and firing to
  // announce that would break the contract at the top of this file: a
  // teammate without the profile, on the wrong branch, or in an unrelated repo
  // must get nothing. `hive doctor` reports this one instead, from anywhere.
  if (!profile) return silent("no profile in hive.yml");
  if (!profileExists(profile)) return silent(`profile "${profile}" is not on this machine`);

  // 4. A lead branch. A worktree on a feature branch is a worker's, not a
  // lead's. A project outside git has no branch to be wrong about.
  const branch = currentBranch(dir);
  const leadBranches = config?.lead_branches ?? DEFAULT_LEAD_BRANCHES;
  if (branch != null && !leadBranches.includes(branch)) {
    return silent(`branch "${branch}" is not a lead branch (${leadBranches.join(", ")})`);
  }

  // 5. Registered, and this is its root. First gate that needs the store.
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
    // The digest is already capped, so only JSON escaping can push it over.
    // Trim the context and serialize again: slicing the finished JSON would
    // buy a length limit at the price of output Claude Code cannot parse.
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
    // A hook that fails is a hook that interrupts the human's session start.
    // Whatever went wrong (a locked store, a corrupt hive.yml), silence is
    // the correct output; hive doctor is where problems get reported.
    if (explain) console.log(`hive kickoff: silent (${e instanceof Error ? e.message : String(e)}).`);
    return;
  }
  // --explain is the human's only window into a hook that is silent by design,
  // so it reports a malformed hive.yml whether or not the kickoff fired. The
  // declined case is the one that matters: nothing else in that session says
  // anything at all. Printed above the payload rather than folded into it,
  // because the reader of --explain is a person, not Claude Code.
  if (explain) for (const w of result.warnings ?? []) console.log(`! hive.yml: ${w}`);
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
