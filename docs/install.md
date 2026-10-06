# Install details

The npm and source install paths, the Node version and interpreter pin, the session-start plugin, one-time iTerm settings, the status line, registering hive in more than one MCP scope, updating, and uninstalling.

## Install from npm

Install the published package globally, then choose the setup section for your harness below. Both paths pin the Hive command to the Node interpreter running setup.

```bash
npm install -g @cmgmyr/hive
brew install tmux           # macOS; on Linux/WSL use your distribution's package manager
```

### Claude setup (default)

```bash
hive setup                  # equivalent to hive setup --harness claude
claude mcp add --scope user hive -- "$(command -v node)" "$(npm root -g)/@cmgmyr/hive/dist/index.js"
mkdir -p ~/.claude/skills
ln -s "$(npm root -g)/@cmgmyr/hive/claude-plugin" ~/.claude/skills/hive
```

The symlink is optional and enables Claude's session-start plugin. Claude remains the built-in lead and worker default.

### Codex setup (opt-in)

```bash
codex login
hive setup --harness codex
codex mcp add hive -- "$(command -v node)" "$(npm root -g)/@cmgmyr/hive/dist/index.js"
codex mcp get hive
```

Run `hive init` in your project if needed, then add the following keys to its `hive.yml`:

```yaml
lead: codex
agents: [codex]
```

Setup selects registration instructions only; it prints this recipe without modifying project or global harness settings. To use Codex across projects, put those keys in `$HIVE_DATA_DIR/hive.yml` (normally `~/.hive/hive.yml`). Project keys override machine defaults. The lead and worker pool are independent: `agents: [codex, claude]` allows both worker harnesses and defaults workers to Codex, but does not change `lead`.

Hive-managed Codex leads and workers currently require `~/.codex/auth.json`; Hive symlinks that file into generated homes. Other authentication storage arrangements are not automatically supported. Doctor checks that the file exists without reading its contents. Run `hive doctor` from the project, then `hive` from an interactive terminal and accept the configuration trust prompt. Doctor checks the effective lead and worker executables; it does not require an unused harness. Missing recognized lead executables fail before a lead row or pane is created. Custom commands or dynamic prefixes such as `PATH=... codex` are not preflighted, because their executable cannot be inferred safely from the caller's PATH.

Optional skills for ordinary Codex sessions:

```bash
mkdir -p ~/.agents/skills
ln -s "$(npm root -g)/@cmgmyr/hive/claude-plugin/skills/profile" ~/.agents/skills/hive-profile
ln -s "$(npm root -g)/@cmgmyr/hive/claude-plugin/skills/cleanup" ~/.agents/skills/hive-cleanup
```

Use `/skills` to check discovery. These links install skill instructions, not the Claude plugin's hooks. See [Codex session-start hooks](#codex-session-start-hooks) for the optional user hook.

Put `~/.local/bin` on your PATH below your version manager's block. See [Node version and the interpreter pin](#node-version-and-the-interpreter-pin) for why the order matters.

## From source

Clone and build before following either harness setup section above:

```bash
git clone https://github.com/cmgmyr/hive.git hive && cd hive
npm install
npm run build
npm link
```

For MCP registration, replace `$(npm root -g)/@cmgmyr/hive/dist/index.js` with `$(pwd)/dist/index.js`. For plugin or skill links, use this checkout's absolute `claude-plugin` path. Run `hive setup` for Claude or `hive setup --harness codex` for Codex, then follow the corresponding project configuration steps. Run `hive doctor` from the project you intend to launch.

## Node version and the interpreter pin

tmux is only needed for the agent tools; everything else runs without it.

The required Node range, `^22.14.0 || >=23.6.0`, is `better-sqlite3`'s, not hive's own code's. It is two ranges rather than one floor because a Node-API level starts once per release line: the addon needs Node-API 10, which begins at 22.14.0 on the 22 line and 23.6.0 on the 23 line. Node 23.0.0 through 23.5.0 satisfy a plain "22.14 or newer" and only provide Node-API 9, so they cannot load the addon.

`hive setup` and the `claude mcp add` line both register an absolute interpreter for the same reason: hive must not let the working directory pick its own. The addon is N-API, so it loads under any Node in the range above, but a Node version manager (asdf, nvm, volta, fnm, mise, Herd) resolves `node` per directory, and a directory can pin one below that range. Under such a Node the addon does not report an error; it kills the process inside `dlopen`, with no stack trace and no output at all. Pinning is what stops a `cd` from doing that.

Register the interpreter, not its name. `$(command -v node)` expands once, at registration, and freezes the absolute path of the Node you just built with. A bare `node` is resolved by Claude Code at launch instead, through whatever shim the launch directory pins, so a session started in a repo on a different Node major starts hive's server under that Node and `better-sqlite3` refuses to load with `ERR_DLOPEN_FAILED`. If you later build hive with a different Node, re-register: `claude mcp remove --scope user hive`, then re-add it with the new `$(command -v node)`.

`hive setup` writes a dispatcher to `~/.local/bin/hive`, and refuses to point it at a build inside a linked git worktree, since worktrees are disposable and the shim breaks the moment its target is torn down (`--force` overrides). Put that ahead of any version manager's shims in your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"     # below the version manager's block in the file
```

Both lines prepend to PATH, so whichever runs LAST ends up first. Put hive's line below the version manager's, not above it, or the version manager's shim wins and you are back to the failure `hive setup` exists to prevent.

## Codex leads and workers

Both leads and workers can run `codex`. Set `lead: codex` for the lead and configure `agents` separately for workers. Requirements:

- The `codex` CLI installed and logged in (`codex login`). A codex worker's per-worker home symlinks its credentials from `~/.codex/auth.json`, so hive needs that file to already exist.
- The project's `hive.yml` opting in: `agents: [claude, codex]` (see [docs/projects.md](projects.md#project-commands-hiveyml)). With no `agents:` key, a project allows `claude` only, and spawning codex, whether through `agent_spawn`'s `harness` parameter or a `command` that resolves to it, refuses with `[agent_spawn:harness-not-allowed]`. Add `codex` to `agents:` and spawn again.

`agents` can also be set as a machine-wide default in `$HIVE_DATA_DIR/hive.yml`. A project list replaces that value. See [global defaults](configuration.md#global-defaults).

A codex worker supports most of the same lifecycle and reporting features, with a few limits:

- You can park and resume a codex worker when it has a recorded session id and its working directory and Codex home remain available (`supportsResume`, `src/harnesses.ts:182`; `agent_park`, `src/tools/agents.ts:1093`; `agent_resume`, `src/tools/agents.ts:920`). `agent_close` clears the Codex home needed by resume; it preserves the rollout file for reporting, but the closed session cannot be resumed (`reapCodexHomeForClosedAgent`, `src/spawn.ts:645`; `reapCodexHome`, `src/codexHome.ts:120`; `resumeHarness.name`, `src/tools/agents.ts:973`).
- `hive doctor` and standing-watch stall notices can report a codex worker stalled when its recorded rollout file is available and stale. They skip it when no readable transcript signal exists (`reportStalledWorkers`, `src/cli.ts:2833`; `noteStalledCrew`, `src/scheduler.ts:1961`; `transcriptStaleness`, `src/scheduler.ts:1879`).
- Context percentages can be read from Codex rollout token-count events when that data is present; unavailable or unreadable rollout data produces no percentage (`readContextFill`, `src/transcript.ts:108-133`; `contextFillField`, `src/tools/agents.ts:551-553`).
- Hive does not inject `.claude/rules/*.md` into Codex workers. Hive passes the worker brief and selected local instruction files to Codex; include a rule in the brief when the worker needs it (`ensureCodexHome`, `src/codexHome.ts:309`).

`agents:` is accident prevention, not a security boundary: the gate matches on the command's basename, so it stops an ordinary spawn, not someone deliberately working around it. See [docs/projects.md](projects.md#project-commands-hiveyml).

## Claude session-start plugin

Symlink the plugin once per machine, not per project:

```bash
ln -s "$(npm root -g)/@cmgmyr/hive/claude-plugin" ~/.claude/skills/hive
```

A session opened afterward in a project root, on a lead branch, with a profile that resolves, starts with hive's live state already loaded: the board pad, in-flight and dispatchable todos, running workers, and pending wake-ups. See [docs/profiles.md](profiles.md) for what it loads, when it stays silent, and `hive kickoff --explain`.

## Codex session-start hooks

Hive-launched Codex leads already receive a generated `CODEX_HOME` with MCP configuration, lifecycle hooks, and `kickoff --codex`. No user-level kickoff hook is needed for those sessions. Hive-managed worker homes contain their own lifecycle hooks and do not receive the lead kickoff.

For ordinary Codex sessions started outside Hive, optionally merge this entry into `~/.codex/hooks.json`, preserving any existing hooks. Replace both placeholders with the absolute Node and package paths from your installation:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"/absolute/path/to/node\" \"/absolute/path/to/hive/claude-plugin/kickoff.mjs\" --codex",
            "timeout": 10,
            "statusMessage": "Loading Hive project context"
          }
        ]
      }
    ]
  }
}
```

The `--codex` argument selects Codex-compatible output. Review and trust this user hook through `/hooks`, then start a new session. See [Codex's hook documentation](https://learn.chatgpt.com/docs/hooks). The hook stays silent outside the configured project/profile/lead-branch conditions; use `hive kickoff --codex --explain` to inspect those gates. Avoid registering a second kickoff hook when one is already provided for that session.

## One-time iTerm settings (macOS)

The first time a worker spawns with nobody attached, macOS asks permission for hive to control iTerm; approve it once. This applies under either attach mode: `raw` still opens iTerm, just without control mode.

With the default `auto` attach mode (or `control`), set these once per machine under Settings > General > tmux:

- Check "Automatically bury the tmux client session after connecting". Without this, every attach leaves an idle gateway window in the background. Don't close that window by hand; closing it detaches the whole session. Bury applies on the next attach.
- Set "When attaching, restore windows as" to "Native tabs in the attaching window". Running `hive` then opens the session as tabs in the window you ran it from instead of spawning a new macOS window. ("Native tabs in a new window" also works if you prefer the session in its own window.)
- Optional: check "Unpause automatically" under Pausing. Claude sessions stream heavy output, and this keeps a lagging pane from freezing its display. Delivery is unaffected either way; wake-ups and `agent_send` go through the tmux server, not the display.

None of these apply under `hive setup --attach raw`: iTerm's tmux integration (and its "bury"/"restore windows as" settings) only activates for a `tmux -CC` client, and a raw attach never runs one.

## Claude status line

`hive statusline` prints a one-line summary (`⬡ hive: 2 agents · 4 todos (2 ready) · 3 pads`) and prints nothing when a project has no live state (no agents, todos, pads, or wake-ups) or is not registered at all, so it is safe to run everywhere. A lead can pipe Claude Code's statusline JSON to it, for example `printf '%s' "$input" | hive statusline`; when that JSON includes `transcript_path`, the lead summary adds its API-response count as `turns N`. Workers and plain shells never print that field. When a wake-up is held, it adds a segment naming the count of every held wake, plus the age and reason for the one it's telling you about - a `typing` hold when there is one, since that's the one you can clear yourself, otherwise the oldest: `2 wakes · 2 held (4m, typing)` means an input box (most likely your own) has unsubmitted text sitting in it, even if an older hold for another reason is also waiting. The other three reasons are `talking` (a message was SENT to this lead in the last five minutes - usually by you - so hive is holding the wake rather than splitting the conversation; unlike `typing`, which is text still sitting unsent, this needs a submitted turn. See [Wake-ups, not polling](daily-driver.md#wake-ups-not-polling)), `needs you` (nothing clears it without running `hive lead` or `wake_cancel`), and `blocked` (waiting on something else to resolve, such as a dialog). If you use a custom status line script, append the block below. Claude Code sends its statusline JSON on stdin, and stdin can be read only once, so the block reuses `$input` when your script already holds the JSON there (the usual `input=$(cat)` at the top). If your script reads stdin some other way, such as `jq` straight off stdin, read it into `$input` first and point `jq` at that instead, or the lead loses `turns N`:

```bash
# Reads stdin only if the script has not already put the JSON in $input.
: "${input=$(cat)}"

# Hive store summary (second line, only inside hive-enabled projects).
if command -v hive >/dev/null 2>&1; then
  hive_line=$(printf '%s' "$input" | hive statusline 2>/dev/null)
  if [ -n "$hive_line" ]; then
    printf '\n%s' "$hive_line"
  fi
fi
```

Use a plain `if`, not `[ ... ] && printf`: as the last command in the script, that pattern exits 1 when the line is empty, and a failing status line command renders nothing at all.

Hive-spawned Claude workers keep your existing statusline command. Their generated settings wrap the effective local project, shared project, or user command, forward its input unchanged, and relay its output. The wrapper records only the model's context window size so hive can report worker context fill. It preserves your refresh interval and display options. Lead sessions keep their existing settings. The optional [worker context checkpoint](projects.md#worker-context-checkpoint) adds a per-tool hook only when your project enables it.

The status line only re-renders on session activity by default. Add `"refreshInterval": 10` to the `statusLine` block in `~/.claude/settings.json` so the counts stay current while the session sits idle:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/statusline.sh",
  "refreshInterval": 10
}
```

## Claude MCP registration scopes

`--scope user` makes hive available in every project, which is right for most machines. If you also run another MCP server with similar tool names (`todo_create`, `kv_set`, `lease_acquire`), register per project instead: run `claude mcp add hive -- "$(command -v node)" "$(npm root -g)/@cmgmyr/hive/dist/index.js"` from that project's directory, or use the checkout's `dist/index.js` when you installed from source. Loading two overlapping catalogs in one session invites Claude to write to the wrong store.

Register hive in one scope only. A project-scoped registration shadows the user-scoped one, and `claude mcp list` is the way to catch it: two entries named hive means the project one is what your session is actually running.

## Updating

### Global npm install

Run `hive upgrade` to check the latest published version, install it, and re-pin the command through the new install's own setup. It keeps the absolute Node interpreter running your current CLI. `hive upgrade --check` prints the commands and makes no changes to your install: no install, setup, dispatcher write, MCP config write, or update-cache write. Like other CLI commands, it still opens hive's database.

```bash
hive upgrade --check
hive upgrade
hive doctor --strict
```

An already-current install exits successfully without installing or re-pinning. If npm cannot report a version, upgrade exits with an unknown result and installs nothing. `HIVE_NO_UPDATE_CHECK=1` also prevents the registry query and upgrade. The npm on your PATH must own the running package's global root. If a version manager switched that root, put the npm for this install first on PATH before retrying. Copied installs and npx caches are refused.

### From source

`hive upgrade` detects the checkout containing its running `dist/cli.js`, including linked worktrees. By default it prints the recipe. `hive upgrade --check` does the same. Run it only when you want to pull, install, build, and re-pin:

```bash
hive upgrade --run
hive doctor --strict
```

The steps run in the checkout, in this order, and stop on the first failure. The printed recipe names your current absolute interpreter and the new CLI explicitly:

```bash
cd <this checkout>
git pull --ff-only
npm install
npm run build
"<absolute path to the current Node interpreter>" "<this checkout>/dist/cli.js" setup
```

Do not re-pin through bare `hive setup` or ambient `node`: either can select the interpreter you meant to replace. Upgrade runs the explicit interpreter and CLI command above. Setup still refuses to pin a linked worktree without `--force`; use a durable checkout for your installed command. `--run` is only for checkouts and cannot be combined with `--check`.

### Registration drift and recovery

Setup and doctor report interpreter and server-path drift for registrations hive recognises as hive; a renamed registration whose path no longer points at the current hive dist is not detected. They print the exact repair commands for the current install and never edit those tools' configuration files. Codex repairs print `codex mcp remove` followed by `codex mcp add`. Run the commands shown, then `hive doctor --strict`. Registration drift warns but does not turn a completed upgrade into a failure.

If npm fails, the package may be partially changed. Follow the printed install retry and explicit setup command. If setup fails after npm succeeds, the package is new but the dispatcher has not been confirmed re-pinned. Run the printed command naming the absolute interpreter and new `dist/cli.js`, then `hive doctor --strict`. Checkout failures name the failed step and list the remaining steps as not run. Repair that step before continuing.

**Restart every Claude Code or Codex session that has hive loaded after upgrading or completing a repair.** Existing sessions keep running old in-memory code even after the files change.

`npm install` deciding a package is up to date is not proof the addon file is still there, and this is measured rather than assumed: delete `node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`, run a plain `npm install`, and it prints `up to date` without restoring it. The repair is to make npm reinstall the package rather than re-examine it:

```bash
rm -rf node_modules/better-sqlite3 && npm install    # ~1s, no compiler; npm ci does the same for the whole tree
```

`npm rebuild better-sqlite3` also repairs it, and is the wrong tool: with the prebuild gone it does a full source build into `build/Release/`, which works and which hive will load, but it needs node-gyp, Python and a C++ toolchain to reproduce a file the tarball already contains. It is not worth reaching for, because on a healthy tree it accomplishes nothing: the package's own `binding.gyp` makes npm's node-gyp step a no-op whenever a prebuild for the host is present.

Run `hive doctor` last, every time: it is the step that actually verifies the addon, the pin, and the registration agree, rather than assuming the steps above got there.

The plugin symlink is a live pointer too, so the session-start hook and the shipped profile defaults update with the same pull. Files you forked into `~/.hive/profiles/` are yours and are never touched; `hive doctor` tells you when hive's version of one moved.

The new code reaches each entry point at a different time:

- The `hive` CLI picks it up immediately; every invocation is a fresh process.
- New Claude Code or Codex sessions pick it up immediately; each session starts its own server from `dist/`.
- Sessions already running keep the old server in memory. Run `/mcp` in that session and reconnect hive, or let it catch up when the session ends. Pulling before you open sessions for the day avoids this entirely.

When developing hive itself, copy `hive.example.yml` to `hive.yml` (gitignored, so your lead command and vars stay yours) and uncomment its `watch: npm run watch` process. That auto-starts the compiler with the session and replaces the manual build step. The restart rules for running sessions still apply.

## Uninstall

For Codex, run `codex mcp remove hive`. Remove only the Hive skill symlinks you created under `~/.agents/skills`, and remove only Hive's `SessionStart` entry from user `hooks.json`, preserving other hooks. Skip the Claude-specific registration and symlink commands below if you did not use them. After upgrades, verify ordinary Codex registration with `codex mcp get hive`; Hive-managed sessions regenerate their configuration when launched.


Hive touches six things on a machine; remove them in any order:

```bash
hive status                     # confirm the session name, then end it:
tmux kill-session -t =hive-main # every project's windows live in this one session
tmux ls | grep view- || true    # a second terminal's attach opens its own VIEW
                                 # session grouped with hive-main; kill those
                                 # too (or just close their terminals - a view
                                 # destroys itself once its own client detaches)
claude mcp remove hive          # the MCP registration (add --scope user if registered there)
npm uninstall -g @cmgmyr/hive  # the npm install, if you used it
npm rm -g hive                  # the linked hive command, if you used it
rm ~/.local/bin/hive            # the dispatcher hive setup wrote, if you ran it
rm ~/.claude/skills/hive        # the session-start plugin symlink, if you made it
rm -rf ~/.hive                  # database, hooks file, forked profiles, ALL shared state
```

One session holds every project, so this is one `kill-session`, not one per project, but only when nothing else is attached. A window belongs to every session it is grouped with, not only to `hive-main`, so `kill-session -t =hive-main` does not tear the windows down while a VIEW session (opened by any other terminal's `hive attach`, `hive lead`, or `hive <project>`) is still holding them; the windows simply keep living under that view until it too is killed or its last client detaches. `tmux kill-server` would take down every tmux session on the machine, including ones that have nothing to do with hive. Sessions also end on their own once their panes exit, so you can skip the first two lines entirely if nothing is running.

Then revoke the automation permission under System Settings > Privacy & Security > Automation (the entry allowing your terminal to control iTerm), and delete the checkout.
