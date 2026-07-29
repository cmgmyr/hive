#!/usr/bin/env node
// hive CLI: open a project's orchestration session and manage its commands.
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
import { checkAbi, describeAbi, describeInterpreter } from "./abi.js";
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
import { dataDir, db, migrate } from "./db.js";
import {
  currentActor,
  effectiveProjectId,
  findProjectForCwd,
  getProject,
  listProjects,
  type Project,
} from "./context.js";
import { ensureHooksFile } from "./hooks.js";
import { errorMessage, withTrailingNewline } from "./result.js";
import { ACTIVE_TIMER_WHERE, janitor } from "./scheduler.js";
import { closeAgentRow, launchAgent } from "./spawn.js";
import {
  claimInitialWindow,
  ensureSession,
  SESSION_PREFIX,
  sessionName,
  shellQuote,
  tmux,
  targetLive,
  windowTitle,
} from "./tmux.js";
import {
  activeProfile,
  configHash,
  loadProjectYml,
  NO_PROFILE,
  resolveCommandDir,
  type YmlProcess,
} from "./projectYml.js";
import { isClaudeCommand, writeProjectPosture } from "./brief.js";
import {
  checkoutRoot,
  createProfile,
  forkProfile,
  PROFILE_FILES,
  ProfileError,
  profileExists,
  profileNames,
  profileStatus,
  readProfileFile,
  renderProfileFile,
  resolveProfileFile,
  templateVars,
  userProfilesDir,
  type ProfileFile,
} from "./profiles.js";
import { OPEN_BLOCKERS_SQL } from "./tools/todos.js";
import {
  createPad,
  getActivePadByName,
  listActivePads,
  overwritePadContent,
} from "./tools/pads.js";

function usage(): never {
  console.log(`hive — shared memory and coordination for Claude Code sessions

Usage:
  hive [path]                open the project's session with a lead window
  hive lead [path]           same; lead is the default command
  hive init [path] [--profile <name>|--no-profile]
                             set the project up: hive.yml, profile, starter pads
  hive attach [path]         attach without adding windows
  hive start <process> [path] start one hive.yml process by name
  hive status                overview of agents, todos, and wake-ups everywhere
  hive setup [--dir <dir>]   write a \`hive\` that runs the interpreter this build
                             was compiled for; re-run after every update
  hive doctor                check the environment and clean up stale state
  hive pads                  list the current project's pads
  hive pad <name>            print a pad's content
  hive pad <name> --edit     export to a temp file and open your markdown editor
  hive pad <name> --save     write the edited export back (revision-guarded)
  hive runbook               this project's standing process, vars resolved
  hive posture               the posture text this project's lead starts with
  hive kickoff [--explain]   SessionStart hook output; silent unless this is a lead checkout
  hive profile [list|path|fork|create]  standing instructions shared across projects
  hive statusline            one-line store summary; silent outside hive projects

hive lead reads hive.yml from the project root when present; hive init
writes this starter file (uncomment what you need):

${HIVE_YML_TEMPLATE.trimEnd().replace(/^/gm, "  ")}

Repo-defined commands run only after a one-time interactive approval; any
change to a command re-requires it. In iTerm, lead/attach use control mode:
the lead, workers, and commands all appear as native windows and panes.`);
  process.exit(1);
}

function resolveProject(path?: string): Project {
  if (path) process.chdir(path);
  return getProject(effectiveProjectId())!;
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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("Trust and run this command from now on? [y/N] ");
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(`Skipped "${name}".`);
    return false;
  }
  db.prepare(
    "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
  ).run(projectId, name, hash);
  return true;
}

function startYmlCommand(project: Project, name: string, proc: YmlProcess): string {
  const existing = db
    .prepare("SELECT id, tmux_target FROM agents WHERE project_id = ? AND name = ? AND status = 'running'")
    .get(project.id, name) as { id: number; tmux_target: string } | undefined;
  if (existing) {
    const live = targetLive(existing.tmux_target);
    if (live) return "already running";
    // Unknown liveness must not start a second copy. These are hive.yml
    // processes, so a duplicate is a second dev server fighting for the port
    // while the first one's row is closed and nothing tracks it any more.
    // That is a write to the world, not just to the store.
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

function attach(session: string, project: Project): void {
  if (process.env.TMUX) {
    spawnSync("tmux", ["switch-client", "-t", `=${session}`], { stdio: "inherit" });
    return;
  }
  if (!process.stdout.isTTY) {
    console.log(`Session ${session} is ready for project "${project.name}" (${project.path}).`);
    console.log(
      `Attach from a terminal with: tmux ${process.env.TERM_PROGRAM === "iTerm.app" ? "-CC " : ""}attach -t ${session}`,
    );
    return;
  }
  const controlMode = process.env.TERM_PROGRAM === "iTerm.app";
  const result = spawnSync(
    "tmux",
    [...(controlMode ? ["-CC"] : []), "attach", "-t", `=${session}`],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 0);
}

async function cmdLead(path?: string): Promise<void> {
  const project = resolveProject(path);
  const session = sessionName(project.id);
  ensureHooksFile();

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

  // Posture rides in the system prompt: prompt-cached, uncompactable, and
  // impossible for the lead to forget. A profile named in a committed
  // hive.yml that this machine does not have must never be an error; the
  // lead just starts without it, and hive doctor says so.
  const profile = activeProfile(config);
  if (profile) {
    const posture = resolveProfileFile(profile, "posture.md");
    if (!posture) {
      console.log(`! profile "${profile}" has no posture.md on this machine; starting without it.`);
    } else if (!isClaudeCommand(leadCommand)) {
      console.log(`! lead command is not claude; skipping profile "${profile}" posture.`);
    } else {
      // The flag takes a path, so the vars are resolved into a generated file
      // rather than into the profile. `hive posture` prints the same text.
      const rendered = renderProfileFile(profile, "posture.md", config?.vars ?? {}) ?? "";
      const path = writeProjectPosture(project.id, rendered);
      leadCommand += ` --append-system-prompt-file ${shellQuote(path)}`;
      console.log(`- profile: ${profile} (${posture.source} posture; see it with: hive posture)`);
    }
  }

  // The lead launches before auto-start processes so that on a fresh session
  // it claims the initial window rather than one of them.
  const leadTitle = windowTitle(project.name, "lead");
  if (ensureSession(session, project.path)) {
    claimInitialWindow(session, leadTitle, project.path, [], leadCommand);
  } else {
    const windows = tmux("list-windows", "-t", `=${session}`, "-F", "#{window_name}").split("\n");
    if (!windows.includes(leadTitle)) {
      tmux("new-window", "-t", `=${session}`, "-n", leadTitle, "-c", project.path, leadCommand);
    }
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

  attach(session, project);
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
- Do not poll workers. Use wake_when_idle and go quiet.
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

// Claude Code relocates its whole state tree, plugins included, when
// CLAUDE_CONFIG_DIR is set. Keying off homedir() alone reports "not installed"
// to anyone using a custom config dir, and prints them an install command that
// puts the symlink where their claude will never look.
export const claudeConfigDir = () =>
  process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");

const pluginLinkPath = () => join(claudeConfigDir(), "skills", "hive");

// Printed paths keep the ~ shorthand only when that is where it actually
// resolves; a custom config dir gets the real path, since the reader has to be
// able to paste it.
const displayLinkPath = () => {
  const path = pluginLinkPath();
  const fromHome = join(homedir(), ".claude", "skills", "hive");
  return path === fromHome ? "~/.claude/skills/hive" : path;
};

// The session-start plugin is one symlink per MACHINE, not per project, so
// `hive init` in the second project should not advertise something already
// installed. hive never creates or removes it; it only reports what it finds.
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
  // Compared by real path: the documented install is a symlink, but a copied
  // directory or a link into another checkout both resolve here too, and the
  // second one silently runs a different hive's kickoff.
  return target === expected ? { state: "linked" } : { state: "elsewhere", target };
}

const PROFILE_BLURBS: Record<string, string> = {
  orchestration: "a lead that plans and delegates to workers in tmux",
  simple: "one session doing the work itself; hive is shared memory",
  [NO_PROFILE]: "project-only; hive seeds a runbook pad you fill in",
};

// Asked only when stdin is a TTY and hive.yml has not answered already.
// An absent profile key means "never asked", which is what lets a later
// `hive init` offer this without nagging anyone who declined.
async function askForProfile(): Promise<string | null> {
  // One list drives both the menu and the answer, so a forked profile shows
  // up without touching the parsing below.
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

// Appends the key rather than rewriting the file: hive.yml is the human's,
// and everything else in it (comments, processes, placement) must survive.
function writeProfileKey(ymlPath: string, profile: string): void {
  const existing = readFileSync(ymlPath, "utf8");
  const block = `\n# Standing instructions for this project (hive profile list).\nprofile: ${profile}\n`;
  writeFileSync(ymlPath, existing.endsWith("\n") ? existing + block : `${existing}\n${block}`);
}

async function cmdInit(argv: string[]): Promise<void> {
  const noProfile = argv.includes("--no-profile");
  const profileFlagIndex = argv.indexOf("--profile");
  // The value after --profile is not the path argument.
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
  // A profile already in hive.yml always wins. Changing it is a one-line hand
  // edit, not something a setup command does to a committed file behind you.
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

  // A project with a profile reads its process from `hive runbook`, so a
  // runbook pad would be a second source of truth nobody updates. Seed one
  // only when the project decided against a profile, or has not decided yet.
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

// The lead's standing process, resolved from the project's profile with
// hive.yml vars substituted. A project on `profile: none` keeps its process in
// the runbook pad, so print that instead of sending the lead somewhere else.
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
        ? `This project is on "profile: none" but has no runbook pad. Create one with: hive init`
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

// What the lead is actually running with. `hive lead` renders posture.md into
// a generated file and points --append-system-prompt-file at that, so
// `hive profile path` shows the unrendered source and nothing else would show
// the text the model really got.
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

Files in a profile: ${PROFILE_FILES.join(", ")}`);
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
        // Works anywhere, so the current project is a bonus, not a requirement.
        const here = findProjectForCwd();
        const current = here ? activeProfile(loadProjectYml(here.path).config) : null;
        for (const profile of names) {
          const status = profileStatus(profile);
          console.log(`${profile === current ? "*" : " "} ${profile}`);
          for (const f of status.files) {
            const drift = f.upstreamMoved ? "   (hive's default changed since you forked)" : "";
            console.log(`    ${f.file.padEnd(11)} ${f.source.padEnd(7)} ${f.path}${drift}`);
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

function cmdAttach(path?: string): void {
  const project = resolveProject(path);
  const session = sessionName(project.id);
  ensureSession(session, project.path);
  attach(session, project);
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
  for (const project of listProjects()) {
    const agents = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND status = 'running' ORDER BY kind DESC, id")
      .all(project.id) as {
      kind: string;
      name: string;
      agent_state: string;
      tmux_target: string;
      cwd: string;
    }[];
    const todos = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status IN ('open', 'in_progress')",
        )
        .get(project.id) as { n: number }
    ).n;
    const timers = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`)
        .get(project.id) as { n: number }
    ).n;
    if (agents.length === 0 && todos === 0 && timers === 0) continue;
    anyOutput = true;
    console.log(`\n${project.name}  (${project.path})  session: ${sessionName(project.id)}`);
    for (const a of agents) {
      const state = a.kind === "agent" ? a.agent_state : "running";
      console.log(`  ${a.kind === "command" ? "cmd  " : "agent"}  ${a.name.padEnd(20)} ${state}`);
    }
    if (agents.length === 0) console.log("  no running agents or commands");
    console.log(`  open todos: ${todos}   pending wake-ups: ${timers}`);
  }
  if (!anyOutput) console.log("Nothing running and no open work in any project.");
}

// doctor's two non-failing levels, beside check()'s ok/FAIL. The prefix width
// and the continuation indent are load-bearing (the suite asserts on the
// spacing), so they live in one place rather than being retyped per line.
const report = (level: string, label: string, lines: string[]) => {
  console.log(`  ${level}  ${label}: ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`        ${line}`);
};
const info = (label: string, ...lines: string[]) => report("info", label, lines);
const warn = (label: string, ...lines: string[]) => report("warn", label, lines);

function cmdSetup(argv: string[]): void {
  const dirFlag = argv.indexOf("--dir");
  const dir = dirFlag >= 0 ? resolve(argv[dirFlag + 1] ?? "") : dispatcherDir();
  const file = join(dir, "hive");
  const node = process.execPath;
  const cli = cliPath();

  const existing = readDispatcher(file);
  if (existing && !existing.mine && !argv.includes("--force")) {
    // Almost always npm link's shim, and overwriting someone else's `hive`
    // without being asked is not hive's call to make. A file hive wrote is
    // always repairable, even when an older version wrote it in a shape this
    // one cannot parse: repairing it is what setup is for.
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
  console.log("\nThat is the interpreter that built better-sqlite3 here, so the dispatcher");
  console.log("and the addon cannot disagree about the ABI.");

  console.log("");
  for (const line of durabilityLines(node)) console.log(line);

  console.log("\nA rebuild does not re-pin anything on its own. After every update:");
  console.log("  npm install && npm run build && hive setup");
  console.log(`\nPATH: ${pathAdvice(dir, file).join("\n")}`);
  reportSetupRegistrations(node);
}

// The half setup does not fix. Pinning the `hive` command says nothing about
// the MCP server: Claude Code starts that from its own registration, and the
// issue calls it the invisible failure precisely because fixing the command
// looks like fixing everything. Setup is the moment a user is already acting
// on instructions, so a registration that disagrees with the pin gets named
// here rather than waiting for them to run doctor.
//
// Conditional on purpose. A correct registration prints nothing: handing
// someone a command to run when they have nothing to fix trains them to
// ignore the ones that matter.
//
// Silent when nothing is registered, which is the case worth explaining.
// Setup cannot tell "not registered" from "registered somewhere I cannot
// see": it looks at one config dir and, at best, one project's .mcp.json,
// while a registration can live in any project on the machine or under
// another CLAUDE_CONFIG_DIR. Announcing an absence hive cannot establish
// would be wrong on every update for anyone who registered elsewhere. A fresh
// install gets that line from the README, one step below this command, and
// `hive doctor` reports it as info from inside a project.
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
  // No "!" here: nothing is wrong. A config that lists MCP servers without
  // hive is a fresh install partway through the README, so this reads as the
  // next step rather than a fault. registrationOffer decides when that claim
  // can be made at all.
  const offer = registrationOffer(pinned, found);
  if (offer) {
    console.log("");
    for (const line of offer) console.log(`  ${line}`);
  }
}

// doctor's half of the same question, asked the way a human asks it: what does
// typing `hive` actually run. Warn, never fail: hive works without a
// dispatcher on a machine with one Node, and the dispatcher is worth having
// only where the working directory can change the answer.
function reportDispatcher(): void {
  const onPath = firstHiveOnPath();
  // Whatever wins on PATH is the honest answer, including a dispatcher written
  // somewhere else with --dir. The default location is the fallback, so a
  // dispatcher that exists but loses to a shim still gets reported.
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
    warn("dispatcher", "written by another version of hive; re-run `hive setup` to refresh it.");
  } else if (!existsSync(dispatcher.node)) {
    warn(
      "dispatcher",
      "that interpreter is gone (a version manager can remove one).",
      "Rebuild and re-pin: npm install && npm run build && hive setup",
    );
  } else if (dispatcher.node !== process.execPath || dispatcher.cli !== cliPath()) {
    warn(
      "dispatcher",
      "pinned to a different build than this CLI is running.",
      `this run: ${process.execPath} ${cliPath()}`,
      "Re-pin after a rebuild: npm run build && hive setup",
    );
  }
  if (onPath !== dispatcher.file) warn("dispatcher", ...pathAdvice(dispatcherDir(), dispatcher.file));
}

// Warn, never fail. A machine with no version manager is fine with a bare
// `node`, and doctor must not fail over a registration it cannot see: hive
// can be perfectly installed and never registered from this directory.
function reportMcpRegistrations(project: Project | null): void {
  const registrations = hiveRegistrations(project?.path ?? null);
  if (registrations.length === 0) {
    info(
      "mcp registration",
      "none found for hive (checked ~/.claude.json and .mcp.json)",
      // Same helper as setup, so the fresh-install offer reads identically
      // wherever a user meets it, and stays silent in the same three states.
      ...(registrationOffer(process.execPath, registrations) ?? []),
    );
    return;
  }
  for (const r of registrations) {
    const where = `mcp registration (${r.scope} scope)`;
    info(where, [r.command, ...r.args].join(" "));
    const problem = registrationProblem(r, process.execPath);
    if (problem) warn(where, ...problem);
  }
}

function cmdDoctor(): void {
  let failures = 0;
  const check = (label: string, fn: () => string) => {
    try {
      console.log(`  ok    ${label}: ${fn()}`);
    } catch (e) {
      failures += 1;
      console.log(`  FAIL  ${label}: ${errorMessage(e)}`);
    }
  };
  console.log("hive doctor\n");
  check("node", () => describeInterpreter());
  // Unfailable in practice, and printed anyway: db.ts already guarded this
  // before main() got here, so a mismatch never reaches doctor's body. The
  // line is here so a working install still says which ABI it is pinned to,
  // which is the number a human needs when comparing two interpreters.
  check("better-sqlite3", () => {
    const status = checkAbi();
    if (!status.ok) throw new Error(describeAbi(status));
    return [describeAbi(status), status.addon].join("\n        ");
  });
  check("tmux", () => execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim());
  check("claude", () => execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  check("database", () => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    return `${dataDir} (schema v${n})`;
  });
  check("hooks file", () => ensureHooksFile());
  // Everything below is reported, never failed. A parse warning already has a
  // fallback, hive cannot tell a deliberately omitted var from a forgotten one,
  // and a hive.yml naming a profile a teammate does not have is a normal state,
  // not a broken install. Doctor read the profile out of hive.yml but never
  // looked at the parse, so a malformed one used to pass a clean run.
  const here = findProjectForCwd();
  reportDispatcher();
  reportMcpRegistrations(here);
  const loaded = here ? loadProjectYml(here.path) : null;
  for (const w of loaded?.warnings ?? []) warn("hive.yml", w);
  const config = loaded?.config ?? null;
  const profile = activeProfile(config);
  if (here && profile) {
    const files = profileStatus(profile).files;
    if (files.length === 0) {
      warn("profile", `"${profile}" is named in hive.yml but is not on this machine`);
    } else {
      info("profile", `${profile} (${files.map((f) => `${f.file}: ${f.source}`).join(", ")})`);
      for (const f of files) {
        if (f.upstreamMoved) warn("profile", `hive's default ${f.file} changed since you forked it`);
      }
      // Both files the project supplies vars to. worker.md is left out on
      // purpose: its vars include the agent identity hive fills in per spawn,
      // which would always read as "not set here".
      const referenced = [...new Set(
        ["runbook.md", "posture.md"].flatMap((file) => {
          const text = readProfileFile(profile, file as ProfileFile);
          return text ? templateVars(text) : [];
        }),
      )].sort();
      const defined = Object.keys(config?.vars ?? {});
      const missing = referenced.filter((v) => !defined.includes(v));
      const unused = defined.filter((v) => !referenced.includes(v));
      if (referenced.length > 0) {
        info("profile vars", `runbook and posture reference ${referenced.join(", ")}`);
        if (missing.length > 0) info("profile vars", `not set here (sections drop): ${missing.join(", ")}`);
        if (unused.length > 0) info("profile vars", `defined but unreferenced: ${unused.join(", ")}`);
      }
    }
  }
  check("stale state", () => {
    const r = janitor();
    // "0 closed" reads as a clean bill of health, so an unanswered probe must
    // not print it. Doctor is the tool a human runs BECAUSE tmux is
    // misbehaving; saying nothing is the one thing it must not do.
    if (!r.probed) {
      throw new Error("tmux did not answer, so nothing was swept. Re-run when tmux responds.");
    }
    return `${r.closed_agents} dead agents closed, ${r.cancelled_timers} undeliverable wake-ups cancelled`;
  });
  check("sessions", () => {
    try {
      const sessions = execFileSync("tmux", ["ls", "-F", "#{session_name}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split("\n")
        .filter((s) => s.startsWith(SESSION_PREFIX));
      return sessions.length > 0 ? sessions.join(", ") : "none running";
    } catch {
      return "none running";
    }
  });
  info("auto-attach", process.env.HIVE_AUTO_ATTACH === "0" ? "off (HIVE_AUTO_ATTACH=0)" : "on");
  console.log(failures === 0 ? "\nAll good." : `\n${failures} problem(s) found.`);
  process.exit(failures === 0 ? 0 : 1);
}

// One-line store summary for embedding in a shell prompt or Claude Code
// status line. Prints nothing outside a registered project, and never
// registers one; status lines run in every directory a session opens.
function cmdStatusline(): void {
  const project = findProjectForCwd();
  if (!project) return;
  const count = (sql: string) => (db.prepare(sql).get(project.id) as { n: number }).n;
  const agents = count(
    "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'agent'",
  );
  const commands = count(
    "SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'running' AND kind = 'command'",
  );
  const todos = count(
    "SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status IN ('open', 'in_progress')",
  );
  const ready = count(
    `SELECT COUNT(*) AS n FROM todos t
     WHERE t.project_id = ? AND t.status IN ('open', 'in_progress')
       AND NOT EXISTS (${OPEN_BLOCKERS_SQL})`,
  );
  const pads = count("SELECT COUNT(*) AS n FROM scratchpads WHERE project_id = ? AND archived = 0");
  const wakes = count(`SELECT COUNT(*) AS n FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE}`);

  // A project can get registered by a single passing tool call; an all-zero
  // row is noise, so only projects with live state get a status line.
  if (agents + commands + todos + pads + wakes === 0) return;

  const s = (n: number) => (n === 1 ? "" : "s");
  const parts = [
    `${agents} agent${s(agents)}`,
    `${todos} todo${s(todos)}${todos > 0 ? ` (${ready} ready)` : ""}`,
    `${pads} pad${s(pads)}`,
  ];
  if (commands > 0) parts.push(`${commands} cmd${s(commands)}`);
  if (wakes > 0) parts.push(`${wakes} wake${s(wakes)}`);
  console.log(`\x1b[33m⬡\x1b[0m \x1b[2mhive:\x1b[0m ${parts.join(" \x1b[2m·\x1b[0m ")}`);
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
      // wx: atomic fail-if-exists (also refuses a pre-planted symlink);
      // 0600: pad content stays private to the user.
      writeFileSync(file, pad.content, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        console.log(`A file already exists at ${file}; refusing to overwrite it. Save or delete it first.`);
        process.exit(1);
      }
      throw e;
    }
    // "open" launches the system's default app for .md files; HIVE_EDITOR
    // overrides with an explicit command (e.g. HIVE_EDITOR=zed).
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
const COMMANDS = [
  "lead", "init", "attach", "start", "status", "setup", "doctor",
  "pads", "pad", "runbook", "posture", "profile", "kickoff", "statusline",
];
if (!COMMANDS.includes(command)) {
  // `hive <path>` opens that project's session; lead is the default command.
  if (existsSync(command)) {
    rest = [command, ...rest];
    command = "lead";
  } else {
    usage();
  }
}
migrate();
switch (command) {
  case "lead":
    await cmdLead(rest[0]);
    break;
  case "init":
    await cmdInit(rest);
    break;
  case "attach":
    cmdAttach(rest[0]);
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
    cmdDoctor();
    break;
  case "pads":
    cmdPads();
    break;
  case "pad":
    cmdPad(rest);
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
    // The plugin hook runs dist/kickoff.js directly, which never opens the
    // store unless a directory earns it. This path is for humans testing the
    // gates by hand, and pays cli.js's own startup cost.
    await (await import("./kickoff.js")).runKickoff(rest);
    break;
  case "statusline":
    cmdStatusline();
    break;
}
