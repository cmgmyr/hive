# tmux settings for hive

hive drives tmux and sets the options it needs on every window it creates. This file separates the one global recommendation from settings that merely make the workflow pleasant, because hive has no business prescribing your terminal.

Everything here was measured on tmux 3.7b with Claude Code 2.1.221. Where a default surprised us, the measurement is written down next to it.

Almost all of this applies to **raw attach mode** (`hive setup --attach raw`). Under iTerm control mode (`-CC`) iTerm renders tmux windows as native tabs and panes, so it supplies most of this itself.

## What hive needs

hive marks its windows with `@hive-owned` and sets `allow-passthrough all`, `pane-border-status top`, `pane-border-format " #{pane_index} #{pane_title} "`, and `monitor-bell on` before starting the real process. Split panes inherit the window's settings, and respawned panes retain them. `hive doctor` reports the effective values on hive-owned windows rather than inspecting your global configuration.

No tmux configuration is required for hive-owned windows. One global recommendation remains for Claude Code sessions outside them:

```tmux
set -g allow-passthrough all
```

Set `allow-passthrough all` globally if you run Claude Code in any pane hive did not create.

### `allow-passthrough all`

Without this on a pane you get no notifications from Claude Code there. hive sets it on the windows it owns; the global recommendation covers panes hive knows nothing about.

Claude Code's `iterm2` notification channel emits an OSC 9 escape sequence, and when `$TMUX` is set it wraps that sequence in tmux's DCS passthrough (`\ePtmux;...\e\\`). tmux discards the wrapper unless `allow-passthrough` is on. Bare, unwrapped OSC 9 is discarded at every setting, which is why Claude wraps it.

Use `all`, not `on`. Measured, with a pty-captured client and a live control marker so a silent probe failure could not read as a drop:

| `allow-passthrough` | from the visible pane | from a background window |
|---|---|---|
| `off` (the default) | dropped | dropped |
| `on` | reaches the terminal | dropped |
| `all` | reaches the terminal | reaches the terminal |

Under `placement: split` a worker is a pane you are usually not looking at, and under `placement: window` it is a different window entirely, so `on` silences exactly the workers you are not watching.

**A detached session is beyond what this can fix.** A session with no client attached has nowhere to write, so neither the passthrough nor a bell reaches a client attached to a different session. See "Telling you a background project needs you" below.

### `pane-border-status` and `pane-border-format`

hive sets these on its own windows so split workers remain distinguishable.

hive names tmux windows (`<project> - lead`) and deliberately never names panes. A worker's identity comes from `claude --name <agent name>`, which Claude writes to the terminal title, which tmux records as `pane_title`. Under `placement: split` every worker is a pane in one window, so with `pane-border-status off` (the default) a whole crew reads as one window called `<project> - lead`.

Do not try to solve this with `select-pane -T`. hive did consider it and rejected it: the application writes its own title afterwards and wins. Measured again on 2026-08-03, `select-pane -T "hive - worker-1"` held until the pane's Claude session wrote its own OSC 0 title, and then read whatever Claude set.

## Suggested

None of this is required. It is what makes a multi-project tmux workflow bearable.

```tmux
set -g detach-on-destroy off
set -g set-titles on
set -g set-titles-string "#W - #T"
```

**`detach-on-destroy off`.** Exiting a project's lead ends the pane's command, which closes the window, which destroys a session that had only that window. The default then detaches you to a bare shell. With `off` your client moves to the most recently used other session instead, so leaving one project drops you into another rather than out of tmux.

**`set-titles on`.** tmux never sets the outer terminal's title unless you ask. In a plain attach your terminal tab keeps whatever title it had before you attached.

### Telling you a background project needs you

This is the one that needs both halves, and neither works alone.

```tmux
set -g monitor-bell on
setw -g monitor-activity off
set -g status-right-length 100
if-shell '! tmux show -gv status-right | grep -q session_alerts' \
  'set -ga status-right " #{S:#{?session_alerts,!#{session_name} ,}}"'
```

Set Claude Code's `preferredNotifChannel` to `iterm2_with_bell`. The OSC 9 half cannot escape a detached session, and the bell is the only part tmux can record.

tmux does record it. With a bell in a session you are not attached to, `list-sessions` reports `alerts=[0#!]` and `window_bell_flag=1`. It simply never tells a client attached to a different session, so the status line has to ask. The `#{S:...}` loop above renders every session that is flagged.

Three things went wrong building that, all worth not rediscovering:

- **`status-right-length` defaults to 40.** A theme's own right side can spend most of that, and the indicator is then computed correctly and truncated off the edge. `#{E:status-right}` expanded to `... 04-Aug-26 !hive-12` while the screen showed nothing.
- **`set -ga` is not idempotent.** Every `source-file` appends again, so a reload binding grows the value each time you use it. Hence the `if-shell` guard.
- **`monitor-activity` fires on any output**, so every session doing work flags itself and the indicator becomes noise. Bell only.

## Other considerations

Observations from running hive in raw tmux across two machines. None of this is hive's business; it is here so it is written down somewhere.

**Order matters if you use a theme.** A theme plugin's `run` line sets `status-left`, `status-right` and their lengths when it executes. Anything above that line is overwritten. Keep hive-related settings below it.

**Sessions are per project, and hive creates them.** `sessionName()` is `hive-<project_id>`, and workers, wake delivery, `hive status` and `hive doctor` all resolve through that name, so two projects cannot share one session. You never create the session yourself. `prefix c` gives you a shell to type `hive` into, and hive creates and switches to the session from there.

**`prefix c` leaves a shell window behind in whichever session you launched from.** A `display-popup` launcher avoids that, because the popup is not a window in any session and closes when its command exits:

```tmux
bind P command-prompt -p "project:" -I "~/Code/" "display-popup -E 'hive %%'"
```

Measured: `$TMUX` is set inside a popup, so `hive` takes its `switch-client` path and returns immediately, and the origin session keeps exactly the windows it had. Note `TMUX_PANE` is empty inside a popup, so do not spawn workers from one; that path reads `TMUX_PANE` to decide where a split lands.

**The session picker shows `hive-1`, not the project name.** Session names derive from the project id on purpose. Until that changes you can relabel the picker from data tmux already has, since hive names every window `<project> - lead` and a session line resolves `#{window_name}` to that session's current window:

```tmux
bind s choose-tree -Zs -F '#{s/ - lead$//:window_name}  ·  #{session_name}'
```

It mislabels a session whose current window is not the lead, and it does nothing for `hive status`.

**Never start the outer tmux with `-L` or a custom `TMUX_TMPDIR`.** hive refuses a private socket paired with the default store, on purpose, and the error is long. Plain `tmux` is correct. The reasoning is in `.claude/rules/tmux-and-panes.md`.

**Quote a leading `=` in a tmux target.** `tmux kill-session -t =hive-12` breaks in zsh, which expands a leading `=` as a command path. Write `-t '=hive-12'`.

## What this does not cover

hive never writes to your `~/.tmux.conf` and never sets a global tmux option on your behalf. It only configures windows carrying its own `@hive-owned` marker. `hive setup --attach raw` prints the remaining global recommendation.

hive's own test suite runs against a private tmux socket but still reads your `~/.tmux.conf`, because tmux reads its config when the server starts. A test whose assertions depend on pane geometry states that dependency itself; see `test/layout.test.mjs`.
