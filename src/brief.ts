import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./dataDir.js";
import { readProfileFile, renderTemplate } from "./profiles.js";
import { withTrailingNewline } from "./result.js";
import { shellQuote } from "./tmux.js";

// The worker bootstrap, in two halves.
//
// The brief is the authoritative text and rides in the system prompt via
// --append-system-prompt-file: prompt-cached, uncompactable, impossible for
// the lead to forget. But an appended system prompt is invisible in the TUI
// and absent from the transcript, so hive owes the human an audit trail of
// its own: the copy it wrote for this agent stays on disk, and a short line
// naming the agent is typed into the pane as the visible first turn.
//
// This module deliberately imports dataDir.js rather than db.js; resolving a
// brief path must not open or migrate a store.

export interface BriefContext {
  name: string;
  actorId: string;
  projectName: string;
  projectPath: string;
  cwd: string;
  // The project's profile, when it has one, and its hive.yml vars. A project
  // without a profile keeps the built-in brief below.
  profile?: string | null;
  vars?: Record<string, string>;
}

// Agent identity is addressable in worker.md the same way project vars are.
// Identity wins: a project cannot redefine which agent this is.
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

export function workerBrief(ctx: BriefContext): string {
  if (ctx.profile) {
    const template = readProfileFile(ctx.profile, "worker.md");
    if (template != null) return renderTemplate(template, briefVars(ctx)).trimEnd();
  }
  return defaultWorkerBrief(ctx);
}

// The fallback for a project with no profile, and for a profile that ships no
// worker.md. Every worker gets a brief, profile or not.
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
[END HIVE CONTEXT]`;
}

// One line, typed into the pane and submitted as the first user turn. Keep it
// to a single line: it is sent with send-keys -l, before claude has had time
// to enable bracketed paste.
export function paneAnnouncement(ctx: BriefContext): string {
  return `[hive] You are "${ctx.name}" (${ctx.actorId}) in project "${ctx.projectName}", cwd ${ctx.cwd}. Your full brief is loaded in the system prompt. Run whoami to confirm scope, then wait for your assignment.`;
}

const briefsDir = () => join(dataDir, "briefs");

export const agentBriefPath = (agentId: number) => join(briefsDir(), `agent-${agentId}.md`);

// Written per agent, not once per machine: the text names the agent, and the
// copy on disk is what agent_status reports long after the pane is gone.
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

// The lead's posture, same shape one level up: a rendered system-prompt file
// on disk, keyed by project instead of by agent.
//
// It has to be rendered somewhere, because --append-system-prompt-file takes
// a path and the file in the profile still holds its {{vars}}. One file per
// project, overwritten on every `hive lead`: the set is bounded by how many
// projects you have, the content is derived, and a stale copy from a deleted
// project costs a few hundred bytes. Nothing sweeps them, deliberately.
const posturesDir = () => join(dataDir, "postures");

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
  // Both flags are claude's; other agent commands get the bare command.
  settingsPath?: string;
  briefPath?: string;
}

// --settings and --append-system-prompt-file are claude's alone, so every
// caller that adds one has to answer this the same way. The command may carry
// arguments and may be an absolute path: `lead: /opt/homebrew/bin/claude
// --model opus` is still claude.
export function isClaudeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.split("/").pop() === "claude";
}

export function workerCommandString(spec: WorkerCommandSpec): string {
  const isClaude = isClaudeCommand(spec.command);
  return [
    spec.command,
    ...(spec.model ? ["--model", spec.model] : []),
    // State hooks (working/idle/waiting) ride along via --settings; the brief
    // rides along as an appended system prompt.
    ...(isClaude && spec.settingsPath ? ["--settings", spec.settingsPath] : []),
    ...(isClaude && spec.briefPath ? ["--append-system-prompt-file", spec.briefPath] : []),
    ...(spec.extraArgs ?? []),
  ]
    .map(shellQuote)
    .join(" ");
}
