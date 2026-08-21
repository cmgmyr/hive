# Install details

The Node version and interpreter pin, the session-start plugin, one-time iTerm settings, the status line, registering hive in more than one MCP scope, updating a checkout, and uninstalling.

## Node version and the interpreter pin

tmux is only needed for the agent tools; everything else runs without it.

The required Node range, `^22.14.0 || >=23.6.0`, is `better-sqlite3`'s, not hive's own code's. It is two ranges rather than one floor because a Node-API level starts once per release line: the addon needs Node-API 10, which begins at 22.14.0 on the 22 line and 23.6.0 on the 23 line. Node 23.0.0 through 23.5.0 satisfy a plain "22.14 or newer" and only provide Node-API 9, so they cannot load the addon.

`hive setup` and the `claude mcp add` line both register an absolute interpreter for the same reason: hive must not let the working directory pick its own. The addon is N-API, so it loads under any Node in the range above, but a Node version manager (asdf, nvm, volta, fnm, mise, Herd) resolves `node` per directory, and a directory can pin one below that range. Under such a Node the addon does not report an error; it kills the process inside `dlopen`, with no stack trace and no output at all. Pinning is what stops a `cd` from doing that.

Register the interpreter, not its name. `$(command -v node)` expands once, at registration, and freezes the absolute path of the Node you just built with. A bare `node` is resolved by Claude Code at launch instead, through whatever shim the launch directory pins, so a session started in a repo on a different Node major starts hive's server under that Node and `better-sqlite3` refuses to load with `ERR_DLOPEN_FAILED`. If you later build hive with a different Node, re-register: `claude mcp remove --scope user hive`, then re-add it with the new `$(command -v node)`.

## Session-start plugin

Symlink the plugin once per machine, not per project:

```bash
ln -s "$(pwd)/claude-plugin" ~/.claude/skills/hive
```

A session opened afterward in a project root, on a lead branch, with a profile that resolves, starts with hive's live state already loaded: the board pad, in-flight and dispatchable todos, running workers, and pending wake-ups. See [docs/profiles.md](profiles.md) for what it loads, when it stays silent, and `hive kickoff --explain`.

## One-time iTerm settings

The first time a worker spawns with nobody attached, macOS asks permission for hive to control iTerm; approve it once. This applies under either attach mode: `raw` still opens iTerm, just without control mode.

With the default `auto` attach mode (or `control`), set these once per machine under Settings > General > tmux:

- Check "Automatically bury the tmux client session after connecting". Without this, every attach leaves an idle gateway window in the background. Don't close that window by hand; closing it detaches the whole session. Bury applies on the next attach.
- Set "When attaching, restore windows as" to "Native tabs in the attaching window". Running `hive` then opens the session as tabs in the window you ran it from instead of spawning a new macOS window. ("Native tabs in a new window" also works if you prefer the session in its own window.)
- Optional: check "Unpause automatically" under Pausing. Claude sessions stream heavy output, and this keeps a lagging pane from freezing its display. Delivery is unaffected either way; wake-ups and `agent_send` go through the tmux server, not the display.

None of these apply under `hive setup --attach raw`: iTerm's tmux integration (and its "bury"/"restore windows as" settings) only activates for a `tmux -CC` client, and a raw attach never runs one.

## Status line

`hive statusline` prints a one-line summary (`⬡ hive: 2 agents · 4 todos (2 ready) · 3 pads`) and prints nothing when a project has no live state (no agents, todos, pads, or wake-ups) or is not registered at all, so it is safe to run everywhere. When a wake-up is held, it adds a segment naming the count of every held wake, plus the age and reason for the one it's telling you about - a `typing` hold when there is one, since that's the one you can clear yourself, otherwise the oldest: `2 wakes · 2 held (4m, typing)` means an input box (most likely your own) has unsubmitted text sitting in it, even if an older hold for another reason is also waiting. The other three reasons are `talking` (a message was SENT to this lead in the last five minutes - usually by you - so hive is holding the wake rather than splitting the conversation; unlike `typing`, which is text still sitting unsent, this needs a submitted turn. See [Wake-ups, not polling](daily-driver.md#wake-ups-not-polling)), `needs you` (nothing clears it without running `hive lead` or `wake_cancel`), and `blocked` (waiting on something else to resolve, such as a dialog). If you use a custom status line script, append it:

```bash
# Hive store summary (second line, only inside hive-enabled projects).
if command -v hive >/dev/null 2>&1; then
  hive_line=$(hive statusline 2>/dev/null)
  if [ -n "$hive_line" ]; then
    printf '\n%s' "$hive_line"
  fi
fi
```

Use a plain `if`, not `[ ... ] && printf`: as the last command in the script, that pattern exits 1 when the line is empty, and a failing status line command renders nothing at all.

The status line only re-renders on session activity by default. Add `"refreshInterval": 10` to the `statusLine` block in `~/.claude/settings.json` so the counts stay current while the session sits idle:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/statusline.sh",
  "refreshInterval": 10
}
```

## Registering hive in more than one scope

`--scope user` makes hive available in every project, which is right for most machines. If you also run another MCP server with similar tool names (`todo_create`, `kv_set`, `lease_acquire`), register per project instead: run `claude mcp add hive -- "$(command -v node)" /absolute/path/to/hive/dist/index.js` from that project's directory. Loading two overlapping catalogs in one session invites Claude to write to the wrong store.

Register hive in one scope only. A project-scoped registration shadows the user-scoped one, and `claude mcp list` is the way to catch it: two entries named hive means the project one is what your session is actually running.

## Updating

See the README's [Updating](../README.md#updating) section for the exact recipe; `hive` runs `dist/cli.js`, and the MCP registration runs `<absolute node> <checkout>/dist/index.js`, both live pointers into your checkout.

The pin is the part that can drift, and the way it drifts changed with `better-sqlite3` 13. The addon is no longer built here, so it is no longer built *against* a particular Node, and an update cannot leave the addon and the interpreter disagreeing about a compiled ABI. What can still happen is that the interpreter running setup is not the one you want pinned, or that a version manager retires the Node your dispatcher names. Re-running setup costs nothing when nothing changed, and `hive doctor` says so either way. If the interpreter changed, the MCP server needs re-registering too, and `hive setup` prints the exact line for it: pinning the `hive` command does not touch the registration Claude Code starts the server from. Setup says nothing when the registration already runs the interpreter it pinned.

`npm install` deciding a package is up to date is not proof the addon file is still there, and this is measured rather than assumed: delete `node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`, run a plain `npm install`, and it prints `up to date` without restoring it. The repair is to make npm reinstall the package rather than re-examine it:

```bash
rm -rf node_modules/better-sqlite3 && npm install    # ~1s, no compiler; npm ci does the same for the whole tree
```

`npm rebuild better-sqlite3` also repairs it, and is the wrong tool: with the prebuild gone it does a full source build into `build/Release/`, which works and which hive will load, but it needs node-gyp, Python and a C++ toolchain to reproduce a file the tarball already contains. It is not worth reaching for, because on a healthy tree it accomplishes nothing: the package's own `binding.gyp` makes npm's node-gyp step a no-op whenever a prebuild for the host is present.

Run `hive doctor` last, every time: it is the step that actually verifies the addon, the pin, and the registration agree, rather than assuming the steps above got there.

The plugin symlink is a live pointer too, so the session-start hook and the shipped profile defaults update with the same pull. Files you forked into `~/.hive/profiles/` are yours and are never touched; `hive doctor` tells you when hive's version of one moved.

The new code reaches each entry point at a different time:

- The `hive` CLI picks it up immediately; every invocation is a fresh process.
- New Claude Code sessions pick it up immediately; each session starts its own server from `dist/`.
- Sessions already running keep the old server in memory. Run `/mcp` in that session and reconnect hive, or let it catch up when the session ends. Pulling before you open sessions for the day avoids this entirely.

When developing hive itself, this project's `hive.yml` auto-starts `npm run watch`, which replaces the manual build step. The restart rules for running sessions still apply.

## Uninstall

Hive touches six things on a machine; remove them in any order:

```bash
hive status                     # confirm the session name, then end it:
tmux kill-session -t =hive-main # every project's windows live in this one session
tmux ls | grep view- || true    # a second terminal's attach opens its own VIEW
                                 # session grouped with hive-main; kill those
                                 # too (or just close their terminals - a view
                                 # destroys itself once its own client detaches)
claude mcp remove hive          # the MCP registration (add --scope user if registered there)
npm rm -g hive                  # the linked hive command
rm ~/.local/bin/hive            # the dispatcher hive setup wrote, if you ran it
rm ~/.claude/skills/hive        # the session-start plugin symlink, if you made it
rm -rf ~/.hive                  # database, hooks file, forked profiles, ALL shared state
```

One session holds every project, so this is one `kill-session`, not one per project, but only when nothing else is attached. A window belongs to every session it is grouped with, not only to `hive-main`, so `kill-session -t =hive-main` does not tear the windows down while a VIEW session (opened by any other terminal's `hive attach`, `hive lead`, or `hive <project>`) is still holding them; the windows simply keep living under that view until it too is killed or its last client detaches. `tmux kill-server` would take down every tmux session on the machine, including ones that have nothing to do with hive. Sessions also end on their own once their panes exit, so you can skip the first two lines entirely if nothing is running.

Then revoke the automation permission under System Settings > Privacy & Security > Automation (the entry allowing your terminal to control iTerm), and delete the checkout.
