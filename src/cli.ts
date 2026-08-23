#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { checkAbi, describeAbi, describeInterpreter, nodeRangeForNodeApi, requiredNodeApi } from "./abi.js";
import { versionInfo } from "./version.js";
import { claudeConfigDir } from "./claudeDir.js";
import {
  ATTACH_MODES,
  AUTO_ATTACH_MODES,
  attachMode,
  AttachMode,
  AutoAttach,
  isAttachMode,
  isAutoAttach,
  resolvedAttachMode,
  resolvedAutoAttach,
  setAttachMode,
  setAutoAttach,
} from "./config.js";
import {
  cliPath,
  dispatcherDir,
  dispatcherPath,
  dispatcherScript,
  durabilityLines,
  firstHiveOnPath,
  pathAdvice,
  readDispatcher,
} from "./dispatcher.js";
import {
  hiveRegistrations,
  registrationOffer,
  registrationProblem,
  type McpRegistration,
} from "./mcpConfig.js";
import { DEFAULT_DATA_DIR } from "./dataDir.js";
import { dataDir, db, migrate } from "./db.js";
import { isLowHeadroom, orphanLoginShellDetails, ptyHeadroom } from "./ptys.js";
import {
  agentProjectPin,
  currentActor,
  effectiveProjectId,
  findProjectForCwd,
  getProject,
  listProjects,
  takeRegistrationNotice,
  type Project,
} from "./context.js";
import { ensureHooksFile } from "./hooks.js";
import { errorMessage, parseTags, registrationNoticeText, withTrailingNewline } from "./result.js";
import {
  ACTIVE_TIMER_WHERE,
  dashboardFileContained,
  describeStall,
  HELD_REASON_CONVERSATION,
  HELD_REASON_LEAD_PANE_DEAD,
  HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX,
  isUnclassifiablePaneHold,
  HELD_REASON_UNSUBMITTED_INPUT_PREFIX,
  isUnsubmittedInputHold,
  janitor,
  resolveDashboardDir,
  STALL_BOUND_SECONDS,
  transcriptStaleness,
  wasHeldForPaneReissue,
} from "./scheduler.js";
import {
  probeSessionInterpreter,
  reexecTarget,
  type ReexecTarget,
  sessionStartVerdict,
} from "./sessionProbe.js";
import {
  backupHealth,
  backupNow,
  backupsDir,
  formatBytes,
  listSnapshots,
  previewRestore,
  restoreSnapshot,
  totalSizeBytes,
} from "./backup.js";
import {
  describeTeardownWindow,
  readTeardowns,
  teardownLogPath,
  type TeardownMember,
  type TeardownRecord,
} from "./teardown.js";
import {
  asNameClash,
  buildEnvFlags,
  closeAgentRow,
  isReservedAgentName,
  launchAgent,
  LEAD_KIND,
  LEAD_NAME,
  mintLeadActorId,
  upsertActor,
  withWindowClaim,
} from "./spawn.js";
import {
  adoptableWindow,
  claimInitialWindow,
  configureHiveWindow,
  controlModeFor,
  createWindow,
  describePaneChoice,
  ensureSession,
  findProjectWindow,
  foreignSocket,
  inputBoxState,
  isPaneTarget,
  isViewSessionName,
  listOwnedWindows,
  ORPHAN_MIN_AGE_MS,
  type OrphanScratchServers,
  orphanScratchServers,
  orphansWorthWarningAbout,
  paneChoiceCheck,
  panePid,
  RAW_ATTACH_TMUX_CONFIG,
  renderAttachCommand,
  resolveAttachTarget,
  resolveInTmuxTarget,
  paneReissued,
  rowLive,
  rowLiveProbe,
  SESSION_PREFIX,
  sessionName,
  shellQuote,
  tmux,
  TMUX_DOC,
  tmuxSaysNothingThere,
  tmuxTimeoutOverride,
  tmuxSocketPath,
  untrustedTmuxServer,
} from "./tmux.js";
import {
  activeProfile,
  configHash,
  loadProjectYml,
  NO_PROFILE,
  resolveCommandDir,
  type YmlProcess,
} from "./projectYml.js";
import { writeProjectPosture } from "./brief.js";
import { harnessFor } from "./harnesses.js";
import {
  ageSecondsSince,
  deriveProvenance,
  describeForHuman,
  describeLastLogEvent,
  humanizeAge,
  lastLogEvent,
  lastPermissionMode,
  reportsAgentStateLog,
  type ProvenanceRow,
} from "./stateProvenance.js";
import { awaitingFirstPromptSql } from "./firstPrompt.js";
import {
  checkoutRoot,
  createProfile,
  forkProfile,
  PROFILE_FILES,
  ProfileError,
  profileExists,
  profileFileNames,
  profileNames,
  profileStatus,
  readProfileFile,
  referencedPads,
  referencedPaths,
  renderProfileFile,
  resolveProfileFile,
  REWRITE_THRESHOLD,
  templateVars,
  userProfilesDir,
  type ProfileFile,
  type ProfileFileStatus,
} from "./profiles.js";
import {
  COMMENT_COUNT_SQL,
  getTodoDetail,
  listTodoSummaries,
  OPEN_BLOCKERS_SQL,
  TODO_STATUSES,
  type TodoDetail,
} from "./tools/todos.js";
import {
  createPad,
  getActivePadByName,
  listActivePads,
  overwritePadContent,
} from "./tools/pads.js";

function usage(): never {
  console.log(`hive — shared memory and coordination for Claude Code sessions

Usage:
  hive --version              version, short sha, and dirty marker for this build
  hive [path]                open the project's session with a lead window
  hive lead [path] [--no-dashboard]
                             same; lead is the default command. --no-dashboard
                             skips this run's dashboard auto-open -
                             scripts/restart-lead.sh passes it; a human rarely
                             needs to
  hive init [path] [--profile <name>|--no-profile]
                             set the project up: hive.yml, profile, starter pads
  hive attach [path]         attach without adding windows
  hive start <process> [path] start one hive.yml process by name
  hive status                overview of agents, todos, and wake-ups everywhere
  hive setup [--dir <dir>]   write a \`hive\` that runs the interpreter this build
                             was compiled for; re-run after every update
  hive setup --attach <mode> auto|raw|control: whether tmux attaches carry -CC
  hive doctor [--strict] [--verbose]
                             check the environment and clean up stale state;
                             --strict also exits non-zero on warnings that mean
                             this install is wrong (dispatcher, registration, ABI);
                             --verbose adds per-worker pane detail (last log
                             event, permission mode, pane tail), collapsed to
                             one line by default
  hive pads                  list the current project's pads
  hive pad <name>            print a pad's content
  hive pad <name> --edit     export to a temp file and open your markdown editor
  hive pad <name> --save     write the edited export back (revision-guarded)
  hive todos [--all] [--status <s>] [--tag <t>]
                             list this project's todos; open work by default
  hive todo <id>             print one todo in full, comments included
  hive backups               list automatic store snapshots
  hive restore <name> [--yes] [--force]  overwrite the live store from a snapshot
  hive runbook               this project's standing process, vars resolved
  hive posture               the posture text this project's lead starts with
  hive kickoff [--explain]   SessionStart hook output; silent unless this is a lead checkout
  hive profile [list|path|fork|create|read]  standing instructions shared across projects
  hive statusline            one-line store summary; silent outside hive projects

hive lead reads hive.yml from the project root when present; hive init
writes this starter file (uncomment what you need):

${HIVE_YML_TEMPLATE.trimEnd().replace(/^/gm, "  ")}

Repo-defined commands run only after a one-time interactive approval; any
change to a command re-requires it. By default (attach mode auto), lead/attach
use iTerm's control mode: the lead, workers, and commands all appear as native
windows and panes. hive setup --attach raw switches to a plain tmux attach;
raw mode works without tmux config; one global notification setting is recommended
for Claude Code panes hive did not create (see docs/tmux.md).`);
  process.exit(1);
}

function resolveProjectAndNotify(id: number, onNotice?: (text: string) => void): Project {
  const project = getProject(id)!;
  const notice = takeRegistrationNotice();

  if (notice) {
    const text = registrationNoticeText(notice);
    if (onNotice) onNotice(text);
    else console.error(text);
  }
  return project;
}

function resolveProject(path?: string, onNotice?: (text: string) => void): Project {
  if (!path) return resolveProjectAndNotify(effectiveProjectId(), onNotice);
  process.chdir(path);
  const pinned = agentProjectPin();
  if (pinned == null) return resolveProjectAndNotify(effectiveProjectId(), onNotice);
  const target = findProjectForCwd();
  if (target != null && target.id === pinned) return target;
  const pinnedProject = getProject(pinned)!;
  throw new Error(
    `This session is locked to project ${pinned} ("${pinnedProject.name}") but "${path}" resolves to ${
      target ? `project ${target.id} ("${target.name}")` : "no registered project"
    }. An explicit path argument cannot escape HIVE_PROJECT_LOCK=1. Unset HIVE_AGENT_ID and HIVE_PROJECT_LOCK in this pane, or open a new one, to act on a different project.`,
  );
}

function pinnedOrCwdProject(): Project | null {
  const pinned = agentProjectPin();
  if (pinned != null) return getProject(pinned) ?? null;
  return findProjectForCwd();
}

async function confirmYesNo(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function ensureTrusted(
  projectId: number,
  name: string,
  command: string,
  dir: string | null,
  env: Record<string, string>,
): Promise<boolean> {
  const hash = configHash(name, command, dir, env);
  const trusted = db
    .prepare("SELECT 1 FROM command_trust WHERE project_id = ? AND name = ? AND config_hash = ?")
    .get(projectId, name, hash);
  if (trusted) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`! "${name}" is not trusted yet; run hive interactively to review it.`);
    return false;
  }
  console.log(`\nhive.yml defines "${name}":`);
  console.log(`  command: ${command}`);
  if (dir) console.log(`  dir: ${dir}`);
  if (Object.keys(env).length > 0) console.log(`  env: ${JSON.stringify(env)}`);
  if (!(await confirmYesNo("Trust and run this command from now on? [y/N] "))) {
    console.log(`Skipped "${name}".`);
    return false;
  }
  db.prepare(
    "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
  ).run(projectId, name, hash);
  return true;
}

function startYmlCommand(project: Project, name: string, proc: YmlProcess): string {

  if (isReservedAgentName(name)) {
    return `skipped: "lead" is reserved for this project's lead session and cannot be used as a process name`;
  }
  const existing = db
    .prepare("SELECT id, tmux_target, tmux_socket FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(project.id, name) as { id: number; tmux_target: string; tmux_socket: string } | undefined;
  if (existing) {

    const live = rowLive(existing.tmux_socket, existing.tmux_target);
    if (live) return "already running";

    if (live === null) return "skipped: tmux could not be probed, so hive cannot tell whether it is already running";
    closeAgentRow(existing.id);
  }
  let dir: string;
  try {
    dir = resolveCommandDir(project.path, proc.dir);
  } catch (e) {
    return `skipped: ${errorMessage(e)}`;
  }
  try {
    launchAgent({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      name,
      kind: "command",
      commandString: proc.command,
      cwd: dir,
      env: proc.env,
      placement: "window",
      parentActor: currentActor(),
    });
    return "started";
  } catch (e) {
    return `failed: ${errorMessage(e)}`;
  }
}

function attach(session: string, project: Project, window?: string): void {
  if (process.env.TMUX) {

    const argv = resolveInTmuxTarget(session, window ?? findProjectWindow(session, project.id));
    if (argv) spawnSync("tmux", argv, { stdio: "inherit" });
    return;
  }
  const controlMode = controlModeFor(process.env.TERM_PROGRAM === "iTerm.app");

  const argv = resolveAttachTarget(session, project.id, controlMode, window);
  if (!process.stdout.isTTY) {
    console.log(`Session ${session} is ready for project "${project.name}" (${project.path}).`);
    console.log(`Attach from a terminal with: tmux ${renderAttachCommand(argv)}`);
    return;
  }
  const result = spawnSync("tmux", argv, { stdio: "inherit" });
  process.exit(result.status ?? 0);
}

function asLeadNameReuseClash(e: unknown, projectId: number, leadRowId: number): unknown {
  const err = e as { code?: string; message?: string };
  const message = err.message ?? "";
  if (err.code !== "SQLITE_CONSTRAINT_UNIQUE" || !(message.includes("agents.name") || message.includes("idx_agents_running_name"))) {
    return e;
  }

  const holder = db
    .prepare(
      "SELECT id, kind, actor_id FROM agents WHERE project_id = ? AND name = ? COLLATE NOCASE AND status = 'running' AND id != ?",
    )
    .get(projectId, LEAD_NAME, leadRowId) as { id: number; kind: string; actor_id: string } | undefined;
  if (!holder) {
    return new Error(
      'Cannot reclaim the name "lead": another running row already holds it, but a second look could not find ' +
        "which one. Re-run `hive lead`.",
    );
  }
  return new Error(
    `Cannot reclaim the name "lead": a running ${holder.kind} (actor ${holder.actor_id}, agents.id ${holder.id}) ` +
      `already holds it. Rename or close that ${holder.kind} first, then re-run \`hive lead\`.`,
  );
}

function ensureLeadRow(
  project: Project,
  command: string,
): {
  agentId: number;
  actorId: string;
  previousTarget: string;
  previousSocket: string;
  previousPanePid: string;
  previousCommand: string;
  casExpected: string;
} {

  const existing = db
    .prepare(
      "SELECT id, actor_id, tmux_target, tmux_socket, pane_pid, command FROM agents WHERE project_id = ? AND kind = ? AND status = 'running' ORDER BY id",
    )
    .get(project.id, LEAD_KIND) as
    | {
        id: number;
        actor_id: string;
        tmux_target: string;
        tmux_socket: string;
        pane_pid: string;
        command: string;
      }
    | undefined;

  if (existing) {
    const actorId = existing.actor_id || mintLeadActorId(existing.id);

    try {
      db.transaction(() => {
        db.prepare("UPDATE agents SET actor_id = ?, name = ? WHERE id = ?").run(
          actorId,
          LEAD_NAME,
          existing.id,
        );
        upsertActor(actorId, LEAD_NAME, LEAD_KIND);
      })();
    } catch (e) {
      throw asLeadNameReuseClash(e, project.id, existing.id);
    }

    return {
      agentId: existing.id,
      actorId,
      previousTarget: existing.tmux_target,
      previousSocket: existing.tmux_socket,
      previousPanePid: existing.pane_pid,
      previousCommand: existing.command,
      casExpected: existing.tmux_target,
    };
  }

  const priorClosed = db
    .prepare(
      "SELECT actor_id, tmux_target, tmux_socket, pane_pid, command FROM agents WHERE project_id = ? AND kind = ? AND status = 'closed' AND actor_id != '' ORDER BY id DESC LIMIT 1",
    )
    .get(project.id, LEAD_KIND) as
    | { actor_id: string; tmux_target: string; tmux_socket: string; pane_pid: string; command: string }
    | undefined;

  let result;
  try {
    result = db.transaction(() => {

      const info = db
        .prepare(
          "INSERT INTO agents (project_id, name, command, cwd, kind, parent_actor_id, tmux_target, tmux_socket, pane_pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          project.id,
          LEAD_NAME,
          command,
          project.path,
          LEAD_KIND,
          currentActor(),
          "",
          tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR),
          "",
        );
      const agentId = Number(info.lastInsertRowid);
      const actorId = priorClosed?.actor_id ?? mintLeadActorId(agentId);
      db.prepare("UPDATE agents SET actor_id = ? WHERE id = ?").run(actorId, agentId);
      upsertActor(actorId, LEAD_NAME, LEAD_KIND);
      return { agentId, actorId };
    })();
  } catch (e) {

    throw asNameClash(e, LEAD_NAME);
  }

  return {
    agentId: result.agentId,
    actorId: result.actorId,
    previousTarget: priorClosed?.tmux_target ?? "",
    previousSocket: priorClosed?.tmux_socket ?? "",
    previousPanePid: priorClosed?.pane_pid ?? "",
    previousCommand: priorClosed?.command ?? "",
    casExpected: "",
  };
}

async function cmdLead(argv: string[]): Promise<void> {

  const unknownFlag = argv.find((a) => a.startsWith("--") && a !== "--no-dashboard");
  if (unknownFlag !== undefined) {
    console.error(`hive lead: unknown flag "${unknownFlag}". The only flag is --no-dashboard.`);
    process.exit(1);
  }
  const noDashboard = argv.includes("--no-dashboard");
  const path = argv.find((a) => !a.startsWith("--"));

  let registrationNotice: string | null = null;
  try {
    const project = resolveProject(path, (text) => {
      registrationNotice = text;
    });
    const session = sessionName();
    const hooksPath = ensureHooksFile();

    const { config, warnings } = loadProjectYml(project.path);
    for (const w of warnings) console.log(`! ${w}`);
    let leadCommand = "claude";
    if (!config) {
      console.log(
        "No hive.yml here; starting a plain claude lead. Add a hive.yml to define project commands and a custom lead (run hive --help for the format).",
      );
    } else if (config.lead) {
      if (await ensureTrusted(project.id, "lead", config.lead, null, {})) {
        leadCommand = config.lead;
      } else {
        console.log("Using the default claude lead instead.");
      }
    }

    const leadHarness = harnessFor(leadCommand);

    if (!leadHarness.briefDelivery) {
      console.log("! lead command is not claude; skipping hooks.");
    } else {
      leadCommand += ` ${leadHarness.briefDelivery.settingsArgs(hooksPath).map(shellQuote).join(" ")}`;
    }

    const profile = activeProfile(config);
    if (profile) {
      const posture = resolveProfileFile(profile, "posture.md");
      if (!posture) {
        console.log(`! profile "${profile}" has no posture.md on this machine; starting without it.`);
      } else if (!leadHarness.briefDelivery) {
        console.log(`! lead command is not claude; skipping profile "${profile}" posture.`);
      } else {

        const rendered = renderProfileFile(profile, "posture.md", config?.vars ?? {}) ?? "";
        const path = writeProjectPosture(project.id, rendered);
        leadCommand += ` ${leadHarness.briefDelivery.systemPromptArgs(path).map(shellQuote).join(" ")}`;
        console.log(`- profile: ${profile} (${posture.source} posture; see it with: hive posture)`);
      }
    }

    const windowName = project.name;
    const {
      agentId: leadAgentId,
      actorId: leadActorId,
      previousTarget,
      previousSocket,
      previousPanePid,
      previousCommand,
      casExpected,
    } = ensureLeadRow(project, leadCommand);

    const envFlags = buildEnvFlags({
      HIVE_AGENT_ID: leadActorId,
      HIVE_AGENT_NAME: LEAD_NAME,
      HIVE_LEAD: "1",
      HIVE_DATA_DIR: dataDir,
      HIVE_PROJECT_LOCK: "",
      HIVE_PROJECT_PATH: "",
    });

    const { leadPane, leadWindow, createdPane } = withWindowClaim(() => {
      let leadPane: string;
      let leadWindow: string;
      let createdPane: boolean;
      const started = ensureSession(session, project.path, { envFlags, command: leadCommand });
      if (started.created) {
        const claimed = claimInitialWindow(started, windowName, project.id);
        leadPane = claimed.pane;
        leadWindow = claimed.window;
        createdPane = true;
      } else {

        const foundWindow = findProjectWindow(session, project.id);

        const probe = rowLiveProbe(previousSocket, previousTarget);
        const adopted =
          isPaneTarget(previousTarget) && probe.live === true && !paneReissued(previousPanePid, probe)
            ? adoptableWindow(session, project.id, previousTarget)
            : null;
        if (adopted) {

          leadPane = previousTarget;
          leadWindow = adopted;
          createdPane = false;
        } else if (!foundWindow) {

          const fresh = createWindow(session, windowName, project.path, envFlags, leadCommand, project.id);
          leadPane = fresh.pane;
          leadWindow = fresh.window;
          createdPane = true;
        } else {

          leadPane = tmux(
            "split-window",
            "-P",
            "-F",
            "#{pane_id}",
            "-t",
            foundWindow,
            "-c",
            project.path,
            ...envFlags,
            leadCommand,
          );
          leadWindow = foundWindow;
          createdPane = true;
        }
      }
      return { leadPane, leadWindow, createdPane };
    });

    // The row may only claim a command hive just launched into a pane it made. On an adopt the
    // occupant is unknown, so the previous row's command stands (todo 507).
    const recordedCommand = createdPane ? leadCommand : previousCommand || leadCommand;
    if (!createdPane && previousCommand && previousCommand !== leadCommand) {
      console.log(
        `! adopted the existing lead pane, which is still running: ${previousCommand}\n` +
          `  the configured lead command is now: ${leadCommand}\n` +
          "  hive did not start that pane and cannot change what it runs, so the new command takes " +
          "effect only once the pane is restarted (close it, or agent_close the lead, then hive lead).",
      );
    }

    const wonRace = db.transaction(() => {

      const updated = db
        .prepare(
          "UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ?, command = ? WHERE id = ? AND tmux_target = ? AND status = 'running'",
        )
        .run(
          leadPane,
          tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR),
          panePid(leadPane),
          recordedCommand,
          leadAgentId,
          casExpected,
        ).changes;
      if (updated === 0) return false;
      db.prepare(
        `UPDATE timers SET deliver_pane = ?, held_at = NULL, held_reason = NULL
         WHERE ${ACTIVE_TIMER_WHERE} AND deliver_actor = ?
           AND (? = 1 OR held_reason IS NULL OR held_reason NOT LIKE ?)`,
      ).run(leadPane, leadActorId, createdPane ? 1 : 0, `${HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX}%`);
      return true;
    })();
    if (!wonRace) {

      if (createdPane) {
        try {
          tmux("kill-pane", "-t", leadPane);
        } catch {

        }
      }
      throw new Error(
        "Another `hive lead` won the race to record a live pane for this project's lead session (both saw the " +
          "same dead pane and both tried to replace it, or this row was closed by another process mid-restart). " +
          "Re-run `hive lead`; it will attach to the pane that invocation recorded.",
      );
    }

    if (config) {
      for (const [name, proc] of Object.entries(config.processes)) {
        if (!proc.auto_start) {
          console.log(`- ${name}: defined, auto_start off (start with: hive start "${name}")`);
          continue;
        }
        if (await ensureTrusted(project.id, name, proc.command, proc.dir, proc.env)) {
          console.log(`- ${name}: ${startYmlCommand(project, name, proc)}`);
        }
      }
    }

    if (registrationNotice) {
      console.error(registrationNotice);
      registrationNotice = null;
    }

    if (!noDashboard) maybeOpenDashboard(project, !!config?.dashboard);
    attach(session, project, leadWindow);
  } catch (e) {

    if (registrationNotice) console.error(registrationNotice);
    throw e;
  }
}

const HIVE_YML_TEMPLATE = `# hive project config. Read by \`hive lead\` from the project root.
# Commands defined here run only after a one-time interactive approval,
# and re-require it whenever they change.

placement: split                # worker placement: split (panes) or window (tabs)

# layout: main-vertical         # pane arrangement for placement: split.
                                # tiled (default) | main-vertical | main-horizontal
                                # | even-horizontal | even-vertical.
                                # main-* gives the lead half the window.

# lead: claude --model opus     # custom command for the lead window (default: claude)

# lead_branches: [main, master] # branches where a session gets hive's kickoff
# vars:                         # substituted into the profile runbook
#   repo: owner/name            # {{repo}}
#   ticket_prefix: DEVX         # sections needing it drop when it is unset
#   install: npm install
#   start_command: /jira-start

# processes:
#   npm:dev: npm run dev        # shorthand; auto-starts with the session
#   typecheck:                  # expanded form
#     command: npx tsc --watch --preserveWatchOutput
#     dir: ./packages/api       # relative to the project root
#     auto_start: false         # start manually with: hive start typecheck
#     env:
#       NODE_ENV: development
`;

const RUNBOOK_TEMPLATE = `RUNBOOK — standing instructions for this project's lead session.

This pad is the durable operating manual. Read it whenever the human opens
the day ("good morning", "let's triage") or asks you to orchestrate work.
Live state belongs in the "board" pad and the todos, not here.

FIRST RUN (delete this section once done)
This runbook is a starter template. Before dispatching any real work,
interview the human and rewrite every section to fit this project. Ask:
- How does work arrive? Tickets, ad-hoc requests, PR reviews, planning?
- What are the branch, commit, and PR rules? What may the lead itself do?
- Where do worktrees live, and what does a fresh one need (installs, env)?
- How do workers verify their work before a lane is called done?
- What must never happen without explicit human approval?
Rewrite the sections below from the answers, keep the whole pad short
(every read costs tokens), then delete this section.

THE ONE RULE
<the invariant that always holds, e.g. "every commit goes through a PR;
the lead stays on main and never commits">

LANES
<the kinds of work and how each one runs, e.g.
- ticket (commits): worktree + ticket branch, one worker, PR at the end
- ad-hoc task (commits): worktree + slug branch, commit, PR
- review (no commits): worker drafts the review, the human posts it
- planning: interview first, plan to a pad, seed todos with blockers>

WORKTREES
<where they live, what setup a fresh one needs, when to remove them>

MORNING TRIAGE
1. Read the "board" pad, then todo_list(status="open") for the queue.
2. <project checks: PR queue, ticket tracker, CI state>
3. Update the board, agree the day's lanes with the human, then dispatch
   per help(topic="workflow").

BOARD DISCIPLINE
The "board" pad is the live picture of the work. Update it the moment
tasks change: a todo is created, re-scoped, blocked, or completed; a
worker starts or finishes a lane; something lands in "waiting on human".
A stale board is worse than no board. Keep it small: active work-streams
and their worktree, todo, and worker ids. At day end, pad_archive the old
board and write a fresh "board" carrying forward only what is still live.
History stays readable with pad_list(include_archived=true).

STANDING RULES
- Do not poll workers. With more than one running, set
  wake_when_idle(scope="project") once and go quiet: it reports each worker
  as it finishes and keeps watching. The agents=[...] form is a one-shot and
  stops watching the rest after the first finish.
- Read real diffs and agent_output before calling a lane done.
- Record decisions in pads or todo comments; sessions die, the store lives.
- Anything outward-facing (pushes, published PRs, posted reviews) waits
  for explicit human approval.
`;

const BOARD_TEMPLATE = `BOARD — live state for this project. Keep it small and current.

Update this pad whenever tasks change: todos created, re-scoped, blocked,
or completed; lanes started or finished. At day end, archive it and write
a fresh "board" carrying forward only what is still live.

TODAY
<the day's agreed lanes, one line each: worker, worktree, todo ids, status>

WAITING ON HUMAN
<approvals, answers, or reviews the crew is blocked on>

NEXT UP
<dispatchable todos worth starting when a lane frees>
`;

const pluginLinkPath = () => join(claudeConfigDir(), "skills", "hive");

const displayLinkPath = () => {
  const path = pluginLinkPath();
  const fromHome = join(homedir(), ".claude", "skills", "hive");
  return path === fromHome ? "~/.claude/skills/hive" : path;
};

function pluginInstallState(): { state: "missing" | "linked" | "elsewhere"; target?: string } {
  let target: string;
  try {
    target = realpathSync(pluginLinkPath());
  } catch {
    return { state: "missing" };
  }
  let expected: string;
  try {
    expected = realpathSync(join(checkoutRoot, "claude-plugin"));
  } catch {
    return { state: "elsewhere", target };
  }

  return target === expected ? { state: "linked" } : { state: "elsewhere", target };
}

const PROFILE_BLURBS: Record<string, string> = {
  orchestration: "a lead that plans and delegates to workers in tmux",
  simple: "one session doing the work itself; hive is shared memory",
  [NO_PROFILE]: "project-only; hive seeds a runbook pad you fill in",
};

async function askForProfile(): Promise<string | null> {

  const options = [...profileNames(), NO_PROFILE];
  console.log(`\nA profile is a set of standing instructions shared across projects.
It gives the lead its posture and this project a runbook you can edit.`);
  options.forEach((name, i) => console.log(`  ${i + 1}) ${name.padEnd(15)} ${PROFILE_BLURBS[name] ?? ""}`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Profile for this project? [1-${options.length}, default 1] `)).trim();
  rl.close();
  if (answer === "") return options[0] ?? null;
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
  if (options.includes(answer)) return answer;
  console.log(`Not one of the options; leaving the profile unset. Re-run hive init to pick one.`);
  return null;
}

function writeProfileKey(ymlPath: string, profile: string): void {
  const existing = readFileSync(ymlPath, "utf8");
  const block = `\n# Standing instructions for this project (hive profile list).\nprofile: ${profile}\n`;
  writeFileSync(ymlPath, existing.endsWith("\n") ? existing + block : `${existing}\n${block}`);
}

async function cmdInit(argv: string[]): Promise<void> {
  const noProfile = argv.includes("--no-profile");
  const profileFlagIndex = argv.indexOf("--profile");

  const path = argv.find(
    (a, i) => !a.startsWith("--") && !(profileFlagIndex >= 0 && i === profileFlagIndex + 1),
  );
  let chosen: string | null = noProfile ? NO_PROFILE : null;
  if (profileFlagIndex >= 0) {
    const value = argv[profileFlagIndex + 1];
    if (!value || value.startsWith("--")) {
      console.log("Usage: hive init [path] [--profile <name> | --no-profile]");
      process.exit(1);
    }
    if (value !== NO_PROFILE && !profileExists(value)) {
      console.log(`No profile named "${value}". Available: ${profileNames().join(", ")}, none`);
      process.exit(1);
    }
    chosen = value;
  }

  const project = resolveProject(path);
  console.log(`Project: ${project.name} (${project.path})`);

  const ymlPath = join(project.path, "hive.yml");
  const already = existsSync(ymlPath) ? loadProjectYml(project.path).config?.profile ?? null : null;

  if (already != null) {
    if (chosen != null && chosen !== already) {
      console.log(`- hive.yml: already set to "profile: ${already}"; edit it by hand to change it`);
    }
    chosen = already;
  } else if (chosen == null && process.stdin.isTTY && process.stdout.isTTY) {
    chosen = await askForProfile();
  }

  if (!existsSync(ymlPath)) {
    writeFileSync(ymlPath, HIVE_YML_TEMPLATE + (chosen ? `\nprofile: ${chosen}\n` : ""));
    console.log(`- hive.yml: created${chosen ? ` with profile: ${chosen}` : ""}`);
  } else if (already == null && chosen != null) {
    writeProfileKey(ymlPath, chosen);
    console.log(`- hive.yml: added profile: ${chosen}`);
  } else {
    console.log(`- hive.yml: already exists${already ? ` (profile: ${already})` : ""}, left untouched`);
  }

  const usingProfile = chosen != null && chosen !== NO_PROFILE;
  if (usingProfile) {
    console.log(`- runbook: from profile "${chosen}" (read it with: hive runbook)`);
  } else {
    const padId = createPad(project.id, "runbook", RUNBOOK_TEMPLATE, []);
    console.log(
      padId == null
        ? "- runbook pad: already exists, left untouched"
        : `- runbook pad: seeded starter template (pad ${padId})`,
    );
  }

  const boardId = createPad(project.id, "board", BOARD_TEMPLATE, []);
  console.log(
    boardId == null
      ? "- board pad: already exists, left untouched"
      : `- board pad: seeded starter template (pad ${boardId})`,
  );

  if (chosen == null) {
    console.log(`\nNo profile set (nothing was asked, since this is not an interactive terminal).
Pick one later with: hive init --profile <name>   (hive profile list shows them)
or decide against it with: hive init --no-profile`);
  }

  if (usingProfile) {
    const plugin = pluginInstallState();
    if (plugin.state === "linked") {
      console.log(`\nSession-start kickoff: already installed for this machine, nothing to do.
Check what a session here would get with: hive kickoff --explain`);
    } else if (plugin.state === "elsewhere") {
      console.log(`\n! ${displayLinkPath()} resolves to ${plugin.target}, not this checkout.
Sessions here run THAT hive's kickoff. Repoint it if this checkout is the one you use:
  rm ${displayLinkPath()} && ln -s ${join(checkoutRoot, "claude-plugin")} ${displayLinkPath()}`);
    } else {
      console.log(`\nOptional, once per machine (not per project): let a session in this project
start with hive's live state already loaded.
  ln -s ${join(checkoutRoot, "claude-plugin")} ${displayLinkPath()}`);
    }
    console.log(`\nNext: run \`hive\` here. The lead starts with the "${chosen}" posture in its
system prompt; \`hive runbook\` is the process it follows. Fork the runbook to
make it yours: hive profile fork ${chosen} runbook.md`);
  } else {
    console.log(`\nNext: run \`hive\` here and tell the lead "good morning, let's triage".
The runbook's first-run section has the lead interview you and tailor
itself to this project before any real work runs.`);
  }
}

const NO_RUNBOOK_PAD_MESSAGE = `is on "profile: none" but has no runbook pad. Create one with: hive init`;

function cmdRunbook(path?: string): void {
  const project = resolveProject(path);
  const { config, warnings } = loadProjectYml(project.path);
  for (const w of warnings) console.log(`! ${w}`);
  const profile = activeProfile(config);

  if (!profile) {
    const pad = getActivePadByName(project.id, "runbook");
    if (pad) {
      process.stdout.write(withTrailingNewline(pad.content));
      return;
    }
    console.log(
      config?.profile === NO_PROFILE
        ? `This project ${NO_RUNBOOK_PAD_MESSAGE}`
        : `This project has no profile. Add "profile: <name>" to hive.yml (hive profile list) or run hive init.`,
    );
    process.exit(1);
  }

  const vars = config?.vars ?? {};
  const rendered = renderProfileFile(profile, "runbook.md", vars);
  if (rendered == null) {
    console.log(`Profile "${profile}" has no runbook.md on this machine. Profiles hive can see: ${profileNames().join(", ") || "none"}`);
    process.exit(1);
  }
  process.stdout.write(withTrailingNewline(rendered));
}

function cmdPosture(path?: string): void {
  const project = resolveProject(path);
  const { config, warnings } = loadProjectYml(project.path);
  for (const w of warnings) console.log(`! ${w}`);
  const profile = activeProfile(config);
  if (!profile) {
    console.log(
      `This project has no profile, so its lead starts with no posture. Add "profile: <name>" to hive.yml (hive profile list) or run hive init.`,
    );
    process.exit(1);
  }
  const vars = config?.vars ?? {};
  const rendered = renderProfileFile(profile, "posture.md", vars);
  if (rendered == null) {
    console.log(`Profile "${profile}" has no posture.md on this machine, so the lead starts without one.`);
    process.exit(1);
  }
  process.stdout.write(withTrailingNewline(rendered));
}

function profileUsage(): never {
  console.log(`Usage:
  hive profile list                            profiles hive can see, and where each file comes from
  hive profile path <name> [file]              where a profile's files resolve to
  hive profile fork <name> [file]              copy hive's default into ${userProfilesDir()} to edit
  hive profile create <name> [--from <other>]  start a new profile
  hive profile read <file> [--profile <name>]  resolve, render vars, print any .md a profile has;
                                                defaults to this project's profile and vars

Files in a profile: ${PROFILE_FILES.join(", ")}, plus anything else a fork carries (see hive profile list)`);
  process.exit(1);
}

function asProfileFile(value: string | undefined): ProfileFile | undefined {
  if (value == null) return undefined;
  if (!(PROFILE_FILES as readonly string[]).includes(value)) {
    console.log(`Unknown profile file "${value}". Files are: ${PROFILE_FILES.join(", ")}`);
    process.exit(1);
  }
  return value as ProfileFile;
}

function profileDriftText(f: ProfileFileStatus): { rewrite: boolean; text: string } | null {
  if (!f.upstreamMoved) return null;
  const pct = f.divergence != null ? Math.round(f.divergence * 100) : null;
  if (f.divergence != null && f.divergence >= REWRITE_THRESHOLD) {
    return { rewrite: true, text: `${f.file} is a ${pct}% rewrite of hive's default, not an edited copy of it` };
  }
  return {
    rewrite: false,
    text: `hive's default ${f.file} changed since you forked it${pct != null ? ` (${pct}% diverged)` : ""}`,
  };
}

function cmdProfile(argv: string[]): void {
  const [sub, ...rest] = argv;
  const positional = rest.filter((a) => !a.startsWith("--"));
  const name = positional[0];

  try {
    switch (sub) {
      case undefined:
      case "list": {
        const names = profileNames();
        if (names.length === 0) {
          console.log("No profiles found. hive ships orchestration and simple; check your install.");
          return;
        }

        const here = findProjectForCwd();
        const current = here ? activeProfile(loadProjectYml(here.path).config) : null;
        const statuses = names.map((profile) => profileStatus(profile));
        const fileWidth = Math.max(11, ...statuses.flatMap((s) => s.files.map((f) => f.file.length)));
        for (const [i, profile] of names.entries()) {
          const status = statuses[i];
          console.log(`${profile === current ? "*" : " "} ${profile}`);
          for (const f of status.files) {
            const drift = profileDriftText(f);
            console.log(`    ${f.file.padEnd(fileWidth)} ${f.source.padEnd(7)} ${f.path}${drift ? `   (${drift.text})` : ""}`);
          }
        }
        if (current) console.log(`\n* is this project's profile.`);
        return;
      }
      case "path": {
        if (!name) profileUsage();
        if (!profileExists(name)) {
          console.log(`No profile named "${name}". List them with: hive profile list`);
          process.exit(1);
        }
        const only = asProfileFile(positional[1]);
        for (const file of only ? [only] : PROFILE_FILES) {
          const resolved = resolveProfileFile(name, file);
          if (resolved) console.log(resolved.path);
        }
        return;
      }
      case "fork": {
        if (!name) profileUsage();
        const { copied, skipped } = forkProfile(name, asProfileFile(positional[1]));
        for (const file of copied) console.log(`forked ${file} -> ${join(userProfilesDir(), name, file)}`);
        for (const file of skipped) console.log(`kept your ${file} (already forked)`);
        if (copied.length === 0 && skipped.length === 0) console.log(`Profile "${name}" ships no files to fork.`);
        return;
      }
      case "create": {
        if (!name) profileUsage();
        const fromIndex = rest.indexOf("--from");
        const from = fromIndex >= 0 ? rest[fromIndex + 1] : undefined;
        const dir = createProfile(name, from);
        console.log(`Created ${dir}`);
        console.log(`Use it with "profile: ${name}" in a project's hive.yml.`);
        return;
      }
      case "read": {
        const profileFlagIndex = rest.indexOf("--profile");
        const override = profileFlagIndex >= 0 ? rest[profileFlagIndex + 1] : undefined;
        const filePositional = rest.filter(
          (a, i) => !a.startsWith("--") && !(profileFlagIndex >= 0 && i === profileFlagIndex + 1),
        );
        const file = filePositional[0];
        if (!file) profileUsage();

        let profileName: string;
        let vars: Record<string, string>;
        if (override != null) {
          profileName = override;
          const here = findProjectForCwd();
          vars = here ? loadProjectYml(here.path).config?.vars ?? {} : {};
        } else {
          const project = resolveProject();
          const { config, warnings } = loadProjectYml(project.path);
          for (const w of warnings) console.log(`! ${w}`);
          const active = activeProfile(config);
          if (!active) {
            console.log(`This project has no profile. Add "profile: <name>" to hive.yml (hive profile list) or run hive init.`);
            process.exit(1);
          }
          profileName = active;
          vars = config?.vars ?? {};
        }

        const rendered = renderProfileFile(profileName, file, vars);
        if (rendered == null) {
          const present = profileFileNames(profileName);
          console.log(
            `No readable "${file}" for profile "${profileName}". Files present: ${present.length > 0 ? present.join(", ") : "none"}`,
          );
          process.exit(1);
        }
        process.stdout.write(withTrailingNewline(rendered));
        return;
      }
      default:
        profileUsage();
    }
  } catch (e) {
    if (e instanceof ProfileError) {
      console.log(errorMessage(e));
      process.exit(1);
    }
    throw e;
  }
}

const DASHBOARD_OPENED_KV_KEY = "hive:dashboard_opened";

const DASHBOARD_OPENED_TTL_SECONDS = 8 * 60 * 60;

function maybeOpenDashboard(project: Project, dashboardEnabled: boolean): void {
  if (process.platform !== "darwin") return;
  if (!dashboardEnabled) return;

  const dashboardDir = resolveDashboardDir(project.path);
  if (dashboardDir === null) return;
  const dashboardFile = join(dashboardDir, "index.html");

  if (!existsSync(dashboardFile)) return;

  if (!dashboardFileContained(dashboardFile, project.path)) return;

  const actor = currentActor();
  const claim = db
    .prepare(
      `INSERT INTO kv (project_id, key, value, updated_by, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', printf('+%d seconds', ?)))
       ON CONFLICT(project_id, key) DO UPDATE SET
         value = excluded.value, updated_by = excluded.updated_by,
         updated_at = datetime('now'), expires_at = excluded.expires_at
       WHERE kv.expires_at IS NOT NULL AND kv.expires_at < datetime('now')`,
    )
    .run(project.id, DASHBOARD_OPENED_KV_KEY, JSON.stringify(true), actor, DASHBOARD_OPENED_TTL_SECONDS);
  if (claim.changes === 0) return;

  try {

    execFileSync("open", [pathToFileURL(dashboardFile).href], { stdio: "ignore", timeout: 5000 });
  } catch {

    db.prepare("DELETE FROM kv WHERE project_id = ? AND key = ?").run(project.id, DASHBOARD_OPENED_KV_KEY);
  }
}

function cmdAttach(argv: string[]): void {

  const unknownFlag = argv.find((a) => a.startsWith("--"));
  if (unknownFlag !== undefined) {
    console.error(`hive attach: unknown flag "${unknownFlag}". hive attach takes no flags.`);
    process.exit(1);
  }
  const path = argv.find((a) => !a.startsWith("--"));
  const project = resolveProject(path);
  maybeOpenDashboard(project, !!loadProjectYml(project.path).config?.dashboard);
  const session = sessionName();

  const window = withWindowClaim(() => {
    const started = ensureSession(session, project.path);
    if (started.created) {
      configureHiveWindow(started.window, true, project.id);
      tmux("rename-window", "-t", started.window, project.name);
      return started.window;
    }
    const found = findProjectWindow(session, project.id);
    if (found) return found;

    const created = tmux(
      "new-window", "-P", "-F", "#{session_name}:#{window_id}",
      "-t", `=${session}`, "-n", project.name, "-c", project.path,
    );
    configureHiveWindow(created, true, project.id);
    return created;
  });
  attach(session, project, window);
}

async function cmdStart(name?: string, path?: string): Promise<void> {
  if (!name) {
    console.log("Usage: hive start <process> [path]");
    process.exit(1);
  }
  const project = resolveProject(path);
  const { config, warnings } = loadProjectYml(project.path);
  for (const w of warnings) console.log(`! ${w}`);
  const proc = config?.processes[name];
  if (!proc) {
    const known = Object.keys(config?.processes ?? {});
    console.log(
      known.length > 0
        ? `No process "${name}" in hive.yml. Defined: ${known.join(", ")}`
        : "This project has no hive.yml processes.",
    );
    process.exit(1);
  }
  if (await ensureTrusted(project.id, name, proc.command, proc.dir, proc.env)) {
    console.log(`${name}: ${startYmlCommand(project, name, proc)}`);
  }
}

function cmdStatus(): void {
  janitor();
  let anyOutput = false;

  let windows: [string, string][] | null | undefined;
  let windowsError: unknown;
  const ownedWindows = (): [string, string][] | null => {
    if (windows === undefined) {
      try {
        windows = listOwnedWindows(sessionName());
      } catch (e) {
        windows = null;
        windowsError = e;
      }
    }
    return windows;
  };
  for (const project of listProjects()) {
    const agents = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND status = 'running' ORDER BY kind DESC, id")
      .all(project.id) as (ProvenanceRow & {
      kind: string;
      name: string;
      tmux_target: string;
      cwd: string;
    })[];

    const todos = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status IN ('open', 'in_progress') AND archived_at IS NULL",
        )
        .get(project.id) as { n: number }
    ).n;

    const { timers, heldWakes } = db
      .prepare(
        `SELECT COUNT(*) AS timers, COUNT(held_at) AS heldWakes FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`,
      )
      .get(project.id) as { timers: number; heldWakes: number };

    const parked = db
      .prepare(
        "SELECT id, name, parked_at, parked_branch, cwd FROM agents " +
          "WHERE project_id = ? AND status = 'closed' AND parked_at != '' ORDER BY parked_at, id",
      )
      .all(project.id) as { id: number; name: string; parked_at: string; parked_branch: string; cwd: string }[];
    if (agents.length === 0 && todos === 0 && timers === 0 && parked.length === 0) continue;
    anyOutput = true;

    let windowLabel: string;
    const fetched = ownedWindows();
    if (fetched) {
      windowLabel = fetched.find(([, ownerId]) => Number(ownerId) === project.id)?.[0] ?? "none yet";
    } else {
      windowLabel = tmuxSaysNothingThere(windowsError) ? "none yet" : "unknown (tmux unreachable)";
    }
    console.log(`\n${project.name}  (${project.path})  window: ${windowLabel}`);
    for (const a of agents) {

      const state = a.kind === "agent" ? describeForHuman(deriveProvenance(a, null)) : "running";

      const label = a.kind === "command" ? "cmd  " : a.kind === LEAD_KIND ? "lead " : "agent";
      console.log(`  ${label}  ${a.name.padEnd(20)} ${state}`);

      if (reportsAgentStateLog(a)) {
        console.log(`         last log event: ${describeLastLogEvent(lastLogEvent(a.actor_id))}`);
      }
    }
    if (agents.length === 0) console.log("  no running agents or commands");
    for (const p of parked) {

      console.log(`  parked  ${p.name.padEnd(20)} ${p.parked_at}  branch ${p.parked_branch || "(unrecorded)"}`);
      console.log(`         ${p.cwd}`);
      console.log(`         resume: agent_resume(agent_id: ${p.id})`);
    }
    console.log(
      `  open todos: ${todos}   pending wake-ups: ${timers}${heldWakes > 0 ? ` (${heldWakes} held)` : ""}`,
    );
  }
  if (!anyOutput) console.log("Nothing running and no open work in any project.");
}

const report = (level: string, label: string, lines: string[]) => {
  console.log(`  ${level}  ${label}: ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`        ${line}`);
};
const info = (label: string, ...lines: string[]) => report("info", label, lines);

let warnings = 0;
let gatingWarnings = 0;
const warn = (label: string, ...lines: string[]) => {
  warnings += 1;
  report("warn", label, lines);
};

const gatingWarn = (label: string, ...lines: string[]) => {
  gatingWarnings += 1;
  warn(label, ...lines);
};

let doctorVerbose = false;

type VerboseOnlyCheck = "worker live state";

const verboseInfo = (_check: VerboseOnlyCheck, label: string, ...lines: string[]) => {
  if (doctorVerbose) report("info", label, lines);
};

const REVIEW_FINDING_TAGS = [
  "from-counselors",
  "from-gate",
  "from-code-review",
  "from-simplify",
  "from-smoke-test",
  "from-sideproj",
];

const isReviewFindingTag = (tag: string): boolean =>
  REVIEW_FINDING_TAGS.some((base) => tag === base || tag.startsWith(`${base}-`));

function cmdSetup(argv: string[]): void {
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? resolve(argv[dirFlag + 1] ?? "") : dispatcherDir();
  const file = join(dir, "hive");
  const node = process.execPath;
  const cli = cliPath();

  const attachRequested = argv.includes("--attach");
  const attachValue = flagValue(argv, "--attach");
  let attachArg: AttachMode | undefined;
  if (attachRequested) {
    if (!isAttachMode(attachValue)) {
      console.log(`--attach must be one of: ${ATTACH_MODES.join(", ")} (got ${attachValue ?? "nothing"})`);
      process.exit(1);
    }
    attachArg = attachValue;
  }

  const autoAttachRequested = argv.includes("--auto-attach");
  const autoAttachValue = flagValue(argv, "--auto-attach");
  let autoAttachArg: AutoAttach | undefined;
  if (autoAttachRequested) {
    if (!isAutoAttach(autoAttachValue)) {
      console.log(
        `--auto-attach must be one of: ${AUTO_ATTACH_MODES.join(", ")} (got ${autoAttachValue ?? "nothing"})`,
      );
      process.exit(1);
    }
    autoAttachArg = autoAttachValue;
  }

  const existing = readDispatcher(file);
  if (existing && !existing.mine && !argv.includes("--force")) {

    console.log(`${file} exists and was not written by hive setup; refusing to overwrite it.`);
    console.log("Move it aside, pick another directory with --dir, or overwrite it with --force.");
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, dispatcherScript(node, cli));
  chmodSync(file, 0o755);

  const rewritten = existing?.mine && (existing.node !== node || existing.cli !== cli);
  console.log(`${existing?.mine ? (rewritten ? "Re-pinned" : "Refreshed") : "Wrote"} ${file}`);
  if (rewritten) console.log(`  was          ${existing.node ?? "an unrecognized exec line"} ${existing.cli ?? ""}`.trimEnd());
  console.log(`  interpreter  ${node}`);
  console.log(`               ${process.version}, NODE_MODULE_VERSION ${process.versions.modules}`);
  console.log(`  runs         ${cli}`);

  const need = requiredNodeApi();
  const range = need === null ? null : nodeRangeForNodeApi(need);
  console.log("\n`hive` now runs under that interpreter from any directory, whatever `node` a");
  console.log("version manager resolves there. better-sqlite3's addon needs a Node providing");
  console.log(
    range
      ? `Node-API ${need} (${range}); below that it does not fail, it dies inside dlopen.`
      : `Node-API ${need ?? "the level its binding.gyp names"}; below that it does not fail, it dies inside dlopen.`,
  );

  if (attachArg) setAttachMode(attachArg);
  if (autoAttachArg) setAutoAttach(autoAttachArg);
  console.log(`\nattach mode  ${attachMode()}`);
  console.log(`auto-attach  ${resolvedAutoAttach().value}`);
  if (attachArg === "raw") {
    console.log("\nRecommended ~/.tmux.conf setting for raw attach mode:");
    for (const line of RAW_ATTACH_TMUX_CONFIG) console.log(`  ${line}`);
    console.log(`\nWhy these, and what else helps: ${TMUX_DOC}`);
  }

  console.log("");
  for (const line of durabilityLines(node)) console.log(line);

  console.log("\nA rebuild does not re-pin anything on its own. After every update:");
  console.log("  npm install && npm run build && hive setup");
  console.log(`\nPATH: ${pathAdvice(dir, file).join("\n")}`);
  reportSetupRegistrations(node);
}

function reportSetupRegistrations(pinned: string): void {
  const found = hiveRegistrations(findProjectForCwd()?.path ?? null);
  const problems = found
    .map((r) => ({ r, lines: registrationProblem(r, pinned) }))
    .filter((p): p is { r: McpRegistration; lines: string[] } => p.lines !== null);
  if (problems.length > 0) {
    console.log("\n! hive setup pins the `hive` command, not the MCP server. Claude Code starts");
    console.log("  hive's server from its own registration, and this one disagrees:");
    for (const { r, lines } of problems) {
      console.log(`  mcp registration (${r.scope} scope): ${lines[0]}`);
      for (const line of lines.slice(1)) console.log(`  ${line}`);
    }
    return;
  }

  const offer = registrationOffer(pinned, found);
  if (offer) {
    console.log("");
    for (const line of offer) console.log(`  ${line}`);
  }
}

function reportDispatcher(): void {
  const onPath = firstHiveOnPath();

  const winner = onPath ? readDispatcher(onPath) : null;
  const dispatcher = winner?.mine ? winner : readDispatcher(dispatcherPath());
  if (!dispatcher?.mine) {
    info(
      "dispatcher",
      `none at ${dispatcherPath()}; \`hive setup\` writes one pinned to this build`,
      ...(onPath ? [`\`hive\` on PATH is ${onPath}`] : []),
    );
    return;
  }
  info("dispatcher", `${dispatcher.file} -> ${dispatcher.node ?? "an exec line hive cannot parse"}`);
  if (!dispatcher.node || !dispatcher.cli) {
    gatingWarn("dispatcher", "written by another version of hive; re-run `hive setup` to refresh it.");
  } else if (!existsSync(dispatcher.node)) {

    const need = requiredNodeApi();
    const range = (need === null ? null : nodeRangeForNodeApi(need)) ?? "that Node-API level";
    gatingWarn(
      "dispatcher",
      `the interpreter it pins is gone: ${dispatcher.node}`,
      "A version manager can remove one. Typing `hive` now fails with an exec error, and the",
      "SessionStart hook loses the interpreter it re-execs into when a project's own `node`",
      "cannot load the addon - a session there prints the addon banner instead.",
      "Re-pin by naming a Node that exists (setup pins whatever Node runs it, and the `hive`",
      "on PATH is this dispatcher):",
      `  <a Node matching ${range}> "${cliPath()}" setup`,
    );
  } else if (dispatcher.node !== process.execPath || dispatcher.cli !== cliPath()) {
    gatingWarn(
      "dispatcher",
      "pinned to a different build than this CLI is running.",
      `this run: ${process.execPath} ${cliPath()}`,
      "Re-pin after a rebuild: npm run build && hive setup",
    );
  }
  if (onPath !== dispatcher.file) gatingWarn("dispatcher", ...pathAdvice(dispatcherDir(), dispatcher.file));
}

function reportSessionInterpreters(): void {

  const locked = process.env.HIVE_PROJECT_LOCK === "1";
  const here = locked ? findProjectForCwd() : null;
  const registered = locked ? (here ? [here] : []) : listProjects();
  const projects = registered.filter((p) => existsSync(join(p.path, "hive.yml")));
  if (projects.length === 0) return;
  info(
    "session interpreters",
    "one `node` resolved per project directory, with this process's own environment.",
    "That is how a version manager resolves the bare `node` the SessionStart hook runs under;",
    "a session started from a different environment can resolve a different interpreter.",
    ...(locked ? ["this project only: HIVE_PROJECT_LOCK is set for this session."] : []),
  );

  let resolved: ReexecTarget | undefined;
  const target = () => (resolved ??= reexecTarget());
  for (const project of projects) {
    const verdict = sessionStartVerdict(probeSessionInterpreter(project.path), target);

    const emit = verdict.level === "warn" ? warn : info;
    emit(`project ${project.name} (${project.path})`, ...verdict.lines);
  }
}

function reportMcpRegistrations(project: Project | null): void {
  const registrations = hiveRegistrations(project?.path ?? null);
  if (registrations.length === 0) {
    info(
      "mcp registration",
      "none found for hive (checked ~/.claude.json and .mcp.json)",

      ...(registrationOffer(process.execPath, registrations) ?? []),
    );
    return;
  }
  for (const r of registrations) {
    const where = `mcp registration (${r.scope} scope)`;
    info(where, [r.command, ...r.args].join(" "));
    const problem = registrationProblem(r, process.execPath);
    if (problem) gatingWarn(where, ...problem);
  }
}

const PTY_OVERRIDE_VARS = ["HIVE_PTY_HEADROOM_JSON", "HIVE_PTY_PS_ROWS_JSON"];

function ptyOverrideNote(): string {
  const active = PTY_OVERRIDE_VARS.filter((v) => process.env[v]);
  return active.length === 0 ? "" : ` (${active.join(", ")} override${active.length > 1 ? "s" : ""}; testing only)`;
}

function reportPtyHeadroom(orphans: OrphanScratchServers | null): void {
  const headroom = ptyHeadroom();
  if (!headroom) {

    return;
  }
  const free = headroom.max - headroom.allocated;
  const overrideNote = ptyOverrideNote();

  if (!isLowHeadroom(headroom)) {
    info("ptys", `${headroom.allocated} of ${headroom.max} in use (${free} free)${overrideNote}`);
    return;
  }

  const shells = orphanLoginShellDetails();
  const shellsLine =
    shells === null
      ? "orphaned login shell count unavailable (ps did not respond)"
      : `${shells.length} orphaned login shell(s) holding a pty (ppid 1, reparented to launchd)` +
        (shells.length === 0 ? "" : `, oldest ${(Math.max(...shells.map((s) => s.ageMs)) / 3_600_000).toFixed(1)}h`);
  const scratchHeld = orphans ? orphans.live + orphans.wedged : 0;
  const livePanes = (db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status = 'running'").get() as { n: number })
    .n;

  warn(
    "ptys",
    `${headroom.allocated} of ${headroom.max} in use (${free} free), below the safety margin${overrideNote}`,
    shellsLine,
    `${scratchHeld} orphaned scratch tmux server(s) still holding a socket (detail in the scratch tmux servers check)`,
    `${livePanes} pane(s) recorded 'running' in hive's own store (leads and workers, this machine)`,
    "reap the orphaned shells and scratch servers with `node scripts/sweep-scratch.mjs` (dry run by default, " +
      "`--kill` to act)",
  );
}

function reportOrphanTmuxServers(orphans: OrphanScratchServers | null): void {
  if (!orphans) return;
  const truncated = orphans.probed < orphans.aged ? `, ${orphans.aged - orphans.probed} not probed (time budget)` : "";
  const found = orphans.live + orphans.wedged;
  const hours = orphans.oldestMs === null ? null : (orphans.oldestMs / 3_600_000).toFixed(1);

  const detail = [
    `${found} orphaned server(s) on scratch sockets (${orphans.live} answering, ${orphans.wedged} not answering` +
      `${hours === null ? "" : `, oldest ${hours}h`}), out of ${orphans.candidates} scratch socket(s)${truncated}`,
    `not touched here - doctor reports: ${orphans.sockets.slice(0, 5).join(", ")}` +
      (orphans.sockets.length > 5 ? `, and ${orphans.sockets.length - 5} more` : ""),
    "reap one that ANSWERS by socket: resolve the live socket with `tmux display-message -p '#{socket_path}'`, " +
      "then `tmux -S <path> kill-server` on the others. Never by pid - a pid-to-socket mapping has been observed " +
      "ambiguous on a real row.",
    "a server that does NOT answer is the wedged case, and kill-server blocks against it, leaving another " +
      "spinning client behind per attempt. Resolve the live PID as well (`tmux display-message -p '#{pid}'`), " +
      "exclude both it and the live socket, re-check each candidate with lsof, and verify the live session after " +
      "every step.",
  ];
  if (found === 0) {

    info(
      "scratch tmux servers",
      `none older than ${Math.round(ORPHAN_MIN_AGE_MS / 60000)}m (${orphans.candidates} scratch socket(s) present, ` +
        `${orphans.aged} old enough to probe${truncated})`,
    );
    return;
  }

  (orphansWorthWarningAbout(orphans) ? warn : info)("scratch tmux servers", ...detail);
}

const UNBRIEFED_WORKER_BOUND_SECONDS = 30 * 60;

function reportUnbriefedWorkers(projectId: number): void {
  const waiting = (
    db
      .prepare(
        `SELECT name, command, kind, resumed_at, tmux_socket FROM agents WHERE project_id = ? AND status = 'running'
           AND kind = 'agent' AND ${awaitingFirstPromptSql("agents")} ORDER BY id`,
      )
      .all(projectId) as { name: string; command: string; kind: string; resumed_at: string; tmux_socket: string }[]
  )

    .filter((row) => reportsAgentStateLog(row))

    .filter((row) => !foreignSocket(row.tmux_socket));
  const overdue = waiting
    .map((row) => ({ name: row.name, seconds: ageSecondsSince(row.resumed_at) }))
    .filter((row) => row.seconds >= UNBRIEFED_WORKER_BOUND_SECONDS);
  if (overdue.length === 0) {
    info(
      "first assignment",
      `${waiting.length} worker(s) awaiting one, none for more than ` +
        `${Math.round(UNBRIEFED_WORKER_BOUND_SECONDS / 60)}m`,
    );
    return;
  }
  for (const row of overdue) {

    warn(
      `worker ${row.name}`,
      `has had its first-prompt latch set for ${humanizeAge(row.seconds)} - hive has suppressed every finish it ` +
        "reported for that whole time, so a lead waiting on this worker will wait forever.",
      "the latch is agents.resumed_at, cleared by the worker's first prompt (src/hook.ts). It is still set, " +
        "which means either this worker was resumed and nobody has re-briefed it yet, or its next assignment " +
        "landed in a pane that was still replaying its restore turn and fired no UserPromptSubmit - in which " +
        "case the worker may be working normally and only its FINISHES are lost - or its hooks never wired up " +
        "at all (.claude/rules/worker-state.md).",
      "either way the fix is the same: send it something while its pane is idle - any real prompt clears the " +
        "latch and its finishes start being reported again. `hive status` shows whether the pane is busy.",
    );
  }
}

function describeProbed(workers: number, leads: number): string {
  if (workers > 0 && leads > 0) return "workers plus the lead's own pane";
  if (leads > 0) return "the lead's own pane only - no worker pane was probeable";
  if (workers > 0) return "workers only - no lead pane was probeable";
  return "nothing was probeable";
}

// Quiet by default and self-clearing without a threshold: a record is reported only while nobody
// has started a replacement crew in THIS project since it, and only while it still names a worker
// that is still closed. Both are exact facts about the store, so this can never become furniture.
//
// Reports EVERY still-current record, not just the newest: the janitor's 15-second settle window
// means one death can be detected across two ticks, and a crew silently absent from the report is
// the session ids this artifact exists to carry never reaching the human.
function currentTeardowns(projectId: number): TeardownRecord[] {
  const movedOn = (record: TeardownRecord): boolean =>
    (
      db
        .prepare(
          // agents.created_at is second-precision and detected_at is millisecond, so this compares
          // against the truncated second, and it excludes the record's own crew.
          `SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND created_at >= ?` +
            ` AND id NOT IN (${record.crew.map(() => "?").join(",") || "-1"})`,
        )
        .get(projectId, record.detected_at.slice(0, 19), ...record.crew.map((m) => m.agent_id)) as { n: number }
    ).n > 0;

  const current: TeardownRecord[] = [];
  for (const record of readTeardowns(dataDir).reverse()) {
    if (movedOn(record)) break;
    current.push(record);
  }
  return current.reverse();
}

// Identity is the actor_id, not the row id. teardowns.jsonl is not in a backup snapshot and a
// restore does not touch it, so the store can roll back under a record that outlived it and a later
// spawn can take an id this record already names. Naming a live worker as a casualty is the
// wrong-owner failure this whole artifact is built to avoid.
const stillClosedNow = (m: TeardownMember): boolean => {
  const row = db.prepare("SELECT status, actor_id FROM agents WHERE id = ?").get(m.agent_id) as
    | { status: string; actor_id: string }
    | undefined;
  return row?.status === "closed" && row.actor_id === m.actor_id;
};

// The cross-project reach IS the incident - every recorded death took a second project's lead - so
// other projects' casualties are reported as a BARE COUNT. The fact that the death was machine-wide
// survives; no name, cwd, id or resume command for a row this project does not own crosses over.
function reportOneTeardown(record: TeardownRecord, projectId: number): void {
  const mine = record.crew.filter((m) => m.project_id === projectId);
  const theirs = record.crew.length - mine.length;
  const stillClosed = mine.filter((m) => m.swept && stillClosedNow(m));
  if (stillClosed.length === 0) return;

  const resumable = stillClosed.filter((m) => m.session_id !== "");
  warn(
    "crew teardown",
    `${mine.length} of this project's pane(s) went with the tmux server at ${record.socket}; ` +
      `${record.attribution}.`,
    `hive detected it at ${record.detected_at}. The teardown happened ${describeTeardownWindow(record.window)}.`,
    ...(theirs > 0
      ? [
          `${theirs} further pane(s) on that socket died with it, belonging to other projects or to no ` +
            "project hive can name. They are counted and not listed: the death crossing projects is the " +
            "fact worth having, and this project may not read another's state.",
        ]
      : []),
    "hive records who WAS there, never who killed it. To attribute it, dump EVERY tool call in that " +
      `window from these working directories - the gaps matter as much as the hits: ${[
        ...new Set(mine.map((m) => m.cwd)),
      ].join(", ")}`,
    resumable.length > 0
      ? `still closed and resumable: ${resumable
          .map((m) => `${m.name} (agent_resume(agent_id: ${m.agent_id}))`)
          .join(", ")}. The recorded session id does not expire; its transcript and its cwd can.`
      : `still closed: ${stillClosed.map((m) => m.name).join(", ")}. None recorded a session id, so none can be resumed.`,
    `full record: ${teardownLogPath(dataDir)}`,
  );
}

// This is the one reporter in doctor that reads a file a human is invited to open, so it is wrapped:
// a throw here is not inside a check() and would abort every remaining check, and doctor is what
// people run once things are already broken.
function reportCrewTeardown(projectId: number): void {
  try {
    for (const record of currentTeardowns(projectId)) reportOneTeardown(record, projectId);
  } catch (e) {
    warn(
      "crew teardown",
      `a teardown record could not be read: ${errorMessage(e)}`,
      `hive is saying so rather than staying quiet, because this file is the only trace of a dead crew: ${teardownLogPath(dataDir)}`,
    );
  }
}

function reportStalledWorkers(projectId: number): void {
  const latched = (
    db
      .prepare(
        `SELECT name, command, kind, cwd, session_id, agent_state, state_changed_at, tmux_target, tmux_socket
           FROM agents
          WHERE project_id = ? AND status = 'running' AND kind = 'agent'
            AND agent_state IN ('working', 'waiting') AND state_changed_at IS NOT NULL
          ORDER BY id`,
      )
      .all(projectId) as {
      name: string;
      command: string;
      kind: string;
      cwd: string;
      session_id: string;
      agent_state: string;
      state_changed_at: string;
      tmux_target: string;
      tmux_socket: string;
    }[]
  )

    .filter((row) => reportsAgentStateLog(row) && row.session_id !== "");
  const stalled: { name: string; sentence: string }[] = [];
  for (const row of latched) {

    const latchedFor = ageSecondsSince(row.state_changed_at);
    if (latchedFor < STALL_BOUND_SECONDS) continue;
    const stale = transcriptStaleness(row);
    if (stale !== "never" && stale.seconds < STALL_BOUND_SECONDS) continue;

    if (row.agent_state === "waiting") {
      if (foreignSocket(row.tmux_socket)) continue;
      if (paneChoiceCheck(row.tmux_target).awaitingChoice !== false) continue;
    }
    stalled.push({ name: row.name, sentence: describeStall(row.agent_state, latchedFor, stale) });
  }
  if (stalled.length === 0) {
    info(
      "stalled workers",
      `${latched.length} worker(s) latched working/waiting, none stalled past ` +
        `${Math.round(STALL_BOUND_SECONDS / 60)}m`,
    );
    return;
  }
  for (const row of stalled) {
    warn(
      `worker ${row.name}`,
      row.sentence,
      "hive is reporting what it OBSERVED, not that this worker is dead: one very long tool call looks " +
        "identical from here. Read its pane before acting.",
      "if the turn really did die, send it a message AND TELL IT WHAT STATE YOU FOUND - after an API error a " +
        "worker does not reliably remember what it was doing (.claude/rules/worker-state.md).",
    );
  }
}

function cmdDoctor(argv: string[]): void {
  const strict = argv.includes("--strict");
  doctorVerbose = argv.includes("--verbose");
  const KNOWN_DOCTOR_FLAGS = new Set(["--strict", "--verbose"]);
  const unknown = argv.find((a) => !KNOWN_DOCTOR_FLAGS.has(a));
  if (unknown !== undefined) {

    console.error(`hive doctor: unknown argument "${unknown}". Flags are --strict and --verbose.`);
    process.exit(1);
  }
  let failures = 0;

  const fail = (label: string, ...lines: string[]) => {
    failures += 1;
    report("FAIL", label, lines);
  };
  const check = (label: string, fn: () => string) => {
    try {
      console.log(`  ok    ${label}: ${fn()}`);
    } catch (e) {
      fail(label, errorMessage(e));
    }
  };
  console.log("hive doctor\n");
  check("version", () => {
    const { line, drift } = versionInfo();
    return drift ? [line, drift].join("\n        ") : line;
  });
  check("node", () => describeInterpreter());

  check("better-sqlite3", () => {
    const status = checkAbi();
    if (!status.ok) throw new Error(describeAbi(status));
    return [describeAbi(status), status.addon].join("\n        ");
  });

  check("tmux", () => {
    const version = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();

    const override = tmuxTimeoutOverride();
    return override === null ? version : `${version} (HIVE_TMUX_TIMEOUT_MS=${override}ms override; testing only)`;
  });
  const orphans = orphanScratchServers();
  reportPtyHeadroom(orphans);
  reportOrphanTmuxServers(orphans);
  check("claude", () => execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  check("database", () => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    return `${dataDir} (schema v${n})`;
  });
  check("hooks file", () => ensureHooksFile());

  const here = findProjectForCwd();
  reportDispatcher();
  reportMcpRegistrations(here);
  reportSessionInterpreters();

  const loaded = loadProjectYml(here?.path ?? process.cwd());

  for (const w of loaded.warnings) warn("hive.yml", w);
  const config = loaded.config;
  const profile = activeProfile(config);

  const reportProfile = (name: string, cfg: ReturnType<typeof loadProjectYml>["config"]) => {
    if (!profileExists(name)) {
      fail("profile", `"${name}" is named in hive.yml but is not on this machine. List what you have with: hive profile list`);
      return;
    }
    const resolved = profileStatus(name).files;
    const readable = (file: string) => readProfileFile(name, file) != null;
    if (!resolved.some((f) => readable(f.file))) {
      fail("profile", `"${name}" has a directory but none of its files (${PROFILE_FILES.join(", ")}) resolve to readable content, here or in hive's shipped defaults.`);
      return;
    }
    const hasRunbookPad = here != null && getActivePadByName(here.id, "runbook") != null;
    if (!readable("runbook.md") && !hasRunbookPad) {
      fail("profile", `"${name}" has no readable runbook.md, here or in hive's shipped defaults, so a lead using it starts with no standing process.`);
    }
    const usable = resolved.filter((f) => readable(f.file));
    info("profile", `${name} (${usable.map((f) => `${f.file}: ${f.source}`).join(", ")})`);
    for (const f of resolved) {

      const drift = profileDriftText(f);
      if (drift) (drift.rewrite ? info : warn)("profile", drift.text);
    }

    const referenced = [...new Set(
      // worker.md's vars are per-spawn identity (agent_name, actor_id, ...), never hive.yml vars
      profileFileNames(name)
        .filter((file) => file !== "worker.md")
        .flatMap((file) => {
          const text = readProfileFile(name, file);
          return text ? templateVars(text) : [];
        }),
    )].sort();
    const defined = Object.keys(cfg?.vars ?? {});
    const missing = referenced.filter((v) => !defined.includes(v));
    const unused = defined.filter((v) => !referenced.includes(v));
    if (referenced.length > 0) {
      info("profile vars", `profile files reference ${referenced.join(", ")}`);
      if (missing.length > 0) info("profile vars", `not set here (sections drop): ${missing.join(", ")}`);
      if (unused.length > 0) info("profile vars", `defined but unreferenced: ${unused.join(", ")}`);
    }

    const vars = cfg?.vars ?? {};
    const renderedText = profileFileNames(name)
      .map((file) => renderProfileFile(name, file, vars))
      .filter((t): t is string => t != null)
      .join("\n");
    const pads = referencedPads(renderedText);
    const paths = referencedPaths(renderedText);

    const missingPads = here ? pads.filter((p) => getActivePadByName(here.id, p) == null) : [];

    const projectRoot = here?.path ?? process.cwd();
    const missingPaths = paths.filter((p) => {
      const clean = p.endsWith("/") ? p.slice(0, -1) : p;
      const segments = clean.split("/");
      const last = segments[segments.length - 1];
      const target = last.includes("*") ? segments.slice(0, -1).join("/") : clean;
      return target !== "" && !existsSync(join(projectRoot, target));
    });

    if (missingPads.length > 0) info("profile references", `pad(s) referenced but not here: ${missingPads.join(", ")}`);
    if (missingPaths.length > 0) info("profile references", `path(s) referenced but not here: ${missingPaths.join(", ")}`);
  };

  if (profile) {
    reportProfile(profile, config);
  } else if (here && config?.profile === NO_PROFILE && !getActivePadByName(here.id, "runbook")) {

    fail("profile", `this project ${NO_RUNBOOK_PAD_MESSAGE}`);
  }

  check("stale state", () => {
    const r = janitor();

    if (!r.probed) {

      if (untrustedTmuxServer()) {
        throw new Error(
          `TMUX_TMPDIR points at a private tmux server (${process.env.TMUX_TMPDIR}) while hive is ` +
            `using its default store at ${DEFAULT_DATA_DIR}. Nothing was swept, deliberately: the ` +
            "agents in that store live on the shared tmux server, so this one would report every " +
            "single one of them as dead. Unset TMUX_TMPDIR, or set HIVE_DATA_DIR to a scratch store " +
            "to go with the private server.",
        );
      }
      throw new Error("tmux did not answer, so nothing was swept. Re-run when tmux responds.");
    }
    return `${r.closed_agents} dead agents closed, ${r.cancelled_timers} undeliverable wake-ups cancelled`;
  });

  if (here) {

    const lead = db
      .prepare(
        "SELECT tmux_target, tmux_socket FROM agents WHERE project_id = ? AND kind = ? AND status = 'running' ORDER BY id",
      )
      .get(here.id, LEAD_KIND) as { tmux_target: string; tmux_socket: string } | undefined;
    if (lead) {

      const live = rowLive(lead.tmux_socket, lead.tmux_target);
      if (live === false) {

        warn(
          "lead",
          "the lead's row is running but its pane is not live. The janitor leaves lead rows alone on " +
            "purpose, so nothing will fix this by itself. Run `hive lead` to record a fresh pane and reuse " +
            "this identity, or ask a claude session connected to this project's hive MCP server to call " +
            "the agent_close tool on it to retire the row for good - required before `hive restore`, which " +
            "otherwise refuses while any lead row reads running, and end that session too, since it also " +
            "holds this store open.",
        );
      } else if (live === null) {
        warn("lead", "the lead's pane liveness could not be probed (tmux did not answer).");
      }
    }

    const stuck = db
      .prepare(
        "SELECT name, kind, tmux_socket FROM agents WHERE project_id = ? AND status = 'running' AND kind != ?",
      )
      .all(here.id, LEAD_KIND) as { name: string; kind: string; tmux_socket: string }[];
    for (const row of stuck) {
      if (!foreignSocket(row.tmux_socket)) continue;
      warn(
        `${row.kind} ${row.name}`,
        `recorded on tmux socket ${row.tmux_socket}, but this process would use ` +
          `${tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)}. The janitor cannot judge this row ` +
          "from here, so it stays 'running' - and its name stays taken - until it is probed from wherever " +
          "that socket actually lives.",
      );
    }

    reportUnbriefedWorkers(here.id);

    reportStalledWorkers(here.id);

    reportCrewTeardown(here.id);
  }

  if (here) {
    const workers = db
      .prepare(
        "SELECT name, actor_id, command, kind, tmux_target, tmux_socket FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent' ORDER BY id",
      )
      .all(here.id) as {
      name: string;
      actor_id: string;
      command: string;
      kind: string;
      tmux_target: string;
      tmux_socket: string;
    }[];

    let inputBoxClean = 0;
    let inputBoxDrifted = 0;
    let inputBoxUnclassified = 0;

    let leadsProbed = 0;
    let workersProbed = 0;

    const leadRows = db
      .prepare(
        "SELECT name, command, tmux_target, tmux_socket FROM agents WHERE project_id = ? AND kind = ? AND status = 'running' ORDER BY id",
      )
      .all(here.id, LEAD_KIND) as {
      name: string;
      command: string;
      tmux_target: string;
      tmux_socket: string;
    }[];
    for (const leadBox of leadRows) {
      const leadHarness = harnessFor(leadBox.command);
      if (!leadHarness.classifiesPaneScreen || foreignSocket(leadBox.tmux_socket)) continue;
      leadsProbed += 1;
      const box = leadHarness.paneClassifier!.inputBoxState(leadBox.tmux_target);
      if (box === null) {
        inputBoxUnclassified += 1;
      } else if (box.state === "unknown") {
        inputBoxDrifted += 1;
        warn(
          `lead ${leadBox.name}`,
          "input box classifies 'unknown': an input box is on screen (its own borders were found) but its " +
            "prompt row could not be found inside it. This is the pane a human types into, so the guard that " +
            "protects unsubmitted text is the one at risk (.claude/rules/tmux-and-panes.md, the 'unknown " +
            "exemption' section).",
        );
      } else {
        inputBoxClean += 1;
      }
    }
    let workersReported = 0;
    let dialogCount = 0;

    for (const w of workers) {
      if (!reportsAgentStateLog(w)) continue;
      workersReported += 1;

      const foreign = foreignSocket(w.tmux_socket);
      const { awaitingChoice, tail } = foreign
        ? { awaitingChoice: null, tail: "" }
        : paneChoiceCheck(w.tmux_target);
      if (awaitingChoice === true) dialogCount += 1;

      verboseInfo(
        "worker live state",
        `worker ${w.name}`,
        `last log event: ${describeLastLogEvent(lastLogEvent(w.actor_id))}`,
        `permission mode: ${lastPermissionMode(w.actor_id) ?? "unknown (no record)"}`,
        foreign
          ? `pane: recorded on a different tmux socket (${w.tmux_socket}); this process cannot read it`
          : `pane: ${describePaneChoice(awaitingChoice)}`,
        ...(foreign
          ? ["tail: (not read - foreign socket)"]
          : awaitingChoice === null
            ? ["tail: (pane could not be read)"]
            : tail === ""
              ? ["tail: (pane rendered nothing)"]
              : ["tail:", ...tail.split("\n").map((line) => `| ${line}`)]),
      );

      if (!foreign) {
        workersProbed += 1;
        const box = inputBoxState(w.tmux_target);

        if (box === null) {
          inputBoxUnclassified += 1;
        } else if (box.state === "unknown") {
          inputBoxDrifted += 1;
          warn(
            `worker ${w.name}`,
            "input box classifies 'unknown': an input box is on screen (its own borders were found) but its prompt " +
              "row could not be found inside it (.claude/rules/tmux-and-panes.md, the 'unknown exemption' section).",
          );
        } else {
          inputBoxClean += 1;
        }
      }
    }

    info(
      "worker detail",
      `${workersReported} worker(s)${dialogCount > 0 ? `, ${dialogCount} awaiting a dialog` : ""}; ` +
        "--verbose for last log event, permission mode and pane tail per worker, or `hive status` for live state",
    );

    const inputBoxChecked = inputBoxClean + inputBoxDrifted + inputBoxUnclassified;

    if (inputBoxChecked > 0) {
      info(
        "input box classifier",
        `${inputBoxChecked} running claude box(es) probed (${describeProbed(workersProbed, leadsProbed)}): ` +
          `${inputBoxClean} classified cleanly, ` +
          `${inputBoxDrifted} classified 'unknown', ${inputBoxUnclassified} not classified (no box currently on ` +
          "screen to classify - a dialog, mid-turn, or an unreadable pane)",
      );

      if (inputBoxDrifted > 0) {
        warn(
          "input box classifier",
          inputBoxDrifted === inputBoxChecked
            ? "every probed input box in this project classified 'unknown' - the chrome-change signature, not " +
                "pane-specific noise. The wake hold, agent_send's text refusal and agent_rename's refusal have " +
                `likely reverted to pre-guard behaviour on every pane probed here (${inputBoxChecked}) ` +
                "(.claude/rules/tmux-and-panes.md, the 'unknown exemption' section)."
            : `${inputBoxDrifted} of ${inputBoxChecked} probed input boxes in this project classified 'unknown' - ` +
                "some but not all, so this reads as pane-specific rather than project-wide drift; the guards " +
                "above still work on the other worker(s)' panes.",
        );
      }
    }
  }

  const hiveSessions = (): { sessions: string[]; answered: boolean } => {
    try {
      return {
        sessions: tmux("ls", "-F", "#{session_name}")
          .trim()
          .split("\n")
          .filter((s) => s.startsWith(SESSION_PREFIX)),
        answered: true,
      };
    } catch (e) {

      return { sessions: [], answered: tmuxSaysNothingThere(e) };
    }
  };
  const { sessions: allSessions, answered: tmuxAnswered } = hiveSessions();
  if (!tmuxAnswered) {

    warn(
      "tmux server",
      `tmux did not answer: the call either hit its bound against a server hive itself talks to, or ` +
        "failed in a way that is not an answer about the world at all. Either way the session, window-stamp " +
        "and view-session lines below say unknown rather than none.",
      "the orphaned-scratch-server report above deliberately EXCLUDES this live socket, so it cannot see this " +
        "one either. Resolve it by hand: `tmux display-message -p '#{socket_path}'`, then `tmux -S <path> " +
        "list-sessions` to confirm it is unreachable.",
    );
  }
  check("sessions", () => {
    if (!tmuxAnswered) return "unknown - tmux did not answer";
    const base = allSessions.filter((s) => !isViewSessionName(s));
    return base.length > 0 ? base.join(", ") : "none running";
  });

  check("window stamps", () => {
    const session = sessionName();

    if (!tmuxAnswered) return "unknown - tmux did not answer";

    if (!allSessions.includes(session)) return "no session";
    const byProject = new Map<string, string[]>();
    for (const [window, owner] of listOwnedWindows(session)) {
      if (owner === "") continue;
      byProject.set(owner, [...(byProject.get(owner) ?? []), window]);
    }
    const duplicates = [...byProject.entries()].filter(([, windows]) => windows.length > 1);
    if (duplicates.length > 0) {
      throw new Error(
        duplicates
          .map(
            ([owner, windows]) =>
              `project ${owner} is stamped on ${windows.length} windows (${windows.join(", ")}). ` +
              "Only the lowest-indexed one is ever found, so this project's lead and its workers can end up " +
              "in different tabs. Move the panes into one window (tmux join-pane -t <window>) and " +
              `unstamp the other (tmux set-window-option -t <window> -u @hive-project-id).`,
          )
          .join("\n        "),
      );
    }
    const stamped = [...byProject.keys()].length;
    return stamped > 0 ? `${stamped} project window(s), no duplicates` : "no project windows";
  });

  for (const name of allSessions.filter(isViewSessionName)) {
    let hasClient: boolean;
    try {
      hasClient = tmux("list-clients", "-t", `=${name}`).trim() !== "";
    } catch {

      continue;
    }
    if (hasClient) continue;

    warn(
      "view session",
      `${name} has no attached client, so it did not clean itself up (destroy-unattached should remove a view ` +
        "the instant its client detaches). Not touched here - a view session owns no panes, so removing it can " +
        `never lose a worker's output, but doctor's own posture stops at reporting. Remove it by hand: ` +
        `tmux kill-session -t '=${name}'`,
    );
  }
  check("backups", () => {
    const health = backupHealth(db, dataDir);
    if (!health.ok) throw new Error(health.message);
    return health.message;
  });
  {
    const { value, source } = resolvedAutoAttach();
    info(
      "auto-attach",
      source === "env"
        ? `${value} (HIVE_AUTO_ATTACH override; testing only)`
        : source === "config"
          ? `${value} (set with \`hive setup --auto-attach\`)`
          : `${value} (default; set with \`hive setup --auto-attach\`)`,
    );
  }
  {
    const { mode, source } = resolvedAttachMode();
    info(
      "attach mode",
      source === "env"
        ? `${mode} (HIVE_ATTACH_MODE override; testing only, does not reach auto-attach)`
        : source === "config"
          ? `${mode} (set with \`hive setup --attach\`)`
          : `${mode} (default; set with \`hive setup --attach\`)`,
    );
    if (mode === "raw") {

      try {
        const owned = tmux("list-windows", "-a", "-F", "#{session_name}:#{window_id}\t#{@hive-owned}")
          .trim()
          .split("\n")
          .map((row) => row.split("\t"))

          .filter(([target, marker]) => {
            const [sess] = target.split(":");
            return target.startsWith(SESSION_PREFIX) && marker === "1" && !isViewSessionName(sess);
          });
        for (const [target] of owned) {
          const pane = tmux("list-panes", "-t", target, "-F", "#{pane_id}").trim().split("\n")[0];
          const option = (scope: "-p" | "-w", optionName: string): string =>
            tmux("show-options", scope, "-A", "-v", "-t", scope === "-p" ? pane : target, optionName).trim();
          info(
            `tmux window ${target}`,
            `allow-passthrough ${option("-p", "allow-passthrough")}; ` +
              `pane-border-status ${option("-w", "pane-border-status")}; ` +
              `pane-border-format ${JSON.stringify(option("-w", "pane-border-format"))}; ` +
              `monitor-bell ${option("-w", "monitor-bell")}`,
          );
        }
      } catch {

      }
    }
  }

  if (here) {
    const findings = (
      db
        .prepare(
          `SELECT id, tags, status, archived_at, ${COMMENT_COUNT_SQL} AS comment_count
           FROM todos t WHERE t.project_id = ?`,
        )
        .all(here.id) as {
        id: number;
        tags: string;
        status: string;
        archived_at: string | null;
        comment_count: number;
      }[]
    ).filter((t) => parseTags(t.tags).some(isReviewFindingTag));
    const untriaged = findings.filter(
      (t) => t.comment_count === 0 && t.status !== "completed" && t.archived_at == null,
    );
    info(
      "review findings",
      `${findings.length} tracked (tagged ${REVIEW_FINDING_TAGS.join(", ")}): ` +
        `${findings.length - untriaged.length} triaged, ${untriaged.length} untriaged.`,
    );
    if (untriaged.length > 0) {
      warn(
        "review findings",
        `${untriaged.length} untriaged: ${untriaged.map((t) => `todo ${t.id}`).join(", ")}.`,
        "Triage means a comment recording a decision, or completed/archived - comment with the outcome " +
          "(dispatched, rejected and why, etc.) on each before closing this wave.",
      );
    }
  }

  const problems = failures + (strict ? gatingWarnings : 0);
  const tail = strict
    ? `${warnings} warning(s), ${gatingWarnings} promoted by --strict.`
    : `${warnings} warning(s).`;
  console.log(
    failures === 0 && warnings === 0 ? "\nAll good." : `\n${problems} problem(s) found, ${tail}`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

function cmdStatusline(): void {
  let project: Project | null;
  try {
    project = pinnedOrCwdProject();
  } catch {

    return;
  }
  if (!project) return;
  const count = (sql: string) => (db.prepare(sql).get(project.id) as { n: number }).n;
  const agents = count(
    "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent'",
  );
  const commands = count(
    "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'command'",
  );

  const todos = count(
    "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status IN ('open', 'in_progress') AND archived_at IS NULL",
  );
  const ready = count(
    `SELECT COUNT(*) AS n FROM todos t
     WHERE t.project_id = ? AND t.status IN ('open', 'in_progress') AND t.archived_at IS NULL
       AND NOT EXISTS (${OPEN_BLOCKERS_SQL})`,
  );
  const pads = count("SELECT COUNT(*) AS n FROM scratchpads WHERE project_id = ? AND archived = 0");
  const wakes = count(`SELECT COUNT(*) AS n FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`);

  // One statement, not two: the count and the chosen row must come from the same read, or a wake that
  // delivers/re-arms between two separate queries leaves the second with no row to read.
  const held = db
    .prepare(
      `WITH chosen AS (
         SELECT held_reason, first_held_at FROM timers
          WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE} AND held_at IS NOT NULL
          ORDER BY (held_reason LIKE ?) DESC, (held_reason LIKE ?) ASC,
                   first_held_at IS NULL ASC, first_held_at ASC
          LIMIT 1
       )
       SELECT
         (SELECT COUNT(*) FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE} AND held_at IS NOT NULL) AS n,
         (SELECT held_reason FROM chosen) AS held_reason,
         (SELECT first_held_at FROM chosen) AS first_held_at`,
    )
    .get(
      project.id,
      `${HELD_REASON_UNSUBMITTED_INPUT_PREFIX}%`,
      `${HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX}%`,
      project.id,
    ) as {
    n: number;
    held_reason: string | null;
    first_held_at: string | null;
  };

  if (agents + commands + todos + pads + wakes === 0) return;

  const s = (n: number) => (n === 1 ? "" : "s");
  const parts = [
    `${agents} agent${s(agents)}`,
    `${todos} todo${s(todos)}${todos > 0 ? ` (${ready} ready)` : ""}`,
    `${pads} pad${s(pads)}`,
  ];
  if (commands > 0) parts.push(`${commands} cmd${s(commands)}`);
  if (wakes > 0) parts.push(`${wakes} wake${s(wakes)}`);
  if (held.n > 0) {
    const age = held.first_held_at ? humanizeAge(ageSecondsSince(held.first_held_at)) : "?";
    parts.push(`${held.n} held (${age}, ${heldReasonLabel(held.held_reason)})`);
  }
  console.log(`\x1b[33m⬡\x1b[0m \x1b[2mhive:\x1b[0m ${parts.join(" \x1b[2m·\x1b[0m ")}`);
}

// test/docs.test.mjs fails if a label here is missing from README.md or docs/install.md. It checks
// presence only: docs/install.md also counts the set in prose, and nothing guards that number.
export const HELD_REASON_LABELS = ["typing", "talking", "needs you", "blocked"] as const;

export function heldReasonLabel(heldReason: string | null): (typeof HELD_REASON_LABELS)[number] {
  if (isUnsubmittedInputHold(heldReason)) return "typing";
  if (
    heldReason === HELD_REASON_LEAD_PANE_DEAD ||
    wasHeldForPaneReissue(heldReason) ||
    isUnclassifiablePaneHold(heldReason)
  ) {
    return "needs you";
  }
  if (heldReason === HELD_REASON_CONVERSATION) return "talking";
  return "blocked";
}

function padSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pad";
}

const padExportPrefix = (projectId: number, name: string) =>
  `hive-pad-${projectId}-${padSlug(name)}.r`;

function findPadExports(projectId: number, name: string): string[] {
  const prefix = padExportPrefix(projectId, name);
  return readdirSync(tmpdir())
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => join(tmpdir(), f));
}

function cmdBackups(): void {
  const snapshots = listSnapshots(dataDir);
  if (snapshots.length === 0) {
    console.log(`No backups yet in ${backupsDir(dataDir)}.`);
    console.log("They are taken automatically before migrations and hourly while any hive session is open.");
    return;
  }
  for (const s of snapshots) {
    console.log(
      `${s.name}  ${s.reason.padEnd(9)} ${formatBytes(s.sizeBytes).padStart(7)}  ${s.createdAt.toISOString()}`,
    );
  }
  console.log(`\n${snapshots.length} backup(s), ${formatBytes(totalSizeBytes(snapshots))} total, in ${backupsDir(dataDir)}`);
  console.log(`Restore one with: hive restore <name>`);
}

function activeHiveUsage(): string[] {
  const reasons: string[] = [];
  const runningNonLeads = (
    db.prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'running' AND kind != ?").get(LEAD_KIND) as {
      c: number;
    }
  ).c;
  if (runningNonLeads > 0) reasons.push(`${runningNonLeads} agent(s)/command(s) recorded as running`);

  const leadRows = (
    db.prepare("SELECT COUNT(*) AS c FROM agents WHERE status = 'running' AND kind = ?").get(LEAD_KIND) as {
      c: number;
    }
  ).c;
  if (leadRows > 0) {

    reasons.push(
      `${leadRows} lead session(s) recorded as running - run \`hive doctor\` to check whether each is ` +
        "actually live; a confirmed-dead one can be retired by asking a claude session connected to this " +
        "project's hive MCP server to call the agent_close tool on it, which lets a later restore proceed " +
        "without --force. End that session before restoring either way, since it holds this store open too.",
    );
  }

  try {

    const sessions = tmux("ls", "-F", "#{session_name}")
      .trim()
      .split("\n")

      .filter((s) => s.startsWith(SESSION_PREFIX) && !isViewSessionName(s));
    if (sessions.length > 0) reasons.push(`tmux session(s) still running: ${sessions.join(", ")}`);
  } catch (e) {

    if (!tmuxSaysNothingThere(e)) {
      reasons.push(
        "tmux did not answer, so whether hive sessions are still running is UNKNOWN - the server may be " +
          `wedged, or the probe failed for another reason: ${errorMessage(e)}. A restore ` +
          "overwrites this store, so an unanswered probe blocks rather than passes. Confirm by hand with " +
          "`tmux display-message -p '#{socket_path}'` and `tmux -S <path> list-sessions`; reap a wedged " +
          "server before restoring, or pass --force if you are certain nothing is using this store.",
      );
    }

  }
  return reasons;
}

async function cmdRestore(argv: string[]): Promise<void> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const force = argv.includes("--force");
  const name = argv.find((a) => !a.startsWith("-"));
  if (!name) {
    console.log("Usage: hive restore <name> [--yes] [--force]");
    console.log("List available snapshots with: hive backups");
    process.exit(1);
  }

  let preview;
  try {
    preview = previewRestore(dataDir, name);
  } catch (e) {
    console.log(errorMessage(e));
    process.exit(1);
  }

  const activity = activeHiveUsage();
  if (activity.length > 0 && !force) {
    console.log("Refusing to restore: this store looks like it is still in use.");
    for (const reason of activity) console.log(`  ${reason}`);
    console.log(
      "Close those sessions first, or pass --force: a server on this version will refuse every " +
        "hive tool once it notices (up to one tick of writes lost first); an older server has no " +
        "such guard and will keep writing to a file that no longer exists until it exits, losing " +
        "that work silently.",
    );
    process.exit(1);
  }

  console.log("This will overwrite:");
  console.log(
    `  ${preview.currentDbPath}` +
      (preview.currentDbExists ? ` (${formatBytes(preview.currentDbSizeBytes)})` : " (does not exist yet)"),
  );
  if (preview.hasProfiles) console.log(`  ${join(dataDir, "profiles")}`);
  console.log(
    `with the snapshot "${preview.snapshot.name}" (${formatBytes(preview.snapshot.sizeBytes)}, ` +
      `${preview.snapshot.reason}, taken ${preview.snapshot.createdAt.toISOString()}).`,
  );
  console.log("\nRestart every other hive session using this store once this completes.");

  if (!yes) {
    const confirmed = await confirmYesNo("Overwrite the live store with this snapshot? [y/N] ");
    if (confirmed === null) {
      console.log("Not restored: run hive interactively to confirm, or pass --yes.");
      return;
    }
    if (!confirmed) {
      console.log("Not restored.");
      return;
    }
  }

  const preRestoreBackup = backupNow(db, dataDir, "manual", new Set([preview.snapshot.name]));
  if (preRestoreBackup.ok) {
    console.log(`Snapshotted the current store first: ${preRestoreBackup.path}`);
  } else {
    console.log(`Warning: could not snapshot the current store before restoring: ${preRestoreBackup.error}`);
  }

  db.close();
  const { restoredProfiles } = restoreSnapshot(dataDir, name);
  console.log(`Restored hive.db from "${name}"${restoredProfiles ? " (and profiles/)" : ""}.`);
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

function cmdTodos(argv: string[]): void {
  const project = pinnedOrCwdProject();
  if (!project) return;

  const all = argv.includes("--all");
  const statusIdx = argv.indexOf("--status");
  const status = flagValue(argv, "--status");

  if (statusIdx !== -1 && (status === undefined || status.startsWith("--"))) {
    console.log(`Usage: hive todos --status <s>  where <s> is one of: ${TODO_STATUSES.join(", ")}`);
    process.exit(1);
  }
  if (status !== undefined && !(TODO_STATUSES as readonly string[]).includes(status)) {
    console.log(`Unknown status "${status}". Valid: ${TODO_STATUSES.join(", ")}`);
    process.exit(1);
  }
  const tagIdx = argv.indexOf("--tag");
  const tag = flagValue(argv, "--tag");

  if (tagIdx !== -1 && (tag === undefined || tag.startsWith("--"))) {
    console.log("Usage: hive todos --tag <t>");
    process.exit(1);
  }

  const statuses = all ? undefined : status ? [status] : ["open", "in_progress"];

  const { todos, total_count } = listTodoSummaries(project.id, {
    statuses,
    tags: tag ? [tag] : undefined,
  });
  if (todos.length === 0) {

    const statusDesc = all ? "" : status ? `${status} ` : "open ";
    const tagDesc = tag ? ` with tag "${tag}"` : "";
    const hint = all ? "" : " Try --all.";
    console.log(`No ${statusDesc}todos in project "${project.name}"${tagDesc}.${hint}`);
    return;
  }

  const width = Math.max(...todos.map((t) => String(t.todo_id).length));
  for (const t of todos) {

    const blocked = t.is_blocked ? "blocked" : "";
    console.log(
      `#${String(t.todo_id).padEnd(width)}  ${t.status.padEnd(11)} ${blocked.padEnd(8)} ${t.title}`,
    );
  }

  if (total_count > todos.length) {
    console.log(`\n...and ${total_count - todos.length} more not shown. Narrow with --status or --tag.`);
  }
}

function cmdTodo(argv: string[]): void {
  const project = pinnedOrCwdProject();
  if (!project) return;

  const id = Number(argv.find((a) => !a.startsWith("--")));
  if (!Number.isInteger(id)) {
    console.log("Usage: hive todo <id>  (run inside the project)");
    process.exit(1);
  }
  let d: TodoDetail;
  try {
    d = getTodoDetail(project.id, id, true);
  } catch {
    console.log(`No todo with id ${id} in project "${project.name}". List them with: hive todos --all`);
    process.exit(1);
  }

  console.log(`#${d.todo_id} ${d.title}`);
  console.log(
    `status ${d.status}   priority ${d.priority}${d.is_blocked ? "   blocked" : ""}${d.archived ? "   archived" : ""}`,
  );
  if (d.tags.length > 0) console.log(`tags ${d.tags.join(", ")}`);
  if (d.body) console.log(`\n${d.body}`);

  if (d.blockers.length > 0) {
    console.log(`\nblocked by:`);
    for (const b of d.blockers) console.log(`  #${b.id} [${b.status}] ${b.title}`);
  }
  if (d.blocking.length > 0) {
    console.log(`\nblocks:`);
    for (const b of d.blocking) console.log(`  #${b.id} [${b.status}] ${b.title}`);
  }

  const comments = d.comments ?? [];
  if (comments.length > 0) {
    console.log(`\ncomments:`);
    for (const c of comments) {
      console.log(`\n[${c.author} @ ${c.created_at}]`);
      console.log(c.body);
    }
  }
}

function cmdPads(): void {
  const project = resolveProject();
  const pads = listActivePads(project.id);
  if (pads.length === 0) {
    console.log(`No pads in project "${project.name}".`);
    return;
  }
  const width = Math.max(...pads.map((p) => p.name.length));
  for (const p of pads) {
    console.log(
      `${p.name.padEnd(width)}  rev ${String(p.revision).padStart(3)}  ${String(p.content_length).padStart(6)} chars  ${p.updated_by ?? "?"} @ ${p.updated_at}`,
    );
  }
}

function cmdPad(argv: string[]): void {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.log("Usage: hive pad <name> [--edit | --save [file]]  (run inside the project)");
    process.exit(1);
  }
  const project = resolveProject();
  const pad = getActivePadByName(project.id, name);
  if (!pad) {
    console.log(`No pad named "${name}" in project "${project.name}". List them with: hive pads`);
    process.exit(1);
  }

  if (argv.includes("--edit")) {
    const existing = findPadExports(project.id, name);
    if (existing.length > 0) {
      console.log(`An unsaved export already exists:\n  ${existing.join("\n  ")}`);
      console.log(`Save it with: hive pad "${name}" --save   (or delete the file to discard)`);
      process.exit(1);
    }
    const file = join(tmpdir(), `${padExportPrefix(project.id, name)}${pad.revision}.md`);
    try {

      writeFileSync(file, pad.content, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        console.log(`A file already exists at ${file}; refusing to overwrite it. Save or delete it first.`);
        process.exit(1);
      }
      throw e;
    }

    const editor = process.env.HIVE_EDITOR || "open";
    const [cmd, ...cmdArgs] = editor.split(/\s+/);
    spawn(cmd, [...cmdArgs, file], { detached: true, stdio: "ignore" }).unref();
    console.log(file);
    console.log(`Opened "${name}" (rev ${pad.revision}) with ${cmd}. After saving your edits, write back with:`);
    console.log(`  hive pad "${name}" --save`);
    return;
  }

  if (argv.includes("--save")) {
    let file = positional[1];
    if (!file) {
      const matches = findPadExports(project.id, name);
      if (matches.length === 0) {
        console.log(`No exported file for "${name}" in ${tmpdir()}. Export one with: hive pad "${name}" --edit`);
        process.exit(1);
      }
      if (matches.length > 1) {
        console.log(`Multiple exports found; pass one explicitly:\n  ${matches.join("\n  ")}`);
        process.exit(1);
      }
      file = matches[0];
    }
    const content = readFileSync(file, "utf8");
    const marker = /\.r(\d+)\.md$/.exec(file);
    const expected = marker ? Number(marker[1]) : pad.revision;
    if (content === pad.content) {
      unlinkSync(file);
      console.log(`No changes; "${name}" left at rev ${pad.revision}. Removed ${file}.`);
      return;
    }
    try {
      const newRevision = overwritePadContent(project.id, pad.id, content, expected);
      unlinkSync(file);
      console.log(`Saved "${name}": rev ${expected} -> ${newRevision}. Removed ${file}.`);
    } catch (e) {
      console.log(errorMessage(e));
      console.log(`Your edits are untouched in ${file}.`);
      console.log(`Someone changed the pad since the export. Compare with: hive pad "${name}"`);
      console.log(`Then merge into the file and save with: hive pad "${name}" --save ${file}`);
      process.exit(1);
    }
    return;
  }

  process.stdout.write(withTrailingNewline(pad.content));
}

const args = process.argv.slice(2);
let command = args[0] ?? "lead";
let rest = args.slice(1);
if (command === "--help" || command === "-h" || command === "help") usage();
if (command === "--version" || command === "-v") {
  const { line, drift } = versionInfo();
  console.log(line);
  if (drift) console.log(`! ${drift}`);
  process.exit(0);
}
const COMMANDS = [
  "lead", "init", "attach", "start", "status", "setup", "doctor",
  "pads", "pad", "todos", "todo", "backups", "restore", "runbook", "posture", "profile", "kickoff", "statusline",
];
if (!COMMANDS.includes(command)) {

  if (command.startsWith("--")) {
    rest = args;
    command = "lead";
  } else if (existsSync(command)) {
    rest = [command, ...rest];
    command = "lead";
  } else {
    usage();
  }
}
migrate();

try {
  switch (command) {
    case "lead":
      await cmdLead(rest);
      break;
    case "init":
      await cmdInit(rest);
      break;
    case "attach":
      cmdAttach(rest);
      break;
    case "start":
      await cmdStart(rest[0], rest[1]);
      break;
    case "status":
      cmdStatus();
      break;
    case "setup":
      cmdSetup(rest);
      break;
    case "doctor":
      cmdDoctor(rest);
      break;
    case "pads":
      cmdPads();
      break;
    case "pad":
      cmdPad(rest);
      break;
    case "todos":
      cmdTodos(rest);
      break;
    case "todo":
      cmdTodo(rest);
      break;
    case "backups":
      cmdBackups();
      break;
    case "restore":
      await cmdRestore(rest);
      break;
    case "runbook":
      cmdRunbook(rest[0]);
      break;
    case "posture":
      cmdPosture(rest[0]);
      break;
    case "profile":
      cmdProfile(rest);
      break;
    case "kickoff":

      await (await import("./kickoff.js")).runKickoff(rest);
      break;
    case "statusline":
      cmdStatusline();
      break;
  }
} catch (e) {
  console.log(errorMessage(e));
  process.exit(1);
}
