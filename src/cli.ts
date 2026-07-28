#!/usr/bin/env node
// hive CLI: open a project's orchestration session and manage its commands.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
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
import { errorMessage } from "./result.js";
import { ACTIVE_TIMER_WHERE, janitor } from "./scheduler.js";
import { closeAgentRow, launchAgent } from "./spawn.js";
import {
  claimInitialWindow,
  ensureSession,
  SESSION_PREFIX,
  sessionName,
  tmux,
  windowAlive,
  windowTitle,
} from "./tmux.js";
import { configHash, loadProjectYml, resolveCommandDir, type YmlProcess } from "./projectYml.js";
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
  hive init [path]           create a starter hive.yml and runbook pad
  hive attach [path]         attach without adding windows
  hive start <process> [path] start one hive.yml process by name
  hive status                overview of agents, todos, and wake-ups everywhere
  hive doctor                check the environment and clean up stale state
  hive pads                  list the current project's pads
  hive pad <name>            print a pad's content
  hive pad <name> --edit     export to a temp file and open your markdown editor
  hive pad <name> --save     write the edited export back (revision-guarded)
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
    if (windowAlive(existing.tmux_target)) return "already running";
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

function cmdInit(path?: string): void {
  const project = resolveProject(path);
  console.log(`Project: ${project.name} (${project.path})`);

  const ymlPath = join(project.path, "hive.yml");
  if (existsSync(ymlPath)) {
    console.log("- hive.yml: already exists, left untouched");
  } else {
    writeFileSync(ymlPath, HIVE_YML_TEMPLATE);
    console.log("- hive.yml: created (placement plus commented examples)");
  }

  const padId = createPad(project.id, "runbook", RUNBOOK_TEMPLATE, []);
  if (padId == null) {
    console.log("- runbook pad: already exists, left untouched");
  } else {
    console.log(`- runbook pad: seeded starter template (pad ${padId})`);
  }

  const boardId = createPad(project.id, "board", BOARD_TEMPLATE, []);
  if (boardId == null) {
    console.log("- board pad: already exists, left untouched");
  } else {
    console.log(`- board pad: seeded starter template (pad ${boardId})`);
  }

  console.log(`\nNext: run \`hive\` here and tell the lead "good morning, let's triage".
The runbook's first-run section has the lead interview you and tailor
itself to this project before any real work runs.`);
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
  check("node", () => process.versions.node);
  check("tmux", () => execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim());
  check("claude", () => execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  check("database", () => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n;
    return `${dataDir} (schema v${n})`;
  });
  check("hooks file", () => ensureHooksFile());
  check("stale state", () => {
    const r = janitor();
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
  console.log(
    `  info  auto-attach: ${process.env.HIVE_AUTO_ATTACH === "0" ? "off (HIVE_AUTO_ATTACH=0)" : "on"}`,
  );
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
       AND NOT EXISTS (
         SELECT 1 FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
         WHERE b.todo_id = t.id AND bt.status != 'completed'
       )`,
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

  process.stdout.write(pad.content.endsWith("\n") || pad.content === "" ? pad.content : `${pad.content}\n`);
}

const args = process.argv.slice(2);
let command = args[0] ?? "lead";
let rest = args.slice(1);
if (command === "--help" || command === "-h" || command === "help") usage();
if (!["lead", "init", "attach", "start", "status", "doctor", "pads", "pad", "statusline"].includes(command)) {
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
    cmdInit(rest[0]);
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
  case "doctor":
    cmdDoctor();
    break;
  case "pads":
    cmdPads();
    break;
  case "pad":
    cmdPad(rest);
    break;
  case "statusline":
    cmdStatusline();
    break;
}
