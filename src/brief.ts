import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeDir } from "./dataDir.js";
import { harnessFor } from "./harnesses.js";
import { readProfileFile, renderTemplate } from "./profiles.js";
import { withTrailingNewline } from "./result.js";
import { shellQuote } from "./tmux.js";

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
  return {
    ...(ctx.vars ?? {}),
    agent_name: ctx.name,
    actor_id: ctx.actorId,
    project_name: ctx.projectName,
    project_path: ctx.projectPath,
    cwd: ctx.cwd,
  };
}

const WAIT_FOR_ASSIGNMENT = "Run whoami to confirm scope, then wait for your assignment.";

// harness_claude is the default for anything that is not codex, not an equality check against
// "claude" - a presence-conditional has no else, so an unrecognised harness still needs one.
export function harnessBriefVars(harnessName: string): Record<string, string> {
  return harnessName === "codex" ? { harness_codex: "1" } : { harness_claude: "1" };
}

const HARNESS_VAR_KEYS = ["harness_claude", "harness_codex"] as const;

// Strips both reserved keys before spreading harnessBriefVars, so a project's own hive.yml
// cannot set the sibling key and make both worker.md blocks render at once.
export function mergedBriefVars(
  projectVars: Record<string, string> | undefined,
  harnessName: string,
): Record<string, string> {
  const safe = { ...(projectVars ?? {}) };
  for (const key of HARNESS_VAR_KEYS) delete safe[key];
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

  const namedByCaller = (spec.extraArgs ?? []).some(
    (arg) =>
      arg === "--name" || arg.startsWith("--name=") || (arg.startsWith("-n") && !arg.startsWith("--")),
  );

  return [
    spec.command,
    ...(spec.model ? ["--model", spec.model] : []),
    ...harness.argsFor({ displayName: spec.displayName, namedByCaller }),

    ...(harness.briefDelivery && spec.settingsPath ? harness.briefDelivery.settingsArgs(spec.settingsPath) : []),
    ...(harness.briefDelivery && spec.briefPath ? harness.briefDelivery.systemPromptArgs(spec.briefPath) : []),
    ...(spec.extraArgs ?? []),
  ]
    .map(shellQuote)
    .join(" ");
}
