# Commands

Every `hive` subcommand, in one table. Run `hive --help` for the same list from the shell.

| Command | What it does |
|---|---|
| `hive --version` | Print the version, short sha, and dirty marker this build was stamped with |
| `hive` / `hive lead` | Start, or reattach to, this project's lead session |
| `hive init` | Set up a project: writes `hive.yml`, picks a profile, seeds the board pad |
| `hive attach` | Attach to the project's tmux session without opening a lead |
| `hive start <name>` | Start a `hive.yml` process by hand |
| `hive stop <name>` / `hive stop --all` | Stop one running process, or every one in this project |
| `hive show <name>` | Move a running process's pane beside the lead |
| `hive hide <name>` | Move it back into the project's `processes` window |
| `hive status` | Every project's agents, commands, todos, and wake-ups, in one shot |
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
