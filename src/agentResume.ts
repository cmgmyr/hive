import { existsSync } from "node:fs";
import { db } from "./db.js";
import { getAgentRow, type AgentRow } from "./agentRecords.js";
import { getProject, type Project } from "./context.js";
import { workerCommandString } from "./brief.js";
import {
  codexHomeDir,
  codexLaunchArgs,
  ensureCodexHooksFile,
  refreshCodexMcpEnv,
} from "./codexHome.js";
import { agentIdentityEnv, branchAt, LEAD_KIND, resumeAgent, storedLaunchOptions } from "./spawn.js";
import { ensureWorkerHooksFile } from "./hooks.js";
import { harnessFor, resolvedCommandPrefix } from "./harnesses.js";
import { loadProjectYml } from "./projectYml.js";
import { limitedHarness, observeProjectUsageLimits } from "./usageLimit.js";
import { DEFAULT_LAYOUT } from "./tmux.js";

export interface ResumeWorkerResult {
  agent_id: number;
  actor_id: string;
  name: string;
  tmux_target: string;
  resumed_session_id: string;
  was_parked_at?: string;
  branch_drift?: { parked_branch: string; branch_now: string };
  landed_in_project?: string;
}

export interface ResumeWorkerValidation {
  project: Project;
  agent: AgentRow;
  harness: ReturnType<typeof harnessFor>;
  stateProblem?: string;
  blocker?: string;
}

export function refuseLimitedHarness(projectId: number, harness: string, action = "agent_spawn"): void {
  const now = Date.now();
  observeProjectUsageLimits(projectId, harness, now);
  const held = limitedHarness(projectId, harness, now);
  if (held) {
    throw new Error(
      `[${action}:usage-limit] ${harness} is stopped by a usage limit until ${held.until}. ` +
        `This ${action === "agent_resume" ? "resume" : action === "agent_fork" ? "fork" : "spawn"} was not queued; retry it after that time.`,
    );
  }
}

export function contextCheckpointEnv(config: { context_checkpoint_percent?: number | null } | null): Record<string, string> {
  const value = config?.context_checkpoint_percent;
  return value == null ? {} : { HIVE_CONTEXT_CHECKPOINT_PERCENT: String(value) };
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function extractCommandFlag(command: string, flag: string): string | undefined {
  const tokens = commandTokens(command);
  const i = tokens.indexOf(flag);
  return i === -1 || i + 1 >= tokens.length ? undefined : tokens[i + 1];
}

function stripSessionArgs(args: string[]): string[] {
  const stripped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--resume" || arg === "--session-id" || arg === "-r") {
      i++;
    } else if (arg === "--last" || arg === "--fork-session" || arg.startsWith("--resume=") || arg.startsWith("--session-id=")) {
      continue;
    } else {
      stripped.push(arg);
    }
  }
  return stripped;
}

export function validateResumeWorker(
  project: Project,
  agent: AgentRow,
  options: { parentActor?: string | null; recoveryOnly?: boolean },
): ResumeWorkerValidation {
  const harness = harnessFor(agent.command);

  let stateProblem: string | undefined;
  let blocker: string | undefined;
  if (agent.status !== "closed") {
    stateProblem = `Agent ${agent.id} ("${agent.name}") is not closed (status: ${agent.status}).`;
  } else if (agent.kind === LEAD_KIND) {
    stateProblem = `Agent ${agent.id} ("${agent.name}") is this project's lead session. agent_resume is for workers; start a lead session with \`hive lead\`.`;
  } else if (options.recoveryOnly && (agent.recovery_state !== "pending" || agent.parked_at)) {
    stateProblem = "row is not marked for crash recovery";
  } else if (!harness.supportsResume) {
    blocker =
      `Agent ${agent.id} ("${agent.name}")'s harness ("${harness.name}", command: "${agent.command}") ` +
      "does not support resume, so it has no session id to resume from.";
  } else if (!agent.session_id) {
    blocker =
      `Agent ${agent.id} ("${agent.name}") has no recorded session id, so it cannot be resumed. It may ` +
      "predate this feature, or it may have closed before its first hook event ever fired. Spawn a new worker instead.";
  } else if (harness.name === "codex" && !agent.codex_home) {
    blocker =
      `Agent ${agent.id} ("${agent.name}") has no recorded CODEX_HOME, so its session cannot be resumed. ` +
      (agent.parked_at
        ? "This should not happen for a parked codex worker - its home is only reaped on agent_close. Check agent_status for how it actually got here."
        : "Its Codex home was released after close, so there is nothing here to resume; spawn a new worker instead.");
  } else if (!agent.cwd || !existsSync(agent.cwd)) {
    const recreate = agent.parked_branch
      ? `git worktree add ${agent.cwd} ${agent.parked_branch}`
      : `recreate a checkout at ${agent.cwd || "(empty)"} (no branch was recorded for it - agent_park records one)`;
    const reason = harness.name === "codex" ? "It resumes into that directory as its working directory" : "Its transcript is resolved from that path";
    blocker =
      `Agent ${agent.id} ("${agent.name}")'s working directory is gone: ${agent.cwd || "(empty)"}. ${reason}, ` +
      `so recreate it and the resume works unchanged: ${recreate}`;
  } else if (options.recoveryOnly && options.parentActor == null) {
    blocker = "no recorded parent actor for recovery placement";
  } else if (options.recoveryOnly && harness.name === "codex" && !existsSync(codexHomeDir(agent.codex_home!))) {
    blocker = "Codex home is missing";
  } else {
    const running = db
      .prepare("SELECT id, name FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
      .all(project.id) as { id: number; name: string }[];
    const collision = running.find((row) => row.id !== agent.id && row.name.toLowerCase() === agent.name.toLowerCase());
    if (collision) {
      blocker = options.recoveryOnly
        ? "a running worker already uses this name"
        : `Cannot resume agent ${agent.id} ("${agent.name}") under its recorded name: a running agent ` +
          `(agent ${collision.id}) already has it. agent_resume does not rename on your behalf - the ` +
          `${agent.parked_at ? "parked" : "closed"} lane is not lost, it just cannot come back under a name ` +
          "someone else is using. Free the name first (agent_rename or agent_close on the running one), " +
          `then retry agent_resume(agent_id: ${agent.id}).`;
    }
  }

  return { project, agent, harness, stateProblem, blocker };
}

export async function resumeWorker(
  projectId: number,
  agentId: number,
  options: { parentActor: string; recoveryOnly?: boolean },
): Promise<ResumeWorkerResult> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} is no longer registered.`);
  const agent = getAgentRow(project.id, agentId, "Call agent_list(include_closed: true).");
  const validation = validateResumeWorker(project, agent, options);
  const resumeHarness = validation.harness;
  if (validation.stateProblem) throw new Error(validation.stateProblem);
  refuseLimitedHarness(project.id, validation.harness.name, "agent_resume");
  if (validation.blocker) throw new Error(validation.blocker);

  const branchNow = agent.parked_branch ? branchAt(agent.cwd) : "";
  const branchDrift = branchNow && branchNow !== agent.parked_branch
    ? { parked_branch: agent.parked_branch, branch_now: branchNow }
    : undefined;
  const { config: projectConfig } = loadProjectYml(project.path);
  const placement = projectConfig?.placement ?? (process.env.HIVE_SPAWN_PLACEMENT === "window" ? "window" : "split");
  const layout = projectConfig?.layout ?? DEFAULT_LAYOUT;
  const launchOptions = storedLaunchOptions(agent.extra_args);
  let commandString: string;
  let resumeEnv: Record<string, string> = contextCheckpointEnv(projectConfig);

  if (resumeHarness.name === "codex") {
    commandString = workerCommandString({
      command: resolvedCommandPrefix(agent.command) || "codex",
      model: agent.model ?? extractCommandFlag(agent.command, "--model"),
      displayName: agent.name,
      extraArgs: [
        ...codexLaunchArgs(agent.cwd, launchOptions.readOnly),
        ...stripSessionArgs(launchOptions.args),
        "resume",
        agent.session_id,
      ],
    });
    resumeEnv = { ...resumeEnv, CODEX_HOME: codexHomeDir(agent.codex_home!) };
    ensureCodexHooksFile(agent.codex_home!, { includePostToolUse: projectConfig?.context_checkpoint_percent != null });
    refreshCodexMcpEnv(agent.codex_home!, agentIdentityEnv(agent.actor_id, agent.name, project.path));
  } else {
    commandString = workerCommandString({
      command: resolvedCommandPrefix(agent.command) || "claude",
      displayName: agent.name,
      model: agent.model ?? undefined,
      extraArgs: [...stripSessionArgs(launchOptions.args), "--resume", agent.session_id],
      settingsPath: ensureWorkerHooksFile(agent.id, {
        readOnly: launchOptions.readOnly,
        includePostToolUse: projectConfig?.context_checkpoint_percent != null,
      }),
    });
  }

  const { target, landedInProjectId } = resumeAgent({
    agentId: agent.id,
    actorId: agent.actor_id,
    name: agent.name,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    cwd: agent.cwd,
    commandString,
    env: resumeEnv,
    placement,
    layout,
    parentActor: options.parentActor,
    recoveryOnly: options.recoveryOnly,
  });

  return {
    agent_id: agent.id,
    actor_id: agent.actor_id,
    name: agent.name,
    tmux_target: target,
    resumed_session_id: agent.session_id,
    ...(agent.parked_at ? { was_parked_at: agent.parked_at } : {}),
    ...(branchDrift ? { branch_drift: branchDrift } : {}),
    ...(landedInProjectId != null ? { landed_in_project: getProject(landedInProjectId)?.name ?? `project ${landedInProjectId}` } : {}),
  };
}

