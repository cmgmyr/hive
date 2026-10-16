# Changelog

## 1.11.6 - 2026-10-16

- No behaviour change. Shared agent, wake, pad and todo logic moved out of the MCP tool modules into modules that the CLI and the MCP server both use, which removes every import cycle in `src/`. Tool names, schemas, descriptions and outputs are unchanged, and so is every CLI command's output and exit code.
- For contributors: a new test fails the suite on any import cycle under `src/`, or on any module other than the MCP entry that imports a tool module. `docs/architecture.md` section 2 describes the new layering.
- After upgrading, restart every hive session.

## 1.11.5 - 2026-10-15

- A lead handoff's grace period now holds the lead's wakes for at most 15 minutes from when grace began, like the other handoff holds. Before, a grace hold whose driver had died could hold wakes indefinitely. The store migrates to schema 45 on first open to apply the same limit to wake claims; hive takes a backup before the migration runs.
- Backlog todos no longer count as open or as waiting on you. `hive status`, the statusline, the project dashboard, the crew sidebar, `hive portfolio`, the queen dashboard and `hive next` now agree: only an unarchived todo that is `open` or `in_progress` counts, and only such a todo tagged `needs-human` puts a project in the waiting-on-you lane. The dashboard says so when a project has only backlog todos.
- `hive start <name>` now exits 1 when the process failed to launch, when hive refused to start it (a reserved name, an unapproved command, a directory outside the project, or a tmux server it could not probe), and exits 0 only when the process started or was already running. `hive lead`'s automatic starts are unchanged.
- Every git read hive makes ignores `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` from the environment and gives up after 2 seconds, so a hook that sets them can no longer make hive read another repository's branch, and a stuck git call can no longer hang a command.
- Updated dependencies: `@modelcontextprotocol/sdk`, `smol-toml`, `zod` and `@types/node`.
- After upgrading, restart every hive session.

## 1.11.4 - 2026-10-14

- `kv_get` and `kv_list` no longer fail on a stored value that is not valid JSON. They return it as a raw string. `kv_list`'s `prefix` now matches literally, so `_`, `%` and `\` in a prefix are plain characters and matching is case-sensitive.
- `help()` no longer says a session falls back to the only registered project. Its tool descriptions now match the tools for lead wake cancellation, answer wake rerouting, worker options, list limits and `queen_audit_list`.
- `agent_rename` no longer retitles a pane that is in tmux copy mode. The row is still renamed. `agent_send` checks again that it owns the pane before it captures the `wait_ms` tail.
- Advice to re-pin or rebuild hive is now a command you can run as printed. Native-addon errors, the dispatcher warning, the generated shim and `hive doctor` name the Node interpreter and CLI path directly, instead of telling you to run `hive setup` through a `hive` command that may be stale. `hive doctor` mentions `scripts/sweep-scratch.mjs` only in a checkout that has it.
- The scheduler runs each maintenance step and each due wake on its own, so one failure no longer stops the rest of that tick. A wake that fails after its text was pasted now leaves a record.
- A stall notice about a waiting worker is filed again if the earlier one was never typed. A dead-process notice is sent only when hive can read the lead's screen.
- After upgrading, restart every hive session.

## 1.11.3 - 2026-10-13

- A recipient given as a string agent id (`"41"`) or as an actor id (`"lead:41"`) now reaches that agent in `wake_set`, `wake_when_idle`, `agent_send` and the other agent tools when no running agent's name matches it. Names still come first, exactly as before: an exact name, then a unique partial name, so a ticket number still finds its worker. A number always resolves by id. The queen's wakes and messages to another project's lead use the same lookup, so a lead addressed by a string id is no longer refused.
- The crew sidebar recovers when the directory it runs `hive crew` from is deleted. Each refresh checks that directory and falls back to the session's current directory, then the one it started in. A failed read now names the command and the directory instead of reporting only `ENOENT` on `hive`.
- After upgrading, restart every hive session.

## 1.11.2 - 2026-10-13

- A wake that comes due while a freshly started Claude Code lead is still booting is no longer lost. hive holds it until the lead's input box appears, for up to 60 seconds after `hive lead` creates the pane, then delivers it. Past that window, delivery works as before. Codex leads and workers are unchanged.
- The store migrates to schema 44 on first open. hive takes a backup before the migration runs.
- After upgrading, restart every hive session.

## 1.11.1 - 2026-10-12

- Pending questions now count as waiting on you. In `hive portfolio` and on the queen dashboard, a project with a pending question moves to the waiting-on-you lane when nothing more urgent applies, and `hive next` ranks pending questions alongside todos that need you.
- The queen dashboard shows each project's pending-question count in its card and in a new Questions column. The project dashboard lists its pending questions and the ones the lead acted on by default. Neither shows answers.
- When the session that asked a question has closed, `question_answer` and `hive answer` send the answer to the project's running lead instead, and say so. With no running lead, the answer is kept and no wake is queued.
- The queen's wakes and messages to another project's lead now go to the same lead delivery would reach, so a stale lead row no longer causes a refusal. Every refusal is recorded with its reason, readable with `queen_audit_list` and `hive queen-audit`.
- `hive doctor` no longer stops checking for old hive servers when one of them exits while it looks.
- The store migrates to schema 43 on first open. hive takes a backup before the migration runs.
- After upgrading, restart every hive session.

## 1.11.0 - 2026-10-11

- New question record. A lead records a decision only you can make with `question_ask`, as a choice of two to four options with one recommended, or as free text. Every question carries the default the lead acts on if you never answer. `question_list`, `question_get`, `question_update` and `question_answer` read, edit, close and answer them. Asking again with the same todo or PR `ref` updates the pending question instead of adding one, and the receipt lists similar pending questions. See [Tools](docs/tools.md).
- New `hive questions` lists a project's pending questions, then the ones the lead already acted on by default, with their options. New `hive answer <id> <answer> [--notes <text>]` answers one from any terminal. The asking session receives your answer as a wake. If the asker is not running, the answer is kept and the command says no wake was queued.
- The crew sidebar footer shows `questions pending: N` while any are pending, and `hive crew --json` and `hive portfolio` report the count. Neither shows the question text, options or answers.
- New opt-in setting `lead_turn_budget.auto_handoff`. With `auto_handoff: true`, hive replaces a Claude Code lead that has passed its `warn` turn count with a fresh session in the same pane, on the same lead row, so its wakes, workers and standing watches carry over. At a quiet moment hive asks the lead to write a handoff pad and run the new `hive lead-handoff` command; after a short grace period with no input from you, the pane restarts and the new session receives the pad. Typing in the lead pane postpones it, and background work in the session prevents it. It is off unless you set it. See [Configuration](docs/configuration.md).
- While a handoff is in progress, the store holds wakes to that lead for every hive build, including servers started from an older version, until the new session finishes its first turn. Restart every hive session before turning `auto_handoff` on, so messages to the lead are held too.
- hive's own first message to a new lead session no longer counts as you talking to it, so it no longer holds that lead's wakes for 5 minutes.
- `hive doctor` names hive MCP servers using the same store that started before its latest migration, so you know which sessions still run old code and need a restart. It reports them and stops nothing.
- The crew sidebar labels a worker's command by the command itself when the shell line starts with a control keyword such as `if`, `for` or `while`.
- The store migrates to schema 42 on first open. hive takes a backup before the migration runs.
- After upgrading, restart every hive session.

## 1.10.1 - 2026-10-09

- hive works correctly with tmux 3.8. tmux 3.8 stopped reporting a pane's process id once the process exits, so a worker whose command failed at startup produced a "did not report a process id" error and lost its crash output. hive now reads the process id when it creates the pane, and works the same on tmux 3.7c and 3.8. A Claude Code or Codex worker that exits during startup is reported as exited, with its last output.
- A spawn that fails after hive set the window to keep exited panes now always clears that setting. Before, later exits in the lead's window could stay on screen as dead panes.
- A worker spawned with a plain command that exits immediately is now refused with "the command exited immediately". It is no longer recorded as running.
- In the crew sidebar, an idle or waiting worker's row now shows its last activity, for example `your turn 12s · editing`.
- After upgrading, restart every hive session.

## 1.10.0 - 2026-10-09

- New opt-in setting `lead_sidebar`. With `lead_sidebar: true` in `~/.hive/hive.yml` or a project's `hive.yml`, `hive lead` adds a crew pane to a Claude Code lead. The pane lists each running worker with its todo, state, current activity, run time and context use. It also lists todos tagged `needs-human` under "todos waiting on you", shows the next wake once in its footer, and warns in amber when workers are running with no standing watch. It is off unless you set it. Restart the lead after changing it. See [Crew sidebar](docs/crew.md).
- New `hive crew --json` prints the same crew snapshot as read-only JSON. It writes nothing to the store.
- `agent_spawn` records the worker's todo when you pass `todo_id`. If you omit it while a todo is in progress, the receipt says so, and the crew view links the worker to the todo it comments on. A worker that only writes a pad shows that pad instead.
- The crew view labels what a worker is doing: testing, editing, reading, building, committing, reviewing or `running <command>`. For Codex workers it reads the tool calls inside `codex exec`, and a command that starts with `printf` or `echo` is labelled by the real command after it.
- A lead that ended its session cleanly now shows as dormant, not dead, in `hive status`, `hive portfolio` and the queen dashboard. This also covers a lead that never received a typed prompt.
- The queen dashboard shows the queen's own board, todos and pads below the portfolio. "Every project" and "Recent queen actions" now collapse, and the page remembers the choice across reloads. "Recent queen actions" moves to the end of the page.
- The store migrates to schema 37 on first open. hive takes a backup before the migration runs.
- After upgrading, restart every hive session.

## 1.9.1 - 2026-10-08

- With `quiet_messaging` on, a worker's `agent_send` to a running Claude Code lead now arrives as one dim `Message from @hive` row instead of typed text, the same way one-shot wakes do since 1.9.0. A message over 300 characters still arrives as a one-line pointer you read with `agent_message_get`. The send receipt says `pending` until the lead confirms it, and `agent_message_get` reports the delivery state. A message the lead does not confirm in time is typed into the pane once. With the setting off, nothing changes. See [Quiet messaging](docs/projects.md#quiet-messaging).
- With `quiet_messaging` on, repeating wakes to a Claude Code lead also arrive as a `Message from @hive` row, on every firing, marked `[hive wake #N firing #F]`. `delivery_method` reads `socket-repeating`.
- `wake_get` and `wake_list` report `delivered_by`: the process id, version and build of the hive server that delivered each wake. An older hive server that delivered a wake leaves it empty.
- A submitting `agent_send` with `wait_ms` returns `input_box_before`, the target's input box as hive read it just before the paste, next to the existing `input_box` read after it.
- A prompt row drawn in a 256-color or truecolor style is now read as typed text, not as Claude's dim suggestion. Before, text in such a row did not hold a wake and did not stop `agent_send`.
- When hive cannot connect to the tmux socket at all (for example, permission denied from a sandboxed shell), it now treats the state as unknown instead of as an empty server. `hive portfolio` no longer reports every lead as a dead pane from such a shell.
- A Claude Code task notification no longer counts as you talking to the lead, so it no longer holds the lead's wakes.
- The CLI exits quietly when the reader of its output closes the connection with `ENOTCONN`, as it already did for `EPIPE`.
- The store migrates to schema 36 on first open. hive takes a backup before the migration runs.
- After upgrading, restart every hive session.

## 1.9.0 - 2026-10-07

- New opt-in setting `quiet_messaging`. With `quiet_messaging: true` in your global `~/.hive/hive.yml` or a project's `hive.yml`, a one-shot wake to a running Claude Code lead arrives as one dim `Message from @hive` row instead of a block of pasted text. Press ctrl+o to expand it. It is off unless you set it, and a project's `false` overrides a global `true`. Restart the lead with `/exit` and `hive lead` after changing it. See [Quiet messaging](docs/projects.md#quiet-messaging).
  - `wake_get` and `wake_list` report how each wake was delivered in `delivery_method`: `socket`, `pty`, or `pty-after-socket-timeout`. A socket message the lead does not confirm within 60 seconds is typed into the pane once, marked `re-delivered`.
  - Repeating wakes, wakes to workers and wakes to a Codex lead are still typed into the pane.
  - Turning it on lets any local session send messages to that lead, not only hive. Workers still refuse inbound messages.
- A lead started while a worker is still running in the project window now becomes the window's first pane, and the window re-applies your `layout`. Before, a `main-vertical` window came back with the worker on top and the lead underneath.
- The dashboard wraps long lines in pads instead of scrolling the page sideways. With Live on, it no longer reloads while you have a pad or todo open, and a reload keeps your place on the page and inside each open pad. Scrolling restarts the reload timer the way typing does.
- The dashboard's Live checkbox now stops the reload when you switch it off. Before, typing in the filter still re-armed it.
- The store migrates to schema 34 on first open. hive takes a backup before the migration runs.
- After upgrading, restart every hive session.

## 1.8.0 - 2026-10-06

- The shipped `orchestration` profile has been rewritten. The old one was a skeleton; this one is a full starting point. The lead assigns todo ids, supervises the work, and accepts or rejects what comes back. Workers no longer take work off the shared queue or complete their own todos. The runbook spells out lanes, briefs, scope, worktrees, shared resources, checks, review, permissions, waiting, the context checkpoint, handback and closing a lane. The posture tells the lead to run on your strongest model tier and to spawn workers on a cheaper one with `agent_spawn`'s `model` argument.
- The shipped orchestration profile renders new optional `hive.yml` vars: `test_command`, `suite_command`, `verify_command`, `review_command` and `worker_model`. Each var adds its section only when it is set. The `hive.yml` template that `hive init` writes lists them.
- In a worker's done list, the gate step from your `check` var is now a line under the scoped-checks step. The numbering no longer skips a step when `check` is unset.
- The `/hive:profile` skill matches the new profile. It starts an orchestration profile from the shipped files and offers each optional var only when your answers call for it. It reads worker text with `hive profile read worker.md`. A new section explains how to use the skill without the Claude plugin, for example from Codex.
- The `/hive:profile` skill includes worked examples in `references/examples/`. One shipped profile renders differently for a personal repo and a work repo through `hive.yml` `vars`. There is also an annotated skeleton of the three profile files, and a prompt you can paste to your own agent to adapt the example.
- If you forked the orchestration profile, your copy is unchanged. `hive profile list` and `hive doctor` report how far it has drifted from the new shipped files.
- After upgrading, restart every hive session.

## 1.7.0 - 2026-10-04

- hive now kills, types into, or reads the screen of a pane only when the row owns it. 1.6.0 changed what hive reports about a row's pane; this release changes what it does. Closing, parking, sending, renaming, `hive stop`, wake delivery, `hive lead`'s adopt and `scripts/restart-lead.sh` act only on a pane whose process matches the one hive recorded. After a tmux restart a pane id can name another process, and hive no longer touches it. When ownership cannot be checked, hive refuses or holds and says why.
- `pad_read` takes optional `offset` and `limit` arguments, so you can read a large pad in chunks. A ranged read returns `total_length`, the effective `offset` and `next_offset`. A read without them returns the whole pad as before.
- A held idle wake (`wake_when_idle` with `agents`) now follows the same 15 minute ceiling as other wakes. Before, it waited as long as you kept typing in the target pane.
- Arming a one-shot idle wake for the same watched workers, mode and target cancels your older pending one, so only one delivers. The receipt lists the cancelled ids in `superseded`.
- A rebuild that produces identical output no longer sends every session a "the build on disk changed" restart notice. `build_id` is now a hash of the version and the built files.
- `hive lead`'s cleanup of commands left running by a previous lead no longer stops a `hive start` you run while the lead is starting.
- Opening the dashboard waits up to 10 seconds for `open`, up from 5, so a slow machine no longer reports a failed open.
- The `hive:cleanup` skill reports drift in your active profile when you wrap up, without changing anything. The `/hive:profile` skill asks once, after a profile edit, before telling running leads about it.
- New page: [What hive can do on your machine](docs/security.md), a code-cited list of what hive sends over the network, runs and writes, for security reviewers. SECURITY.md now also says that `hive upgrade` downloads and installs the new version, and that `HIVE_NO_UPDATE_CHECK=1` stops only the version query.
- After upgrading, restart every hive session. A session on an older build keeps the old behaviour, and any running hive server can deliver any project's wakes.

## 1.6.0 - 2026-10-01

- hive now tells a row that owns a live tmux pane apart from a pane id that merely exists. After a tmux restart a pane id can come back attached to a different process. A row counts as live only when the pane's process matches the one hive recorded for it.
  - `hive status` prints `running` for a lead only when its pane is live. It prints `no live pane` when the pane is gone or its id now belongs to another process. It prints `pane identity unknown` when hive cannot check, for example a row with no recorded pane pid. Before this release `hive status` printed `running` for every lead row.
  - `hive portfolio`, `hive doctor`, `agent_list`, `agent_status` and `agent_output` report the same way. `alive` is `null` when ownership cannot be verified, and none of them reads the screen of a pane the row does not own. Doctor's warnings name a remedy that works for each case.
- `agent_close` takes `row_only: true`. It marks a row closed whose pane is gone, reused or unverifiable, with no kill, stop or typing. Only a human or a peer lead can pass it. It refuses a row that owns a live pane, and it refuses with a retry message when tmux does not answer.
- `hive project rm` and `project_prune` no longer refuse because of a running row whose pane is provably gone or reused. A row whose ownership is unknown still blocks removal, and the message names `agent_close` with `row_only: true` for it.
- A Codex worker's hook events are accepted only from the worker's own generated Codex home. A Codex run that a worker starts inside its session no longer writes its state or session id into the worker's row, so it can no longer make a busy worker look idle. A closed Codex worker's row ignores hook events.
- `hive profile list` and `hive doctor` show each profile file's rendered size, the bytes `hive profile read` prints for the project. Above 25600 bytes they add an advisory: a harness may save long tool output to a file and show only a short preview, so split the file or read it in sections. The advisory never changes doctor's exit status, including under `--strict`.
- The `/hive:profile` skill reads a large profile file in sections from a saved copy, so it never edits text it has only seen a preview of.
- The custom status line example in the install guide now pipes Claude Code's statusline JSON into `hive statusline`, so a lead's status line shows `turns N`. It reads stdin only when your script has not already.
- After upgrading, a lead row created before hive recorded pane pids, and never restarted since, shows `pane identity unknown` instead of `running`, even while that lead is live. Restart it with `hive lead` and hive records its pid. Until then the queen may not count it as a running lead.
- Closing, typing into and delivering wakes to a row still use the earlier liveness check. A later release moves them to the new one.
- After upgrading, restart every hive session. A session still on an older build keeps the old behaviour, and any running hive server can deliver any project's wakes.

## 1.5.0 - 2026-10-01

- `hive project rm <id|path> [--yes]` removes a project and everything it owns: its agents, todos, pads, wakes and the rest. It prints what it will remove, asks `[y/N]` unless you pass `--yes`, and takes a snapshot of the store first. It refuses your own project, a project with a running agent, and any run under `HIVE_PROJECT_LOCK=1`. A path must match a registered project's path exactly.
- `project_prune` takes `confirm_name`. With `project_id` and that project's exact name, it removes a project that still owns rows, under the same guards, and reports per-table counts and the snapshot path. Without it, `project_prune` behaves as before.
- The queen can run `project_prune` and `hive project rm`, so it can clean up stray projects across your machine. Each project it removes is recorded in `hive queen-audit`.
- The idle-wake trailer and the unsubmitted-text hold now work for Codex workers. Codex 0.159 draws a two-row footer, and hive could not find the input box above it, so a wake could be typed over a Codex worker's half-written prompt. That includes the footer Codex shows while you type, which drops its shortcuts row.
- After upgrading, restart every hive session. Any running hive server can deliver any project's wakes, so a session still on an older build can still type a wake over a Codex draft.

## 1.4.0 - 2026-09-30

- `hive queen` starts the queen: one lead per data dir that reads every registered project and tells you which one needs you. It writes into another project only by handing things to that project's lead: todos, comments, and text or wakes addressed to the running lead. Anything else there is refused with `QUEEN_CROSS_PROJECT_WRITE_REFUSED`. The first run creates `<data dir>/queen` with a `hive.yml` that selects a new shipped `queen` profile, a skeleton you fork and fill in. The new queen guide, `docs/queen.md`, covers all of it.
- `hive portfolio [--json]` prints one block per registered project, sorted into four lanes: waiting on you, stuck, moving and quiet. Tag a todo `needs-human` to put its project in front of you. A project with live work stays moving, and a held wake is never overdue.
- `hive next` attaches you to the lead of the project that needs you most, starting or adopting that lead first. `hive next --print` names the choice and starts nothing.
- `hive lead <path> --detach` starts or adopts a project's lead without attaching your terminal, and prints its pane and an attach command. From a script it stops at a `hive.yml` command you have not approved yet.
- The queen has its own dashboard at `<data dir>/queen/dashboard.html`: the queen's picks, one section per lane, a grid of every project, each lead's turn state, and the queen's recent actions.
- `wake_when_idle` takes `lead_project_id`, for the queen only, and wakes it when another project's lead ends a turn. The watch ends with a named reason if that lead goes away, restarts, or its pane is reissued.
- Every queen write into another project is recorded. `hive queen-audit` and the `queen_audit_list` tool list them, newest first, for 30 days.
- A lead's first message is now set with `first_message` in the global or a project `hive.yml`, and hive ships no default text. Before this release a lead opened with a built-in morning-triage message. After upgrading it waits for you until you set `first_message`. `hive lead` passes the message on the command line, because Claude Code 2.1.285 drops the message the session-start hook used to send.
- The trailer under an idle wake now shows the worker's last output rows and one line about its input box (empty, a model suggestion, or unsubmitted text), in place of box borders, the status line and the mode line. A screen hive cannot classify, such as a dialog, still arrives as the raw tail.
- Two wakes delivered to the same pane by two hive servers at the same moment no longer arrive as one merged message.
- The read-only CLI commands (`hive pads`, `hive pad`, `hive todos`, `hive todo`, `hive runbook`, `hive posture`, `hive profile read`) no longer register the current directory as a project. Outside a registered project they exit 1 and name `hive init`. `project_prune` takes a `project_id` to remove one empty project.
- hive's read commands no longer fail at startup when the process cannot write to the store, which is the case for a `read_only` worker. One case remains: when no other hive process has the store open, the read still fails.
- Piping a hive command into `head` no longer prints an EPIPE stack trace.
- Help and tool text now say a lease guards shared state, not any file edit.
- Dependencies: MCP SDK 1.30.1 and smol-toml 1.9.0, with patched `ip-address` and `fast-uri`.
- After upgrading, restart every hive session. A session still running the old build keeps rewriting the dashboards with its old text.

## 1.3.0 - 2026-09-27

- Set hive defaults once in `~/.hive/hive.yml`. Any key you put there applies to every project, and a project's own `hive.yml` overrides it key by key. `hive doctor` shows where each setting came from (global or project). `hive lead`, `hive setup` and `hive doctor` fold an existing `~/.hive/config.json` into the new file and keep a copy of the original.
- A new `/hive:profile` skill in the Claude Code plugin interviews you about how you work with agents, then creates a hive profile or edits one you already have. It recommends the simple or orchestration profile from your answers, can draw your flows as a Mermaid diagram, and offers recipes for common problems such as two test runs sharing one database.
- `agent_spawn` takes `read_only: true`. The worker cannot write files or run mutating shell commands, but it can still use hive's tools, so it can write a plan to a pad. It suits planning or review workers. Only an effort flag may be passed alongside it, and `agent_resume` keeps the mode.
- `agent_resume` restores the model and extra arguments a worker was spawned with, instead of starting it on the defaults.
- A codex worker's hive MCP server now receives the worker's hive identity and data directory. Before this, a codex worker in a directory outside its project could register a new project, or write to the default store when you ran hive with a different one.
- Nested codex runs inside a hive codex worker, such as `codex exec`, can call hive's tools. Every codex home hive generates now pre-approves hive's own MCP tools, so the call no longer fails with "approval policy is never".
- Every hive tool declares MCP tool annotations (read-only, destructive, idempotent, open-world), so clients can see what a tool does before calling it.
- A migration that fails for a reason other than a busy store now names the failing migration and the SQL error. It no longer tells you to look for a stuck hive process.
- An idle wake that was ready when its worker went idle, but was held past its max wait (for example while your pane showed a dialog), is no longer labelled "max wait reached".
- `review_tags` is retired. A `hive.yml` that still sets it gets a warning asking you to remove it, and nothing else changes.

## 1.2.2 - 2026-09-24

- The build-changed notice now reaches Claude Code. Claude Code shows the model only the structured part of a tool result for tools that declare an output schema, so the notice that 1.2.0 added as extra text was hidden, and the lead wake was the only place it appeared. The notice now also rides in the result as an optional `hive_notice` string. The same fix applies to the notice hive gives when it registers a new project for your working directory.
- hive describes itself the same way everywhere: the README, the npm package, `hive --help` and the MCP help now say "Run a crew of Claude Code and Codex workers from one lead session". CONTRIBUTING.md now says which harnesses hive supports and why.

## 1.2.1 - 2026-09-24

- A running hive session now picks up a repaired build stamp. If the stamp file on disk was unreadable and you fixed its permissions, the build-changed notice used to keep reporting it as unreadable until you restarted the session. It now reads the stamp again.

## 1.2.0 - 2026-09-23

- `hive upgrade` updates hive in one command. On a global npm install it installs the latest `@cmgmyr/hive`, re-pins the `hive` command using the new install's own setup, and prints the exact fix for any Claude Code or Codex MCP registration that still points at the old install. It never edits those tools' config files. In a git checkout it prints the pull, install, build and setup steps, and runs them only with `hive upgrade --run`. `hive upgrade --check` previews without changing your install.
- `hive --version --check` asks npm for the latest published version and tells you whether you are current. `hive --version` and `hive doctor` then show an update line when a newer version exists. `hive doctor` refreshes that answer itself at most once a day, and only in an interactive terminal. This is the one network request hive makes, always through your own `npm`, never from the MCP server, hooks or scheduler. Set `HIVE_NO_UPDATE_CHECK=1` to turn it off.
- A running hive session now notices when the hive build on disk has changed since it started, after a rebuild or an upgrade. The next hive tool result says which build it loaded and which is on disk, and a lead also gets one wake with the same sentence. Restart that session, or reconnect hive in `/mcp`, to pick up the new build. Sessions started before 1.2.0 cannot notice anything, so restart every hive session once after upgrading to 1.2.0.
- `hive init` writes commented `agents:` and `dashboard:` examples, and `hive.example.yml` and the docs now list every top-level `hive.yml` key.

## 1.1.0 - 2026-09-23

- `hive doctor` warns when your shared store's schema is ahead of this build, which means a newer hive has already migrated it. `hive statusline` shows `store ahead (update hive)` in the same case. Upgrade that install before you rely on it. The warning does not change `hive doctor --strict`'s exit code.
- `hive statusline` can show a lead how many turns its session has taken. Pipe Claude Code's statusline JSON to it, for example `printf '%s' "$input" | hive statusline`, and a lead's line gains `turns N`. Set `lead_turn_budget: {warn: 300, stop: 600}` in `hive.yml` to colour it amber and red at your own thresholds. Workers never show it.
- `agent_list` pages its closed-agent listing: newest first, 20 by default and at most 100, with a `before_id` cursor for the next page. A long-lived project no longer returns hundreds of closed workers in one call.
- The README demo shows the whole loop: finished workers stay on screen as idle, and the lead asks what to work on next.
- Every Mermaid diagram in the docs renders, and CI now checks that they do.

## 1.0.0 - 2026-09-22

The first public release of hive, a local MCP server and CLI for shared memory and visible worker sessions.

- Run Claude Code and Codex workers together on one project.
- Nothing leaves your machine: no daemon, no network, one SQLite file.

Install it globally with `npm install -g @cmgmyr/hive`.
