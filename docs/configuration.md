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

## Global defaults

`<HIVE_DATA_DIR>/hive.yml` holds machine-wide defaults for project configuration. `HIVE_DATA_DIR` defaults to `~/.hive`, and hive resolves this path when it reads or writes the configuration. A project `hive.yml` still belongs at the checkout root. Effective values come from built-in defaults, then the global file, then the project file.

```yaml
# ~/.hive/hive.yml, or $HIVE_DATA_DIR/hive.yml
lead: claude --model sonnet
dashboard: true
agents: [claude, codex]
vars:
  repo: acme/service
  check: npm run lint && npm run build
```

```yaml
# project hive.yml
lead: claude --model opus
dashboard: false
agents: [claude]
vars:
  repo: acme/checkout
  ticket: OPS
```

The project lead, dashboard setting, and agents list replace their global values. The `vars` map merges by key, so the project replaces `repo`, keeps the global `check`, and adds `ticket`. `hive doctor` shows each effective value and its source, for example `config lead: "claude --model opus" (source: project)`, `config dashboard: false (source: project)`, and `config vars.check: "npm run lint && npm run build" (source: global)`. It lists each `vars.<key>` separately; a removed inherited var appears as `null` with the source that removed it.

For scalar and list keys, an absent project key inherits the global value and an explicit project value replaces it. An explicit `null` clears nullable values such as `lead`, `placement`, `layout`, `profile`, `context_checkpoint_percent`, and `lead_branches` back to their built-in behavior. `hive doctor` prints the null sentinel and its source; it does not print the consumer's fallback value:

| Key | Doctor prints | Runtime meaning |
|---|---|---|
| `lead` | `null` | Run the default `claude` command. |
| `placement` | `null` | Use `window` when `HIVE_SPAWN_PLACEMENT=window`; otherwise use `split`. A project or global `placement` value takes precedence over this environment variable. |
| `layout` | `null` | Use `tiled`. |
| `profile` | `null` | No profile is active. |
| `context_checkpoint_percent` | `null` | Context checkpoint notices are disabled. |
| `lead_turn_budget` | `null` | No lead turn budget thresholds are active. |
| `agents` | `null` | Allow Claude only. An empty list has the same effect. |
| `lead_branches` | `null` | Use `main` and `master`. An empty list disables kickoff. |
| `dashboard` | `false` | Dashboard generation is disabled; a YAML `null` also resets it to `false`. |

In `vars`, a null leaf removes only that inherited key; `vars: null` resets the map to empty, while `vars: {}` adds nothing and keeps inherited values. A project `lead_turn_budget` pair replaces the whole global pair, and `null` clears both thresholds. The pair must use positive integer `warn` and `stop` values, with `stop` greater than `warn`.

The keys shared between the two YAML files are `lead`, `placement`, `layout`, `profile`, `agents`, `lead_branches`, `context_checkpoint_percent`, `lead_turn_budget`, `dashboard`, and `vars`. `processes` is project-only because each command needs the project's trust approval. If the global file contains `processes`, including `processes: null`, doctor warns with the global file path and ignores it. `attach` and `autoAttach` are global-only; project occurrences warn and are ignored. Set them with `hive setup --attach <mode>` and `hive setup --auto-attach <mode>`, which preserve YAML comments and ordering. Doctor shows their source too. `HIVE_ATTACH_MODE` overrides global `attach`, and `HIVE_AUTO_ATTACH` overrides global `autoAttach`; `HIVE_SPAWN_PLACEMENT` remains below project and global `placement` values.

When a key is absent from global `hive.yml`, legacy `config.json` can still supply `attach` or `autoAttach` until migration runs. `hive lead`, `hive setup`, and `hive doctor` migrate those settings once into global `hive.yml`; MCP reads never migrate or write files. Existing YAML keys, including null, win. Hive renames the original bytes to `config.json.migrated`. To reverse the migrated attach settings, remove their keys from global `hive.yml` and rename the archive back to `config.json` in the same data directory. A changed global lead command still needs approval for each project that uses it.

See [project configuration](projects.md#project-commands-hiveyml), [profiles](profiles.md#profiles-standing-instructions-across-projects), and [dashboard settings](dashboard.md#enable-it) for the project-specific examples.

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
