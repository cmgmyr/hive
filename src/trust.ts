import { db } from "./db.js";
import { configHash } from "./projectYml.js";

// hive.yml is repo-controlled, so anything in it that steers what happens on
// this machine needs the human's approval once, and again whenever it
// changes. `lead:` and `processes:` already work this way because hive
// EXECUTES them. `vars:` needs it because hive SUBSTITUTES them into the
// lead's posture and every worker's brief, both delivered as system prompts:
// a checkout you have not read could otherwise put arbitrary standing
// instructions in front of a model that runs shell commands, with no prompt
// anywhere. Same table, same hash-on-change rule.
//
// This does not make an untrusted checkout safe to open. Claude Code loads a
// repo's own CLAUDE.md as project context regardless of hive, which is a
// wider channel that hive cannot close. What it does is keep hive itself from
// being the thing that promotes repo text into a system prompt unasked.

// Sorted, so reordering keys in hive.yml is not a change of trust.
function varsFingerprint(vars: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)));
  return configHash("vars", JSON.stringify(sorted), null, {});
}

export function varsAreTrusted(projectId: number, vars: Record<string, string>): boolean {
  // Nothing to smuggle: an empty set renders identically either way.
  if (Object.keys(vars).length === 0) return true;
  return (
    db
      .prepare("SELECT 1 FROM command_trust WHERE project_id = ? AND name = 'vars' AND config_hash = ?")
      .get(projectId, varsFingerprint(vars)) != null
  );
}

export function trustVars(projectId: number, vars: Record<string, string>): void {
  db.prepare(
    "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, 'vars', ?)",
  ).run(projectId, varsFingerprint(vars));
}

// What every substitution site should render with. Untrusted vars are dropped
// rather than rejected, which lands on the semantics profiles already have
// for a var that is not set: {{name}} stays visible and <!--if:name-->
// sections disappear. The caller reports `trusted` so the human hears why.
export function renderableVars(
  projectId: number,
  vars: Record<string, string> | undefined,
): { vars: Record<string, string>; trusted: boolean } {
  const declared = vars ?? {};
  const trusted = varsAreTrusted(projectId, declared);
  return { vars: trusted ? declared : {}, trusted };
}

export const UNTRUSTED_VARS_NOTE =
  "hive.yml vars are not approved yet, so they are left unsubstituted. Run hive interactively in this project to review them.";
