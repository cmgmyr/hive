# Configuration

Environment variables, mostly for advanced or automated setups. Everyday use needs none of these.

## Everyday

| Variable | Purpose |
|---|---|
| `HIVE_DATA_DIR` | Where the database lives. Default `~/.hive` |
| `HIVE_PROJECT_LOCK` | Set to `1` to reject all cross-project access in this session (set automatically for workers) |
| `HIVE_BIN_DIR` | Where `hive setup` writes and checks the dispatcher shim. Default `~/.local/bin` |
| `HIVE_SPAWN_PLACEMENT` | `split` (panes) or `window` (tabs) for new workers. Default `split` |
| `HIVE_SPAWN_READY_MS` | How long `agent_spawn` waits for a worker's prompt box. Default `45000` |
| `HIVE_EDITOR` | External editor for `hive pad <name> --edit` |
| `HIVE_NO_UPDATE_CHECK` | Set to `1` to disable npm update checks from `hive --version --check`, `hive doctor`, and `hive upgrade` (upgrade then refuses to install) |
| `HIVE_BACKUP_KEEP_LAST`, `HIVE_BACKUP_KEEP_DAILY_DAYS`, `HIVE_BACKUP_STALE_DAYS` | Snapshot retention and staleness tuning |

## Set by hive or for tests

| Variable | Purpose |
|---|---|
| `HIVE_PROJECT_PATH` | Set automatically by `agent_spawn`; guards a worker's project pin |
| `HIVE_CONTEXT_CHECKPOINT_PERCENT` | Hive sets this on worker processes from `hive.yml`'s `context_checkpoint_percent`. You do not set it by hand. |
| `HIVE_LEAD` | Set automatically by `hive lead`, so its session-start hook still fires |
| `HIVE_ALLOW_DEFAULT_STORE` | Set to `1` to let a non-hive process open the real store |
| `HIVE_AUTO_ATTACH`, `HIVE_ATTACH_MODE` | Testing overrides; use `hive setup --auto-attach` / `--attach` instead |
| `HIVE_TMUX_TIMEOUT_MS` | Raise (never lower) the bound on a tmux call before hive treats it as unknown. `hive doctor` reports it when set, since a knob that shortens a safety bound must not sit in an environment silently |
| `HIVE_SCHEDULER_INTERVAL_MS` | Testing override for how often the MCP server's scheduler ticks. Default `3000`. A value that is not a whole number from `100` to `2147483647` is ignored and the default is used |
| `HIVE_TEARDOWN_SIGHTING_MAX_AGE_MS` | Testing override for how recent a tmux sighting must be before a crew-teardown record may call its window `observed`. A 15-second bound cannot expire inside a test. CLAMPED to the default, so it can only ever shorten the bound: unlike `HIVE_TMUX_TIMEOUT_MS` no value of it can weaken a claim, because lengthening it would buy an `observed` the process did not earn |
| `HIVE_PTY_HEADROOM_JSON`, `HIVE_PTY_PS_ROWS_JSON`, `HIVE_ORPHAN_SCRATCH_JSON` | Testing overrides for `hive doctor`'s pty escalation: inject a full headroom reading, `ps` rows, or an orphaned-scratch-server struct instead of shelling out, to test the safety-margin crossing deterministically |
