# Commands

Every `hive` subcommand, in one table. Run `hive --help` for the same list from the shell.

| Command | What it does |
|---|---|
| `hive --version` | Print the version, short sha, and dirty marker this build was stamped with. It reads a cached npm update result when one is fresh. |
| `hive --version --check` | Ask npm for the latest published version, cache the result for 24 hours, and print whether this build is current |
| `hive` / `hive lead [path] [--no-dashboard] [--detach]` | Start, or reattach to, this project's lead session; `--detach` starts or adopts the lead and prints its pane and attach command without attaching |
| `hive queen` | Start, or reattach to, the queen: one lead per data dir that reads every registered project and writes into another one only through its lead (todos, comments, and text or wakes addressed to that lead). The first run creates `<data dir>/queen` with a `hive.yml` selecting the shipped `queen` profile |
| `hive init [path]` | Set up a project: writes `hive.yml`, picks a profile, seeds the board pad, and registers the checkout it is pointed at even under a registered parent |
| `hive attach` | Attach to the project's tmux session without opening a lead |
| `hive start <name>` | Start a `hive.yml` process by hand |
| `hive stop <name>` / `hive stop --all` | Stop one running process, or every one in this project |
| `hive show <name>` | Move a running process's pane beside the lead |
| `hive hide <name>` | Move it back into the project's `processes` window |
| `hive status` | Every project's agents, commands, todos, and wake-ups, in one shot |
| `hive portfolio [--json]` | One row per registered project: lane (waiting on you, stuck, moving, quiet) with its reasons, lead and worker state, todo and wake counts, and the todos tagged `needs-human`. Read-only; `--json` prints the same data as one object |
| `hive next [--print]` | Attach to the lead of the one project that needs you most. Projects waiting on you come first, ranked by needs-human count, then oldest activity, then project id. Stuck projects come next, ranked by in-progress todos that are blocked, overdue wakes, workers needing input, oldest activity, then project id. It skips the project rooted at `<dataDir>/queen`. Every lead state except unknown goes through `hive lead --detach` first, which adopts a live lead and restarts a dead or reissued one. `--print` prints the choice as one JSON line and starts and attaches nothing; with nothing waiting it prints one line saying so and exits 0 |
| `hive upgrade` | Update a global npm install and re-pin; in a checkout, print the recipe only |
| `hive upgrade --check` | Preview the commands without changing your install or update cache |
| `hive upgrade --run` | Run a checkout’s pull/install/build/setup recipe, stopping at the first failure |
| `hive setup` | Pin the `hive` command to the interpreter that built it |
| `hive doctor` | Check the environment and sweep stale state |
| `hive pads` / `hive pad <name>` | List pads, or print (and edit) one from the shell |
| `hive todos` / `hive todo <id>` | List todos, or print one in full |
| `hive backups` / `hive restore <name>` | List store snapshots, or restore one |
| `hive runbook` | Print this project's standing process |
| `hive posture` | Print the posture your lead is running with |
| `hive profile list` | Show the profiles hive can see |
| `hive kickoff --explain` | Check whether a session here gets the session-start injection |
| `hive statusline` | One-line store summary for Claude Code's status line |
