import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitPrimaryRoot } from "./context.js";
import { storeDir } from "./dataDir.js";
import { carriesNameFlag, harnessFor, harnessNames } from "./harnesses.js";
import { agentVarKeys } from "./projectYml.js";
import { readProfileFile, renderTemplate } from "./profiles.js";
import { withTrailingNewline } from "./result.js";
import { shellQuote } from "./tmux.js";

// A pure git fact, not a convention hive owns: gitPrimaryRoot asks git directly with no
// containment, and resolves the same primary checkout whether cwd is that checkout or a linked
// worktree of it. What a project keeps there (a session corpus, local notes, nothing at all) is a
// profile's business, never core's - see docs/patterns.md.
export function primaryRoot(cwd: string): string | null {
  const root = gitPrimaryRoot(cwd);
  return root ? `${root}/` : null;
}

export interface BriefContext {
  name: string;
  actorId: string;
  projectName: string;
  projectPath: string;
  cwd: string;

  profile?: string | null;
  vars?: Record<string, string>;
}

function briefVars(ctx: BriefContext): Record<string, string> {
  const root = primaryRoot(ctx.cwd);
  return {
    ...(ctx.vars ?? {}),
    agent_name: ctx.name,
    actor_id: ctx.actorId,
    project_name: ctx.projectName,
    project_path: ctx.projectPath,
    cwd: ctx.cwd,
    ...(root ? { primary_root: root } : {}),
  };
}

const WAIT_FOR_ASSIGNMENT = "Run whoami to confirm scope, then wait for your assignment.";

// harness_claude is the default for anything that is not codex, not an equality check against
// "claude" - a presence-conditional has no else, so an unrecognised harness still needs one.
export function harnessBriefVars(harnessName: string): Record<string, string> {
  return harnessName === "codex" ? { harness_codex: "1" } : { harness_claude: "1" };
}

// Derived from harnessNames() rather than a hand-kept literal, so a newly registered harness
// extends the strip set with no edit here (todo 597 review finding).
function harnessVarKeys(): string[] {
  return harnessNames().map((name) => `harness_${name}`);
}

// Strips harness_* and agents_* reserved keys before spreading harnessBriefVars - strip only,
// worker.md never gets an agents_* value, since nothing needs one there yet.
export function mergedBriefVars(
  projectVars: Record<string, string> | undefined,
  harnessName: string,
): Record<string, string> {
  const safe = { ...(projectVars ?? {}) };
  for (const key of [...harnessVarKeys(), ...agentVarKeys()]) delete safe[key];
  return { ...safe, ...harnessBriefVars(harnessName) };
}

export function workerBrief(ctx: BriefContext): string {
  if (ctx.profile) {
    const template = readProfileFile(ctx.profile, "worker.md");
    if (template != null) return `${renderTemplate(template, briefVars(ctx)).trimEnd()}\n\n${WAIT_FOR_ASSIGNMENT}`;
  }
  return defaultWorkerBrief(ctx);
}

function defaultWorkerBrief(ctx: BriefContext): string {
  return `[HIVE CONTEXT]
You are agent "${ctx.name}" (actor id: ${ctx.actorId}) in project "${ctx.projectName}" (${ctx.projectPath}).
This session is locked to this project (HIVE_PROJECT_LOCK=1); do not try to access other projects.
Coordinate through the hive MCP tools:
- whoami confirms your identity and scope.
- pad_list / pad_read for the shared plan and findings. Record decisions there.
- todo_list(is_blocked=false, status="open") for dispatchable work; set status to in_progress while working.
- todo_comment for handoffs (changed files, tests run, remaining risk), then todo_complete.
- lease_acquire before editing shared file areas; leases expire on their own.
If the hive MCP tools are unavailable in this session, write progress and results to stdout; the orchestrator will read your terminal.
${WAIT_FOR_ASSIGNMENT}
[END HIVE CONTEXT]`;
}

const briefsDir = () => join(storeDir(), "briefs");

export const agentBriefPath = (agentId: number) => join(briefsDir(), `agent-${agentId}.md`);

export function writeAgentBrief(agentId: number, text: string): string {
  const path = agentBriefPath(agentId);
  mkdirSync(briefsDir(), { recursive: true });
  writeFileSync(path, withTrailingNewline(text));
  return path;
}

export function readAgentBrief(agentId: number): string | null {
  try {
    return readFileSync(agentBriefPath(agentId), "utf8");
  } catch {
    return null;
  }
}

const posturesDir = () => join(storeDir(), "postures");

export const projectPosturePath = (projectId: number) =>
  join(posturesDir(), `project-${projectId}.md`);

export function writeProjectPosture(projectId: number, text: string): string {
  const path = projectPosturePath(projectId);
  mkdirSync(posturesDir(), { recursive: true });
  writeFileSync(path, withTrailingNewline(text));
  return path;
}

export interface WorkerCommandSpec {
  command: string;
  model?: string;
  extraArgs?: string[];

  settingsPath?: string;
  briefPath?: string;

  displayName?: string;
}

export { isClaudeCommand } from "./harnesses.js";

export function workerCommandString(spec: WorkerCommandSpec): string {
  const harness = harnessFor(spec.command);

  const namedByCaller = carriesNameFlag(spec.extraArgs ?? []);

  return [
    // Split, not passed whole: spec.command can itself be multiple tokens (a wrapped command,
    // e.g. "nice claude", todo 521) and shellQuote would otherwise glue the lot into one token a
    // shell can't exec. Byte-identical for every single-token command - see
    // test/worker-brief.test.mjs's negative control.
    ...spec.command.trim().split(/\s+/),
    ...(spec.model ? ["--model", spec.model] : []),
    ...harness.argsFor({ displayName: spec.displayName, namedByCaller }),

    ...(harness.briefDelivery && spec.settingsPath ? harness.briefDelivery.settingsArgs(spec.settingsPath) : []),
    ...(harness.briefDelivery && spec.briefPath ? harness.briefDelivery.systemPromptArgs(spec.briefPath) : []),
    ...(spec.extraArgs ?? []),
  ]
    .map(shellQuote)
    .join(" ");
}
