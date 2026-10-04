# What hive can do on your machine

This page lists the local commands hive runs, the files it writes, and its network access. Code citations name the implementation to check.

## NETWORK

- `queryUpdate` (`src/updateCheck.ts:78`) runs `npm view @cmgmyr/hive version` for an explicit `hive --version --check` (`refreshUpdate`, `src/cli.ts:4214`), a global `hive upgrade` (`cmdUpgrade`, `src/cli.ts:2162`; `queryUpdate`, `src/updateCheck.ts:78`), or an interactive doctor refresh when the cache is stale (`cmdDoctor`, `src/cli.ts:2906`; `refreshUpdate`, `src/cli.ts:2936`; `shouldAutoRefresh`, `src/updateCheck.ts:122`). Hive passes npm the package/version query; npm applies its own registry and authentication configuration. `HIVE_NO_UPDATE_CHECK=1` disables this version query (`queryUpdate`, `src/updateCheck.ts:78`).
- An upgrade can also download software: a global install runs `npm install -g @cmgmyr/hive@latest` (`globalUpgradeSteps`, `src/upgrade.ts:49`), while a checkout runs `git pull --ff-only` and `npm install` only when you pass `--run` (`checkoutUpgradeSteps`, `src/upgrade.ts:40`; `parsed.flags.has`, `src/cli.ts:2197`; `spawnSync`, `src/cli.ts:2205`). The flag disables only the version query; it does not prevent downloads from an explicitly run checkout upgrade. A global upgrade stops before installing when the flag disables its version query (`update.status`, `src/cli.ts:2190`). Hive's built-in outbound network activity starts through the version query or an upgrade.
- The MCP server, hooks, and scheduler make no network request (`StdioServerTransport` connection in `src/index.ts:51`; hook process configuration in `hookEntry`, `src/hooks.ts:17`; `startScheduler`, `src/index.ts:49`).

## EXECUTES

- `launchAgent` (`src/spawn.ts:301`) starts Claude Code or Codex commands inside tmux panes; tmux is also invoked by `tmuxWithin` (`src/tmux.ts:120`). These commands receive the configured working directory, launch arguments, and generated worker settings.
- `ensureWorkerHooksFile` (`src/hooks.ts:46`) writes Claude hook settings that run `hive hook` processes; `hookEntry` (`src/hooks.ts:17`) builds those commands. Codex worker homes receive equivalent hooks through `ensureCodexHooksFile` (`src/codexHome.ts:290`).
- When the Claude Code plugin is enabled, its `SessionStart` hook runs `node "${CLAUDE_PLUGIN_ROOT}/kickoff.mjs"` in each session (`SessionStart`, `claude-plugin/hooks/hooks.json:3`; `runKickoff`, `claude-plugin/kickoff.mjs:41`). The script can re-execute under the pinned interpreter if its ABI check fails (`reexecUnderPinnedInterpreter`, `claude-plugin/kickoff.mjs:6`). For sessions in a configured project, `evaluate` (`src/kickoff.ts:169`) skips only workers with `HIVE_AGENT_ID` set unless `HIVE_LEAD=1`; `kickoffGate` (`src/kickoff.ts:149`) requires project config, an installed profile, and a lead branch, then adds board, todo, worker, and wake-up context to the registered project session.
- `hive doctor` probes each configured project's Node interpreter by running `node` with hive's `abiProbe.js` (`reportSessionInterpreters`, `src/cli.ts:2411`; `probeSessionInterpreter`, `src/sessionProbe.ts:32`; `runProbe`, `src/sessionProbe.ts:40`).
- `currentGit` (`src/version.ts:84`) runs `git rev-parse --short HEAD` and `git status --porcelain` in hive's own checkout root to label a build (`execFileSync`, `src/version.ts:86`).
- `statusLineEntry` (`src/statusline.ts:57`) wraps the user's effective Claude Code `statusLine` command for a worker; `execFileSync` (`src/statusline.ts:73`) runs that same saved command through `/bin/sh -c` with the same stdin, as Claude Code would without hive.
- `cmdPad` (`src/cli.ts:4116`) runs the editor selected by `HIVE_EDITOR` or `open` to edit an exported pad. The CLI also runs helper commands such as `git`, `tmux`, `ps`, `sysctl`, `which`, `osascript`, `open`, and `npm` (`execFileSync`, `src/context.ts:119`; `execFileSync`, `src/tmux.ts:523`; `execFileSync`, `src/ptys.ts:51`; `execFileSync`, `src/cli.ts:1724`; `execFileSync`, `src/updateCheck.ts:87`).
- `startYmlCommand` (`src/cli.ts:458`) and `cmdStart` (`src/cli.ts:1763`) start `hive.yml` process commands; `cmdUpgrade` (`src/cli.ts:2162`) runs the displayed upgrade steps. Hive runs configured `hive.yml` commands only after interactive approval for the current config hash (`isTrusted`, `src/cli.ts:445`; `configHash`, `src/projectYml.ts:390`). A changed command, directory, or environment requires approval again. The configured `dir` and `profile` cannot escape their allowed roots (`resolveCommandDir`, `src/projectYml.ts:396`; `resolveProfileFile`, `src/profiles.ts:35`).
- At install time, npm does not run better-sqlite3's synthesized `node-gyp rebuild` script because `package.json` denies it (`allowScripts`, `package.json:61`); hive loads the package's prebuilt native addon (`checkAbi`, `src/abi.ts:77`).

## WRITES

- The SQLite store and its SQLite-managed `-wal` and `-shm` files live in `<data dir>/hive.db`; the default data directory is `~/.hive` (`storePath`, `src/db.ts:17`; `DEFAULT_DATA_DIR`, `src/dataDir.ts:7`).
- Automatic database and profile snapshots are written under `<data dir>/backups/`, pruned by retention, and can restore the database and profiles (`takeSnapshot`, `src/backup.ts:91`; `pruneSnapshots`, `src/backup.ts:236`; `restoreSnapshot`, `src/backup.ts:454`).
- The update-check cache is `<data dir>/update-check.json` (`writeCache`, `src/updateCheck.ts:69`).
- Global settings are written to `<data dir>/hive.yml`, and legacy settings may be archived (`globalConfigPath`, `src/globalConfig.ts:41`; `writeGlobalConfigKey`, `src/globalConfig.ts:166`; `migrateLegacyConfig`, `src/globalConfig.ts:174`).
- Claude hook settings are written to `<data dir>/hooks.json` and `<data dir>/worker-<id>-hooks.json` (`ensureHooksFile`, `src/hooks.ts:28`; `ensureWorkerHooksFile`, `src/hooks.ts:46`).
- The pinned `hive` shim is written under the dispatcher directory (`cmdSetup`, `src/cli.ts:2225`; `writeFileSync`, `src/cli.ts:2282`).
- Project setup can write `hive.yml`, `.gitignore`, and `.hive/` setup files (`cmdInit`, `src/cli.ts:1285`; `writeProfileKey`, `src/cli.ts:1279`; `publishQueenYml`, `src/cli.ts:1050`).
- Profile forks and their origin records are written under `<data dir>/profiles/`, including `posture.md` (`userProfilesDir`, `src/profiles.ts:13`; `forkProfile`, `src/profiles.ts:197`; `writeOrigin`, `src/profiles.ts:122`).
- Worker briefs and project postures are written under `<data dir>/briefs/` and `<data dir>/postures/` (`writeAgentBrief`, `src/brief.ts:96`; `writeProjectPosture`, `src/brief.ts:116`).
- A Codex home at `<data dir>/codex-homes/<key>/` is created when hive launches a Codex session; hive writes `config.toml` and `hooks.json` there and creates links to auth, optional global instructions, and the cleanup skill (`codexHomeDir`, `src/codexHome.ts:45`; `ensureCodexHome`, `src/codexHome.ts:309`; `ensureCodexHooksFile`, `src/codexHome.ts:290`).
- When hive reaps a Codex home, it preserves its rollout files under `<data dir>/codex-rollouts/<key>/` before removing the home (`codexRolloutsDir`, `src/codexHome.ts:49`; `preserveCodexRollouts`, `src/codexHome.ts:84`; `reapCodexHome`, `src/codexHome.ts:120`).
- The scheduler appends `<data dir>/teardowns.jsonl` when it records a teardown after the no-panes-on-socket condition (`recordTeardown`, `src/scheduler.ts:274`; `TEARDOWN_LOG`, `src/teardown.ts:4`; `appendTeardown`, `src/teardown.ts:60`).
- When a configured checkpoint threshold is reached, the checkpoint hook creates `<data dir>/context-checkpoints/<encoded actor id>.fired`; it removes that marker after usage drops below threshold (`contextCheckpointAdditionalContext`, `src/contextCheckpoint.ts:6`; `runContextCheckpointHook`, `src/contextCheckpoint.ts:24`).
- A Claude worker's statusline records a valid context window size at `<data dir>/context-windows/<encoded actor id>.json`, and rewrites it only when the value changes (`claudeWindowPath`, `src/transcript.ts:94`; `recordClaudeWindowSize`, `src/statusline.ts:34`).
- When enabled in project config, the scheduler writes the dashboard to `<project>/.hive/dashboard.html` when its content changes (`resolveDashboardFile`, `src/scheduler.ts:584`; `maybeGenerateDashboard`, `src/scheduler.ts:600`; `writeDashboardAtomically`, `src/scheduler.ts:563`).
- `hive pad` can export a pad to a path you choose (`cmdPad`, `src/cli.ts:4116`). Restore and cleanup commands can replace or remove hive-managed files in the data directory, generated Codex homes, or exported pad files (`restoreSnapshot`, `src/backup.ts:454`; `unlinkSync`, `src/cli.ts:4178`; `rmSync`, `src/tools/agents.ts:815`).

## NOT GATED

- `hive.yml` `vars` reach the lead's system prompt and every worker's brief with no approval gate. Treat a cloned repo's `hive.yml` as system-prompt input (`mergedProjectVars`, `src/projectYml.ts:101`; `mergedBriefVars`, `src/brief.ts:60`).

## PROCESS MODEL

- The MCP server uses stdio, opens no listening port, and starts no daemon (`StdioServerTransport`, `src/index.ts:51`). The scheduler runs unref'd inside each server instance (`startScheduler`, `src/scheduler.ts:194`).
