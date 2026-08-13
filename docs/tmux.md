# tmux settings for hive

hive configures the tmux windows it creates and sets the options it needs on each one. This file separates the one global recommendation from settings that merely make the workflow pleasant, because hive has no business prescribing your terminal.

Everything here was measured on tmux 3.7b with Claude Code 2.1.221. Where a default surprised us, the measurement is written down next to it.

Almost all of this applies to **raw attach mode** (`hive setup --attach raw`). Under iTerm control mode (`-CC`) iTerm renders tmux windows as native tabs and panes, so it supplies most of this itself.

## Attach mode

Two places decide whether tmux attaches carry iTerm's control mode (`-CC`): your own `hive lead`/`hive attach`, and auto-open (see docs/daily-driver.md). One stored setting controls both:

| `hive setup --attach <mode>` | `hive lead` / `hive attach` | Auto-open |
|---|---|---|
| `auto` (default) | control mode iff your terminal is iTerm | iTerm in control mode, then Terminal |
| `raw` | never control mode | iTerm running a plain `tmux attach`, then Terminal |
| `control` | always control mode | unchanged from `auto` |

`auto` is today's behavior: nothing changes if you never touch this. Prefer tmux's own key bindings over `-CC`'s window management, or want a raw tmux session under any terminal? `hive setup --attach raw`. `hive doctor` reports the effective mode, where it came from, and the settings carried by hive-owned windows.

## What hive needs

hive marks its windows with `@hive-owned` and sets `allow-passthrough all`, `pane-border-status top`, `pane-border-format " #{pane_index} #{pane_title} "`, `monitor-bell on`, and `window-size smallest` before starting the real process. Split panes inherit the window's settings, and respawned panes retain them. `hive doctor` reports the effective values on hive-owned windows rather than inspecting your global configuration.

`window-size smallest` matters once a second terminal is looking at the same session through a view session (see "Every terminal gets its own view onto the same windows" below): tmux's default, `latest`, resizes every window to whoever focused it last, so two clients fight over the size. `smallest` letterboxes a window to the smaller of the two clients' terminals instead, which is a real cost Chris accepted deliberately: the letterboxing is a visible signal that a view session is open, not a bug to fix later.

No tmux configuration is required for hive-owned windows, so raw attach mode needs no global pane-border settings; `allow-passthrough all` remains a global notification recommendation for Claude Code sessions outside them:

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

hive names tmux windows for the project alone (the window holds the lead AND its workers now, not just the lead) and deliberately never names panes. A worker's identity comes from `claude --name <agent name>`, which Claude writes to the terminal title, which tmux records as `pane_title`. Under `placement: split` every worker is a pane in one window, so with `pane-border-status off` (the default) a whole crew reads as one window called by the project's name alone, with no way to tell which pane is which.

Do not try to solve this with `select-pane -T`. hive did consider it and rejected it: the application writes its own title afterwards and wins. Measured again on 2026-08-03, `select-pane -T "hive - worker-1"` held until the pane's Claude session wrote its own OSC 0 title, and then read whatever Claude set.

## Suggested

None of this is required. It is what makes a multi-project tmux workflow bearable.

```tmux
set -g detach-on-destroy off
set -g set-titles on
set -g set-titles-string "#W - #T"
```

**`detach-on-destroy off`.** With several projects sharing the one session, exiting a project's lead just closes ITS window; the session survives with every other project's window untouched, and `off` costs nothing there. It still matters for the case that closes the LAST window - a single-project store, or working down to one - which destroys the session with it. The default then detaches you to a bare shell. With `off` your client moves to the most recently used other session instead (a view session, if one happens to be open, otherwise back out of tmux same as before), so losing the last window drops you somewhere sensible rather than out of tmux with no warning.

**`set-titles on`.** tmux never sets the outer terminal's title unless you ask. In a plain attach your terminal tab keeps whatever title it had before you attached.

### Telling you a background project needs you

This is the one that needs both halves, and neither works alone.

```tmux
set -g monitor-bell on
setw -g monitor-activity off
set -g status-right-length 100
if-shell '! tmux show -gv status-right | grep -q window_bell_flag' \
  'set -ga status-right " #{W:#{?window_bell_flag,!#{window_name} ,}}"'
```

Set Claude Code's `preferredNotifChannel` to `iterm2_with_bell`. The OSC 9 half cannot escape a detached session, and the bell is the only part tmux can record.

tmux does record it, per WINDOW: `list-windows` reports `window_bell_flag=1` for whichever window a bell fired in, current or not. It simply never tells a client looking at a different window, so the status line has to ask. The `#{W:...}` loop above renders every window in the shared session that is flagged, by name - which, since every hive window is named for its project, is the project that needs you.

**This is a per-window mechanism now, not per-session, and that is a real change from before.** Every project used to live in its own session, so a session-level `#{S:...}` loop could tell you WHICH project rang by naming the session. Under one shared session (see "One session, one window per project" below) every project's window lives in the identical session, so a session-level indicator can only ever say "something in hive-main needs you" - it has lost the ability to say which. Measured directly, replacing `#{S:...}`/`session_alerts` with `#{W:...}`/`window_bell_flag` above restores exactly that: it names the window, and the window is the project.

Three things went wrong building this, all worth not rediscovering:

- **`status-right-length` defaults to 40.** A theme's own right side can spend most of that, and the indicator is then computed correctly and truncated off the edge. `#{E:status-right}` expanded to `... 04-Aug-26 !hive-main` while the screen showed nothing.
- **`set -ga` is not idempotent.** Every `source-file` appends again, so a reload binding grows the value each time you use it. Hence the `if-shell` guard.
- **`monitor-activity` fires on any output**, so every window doing work flags itself and the indicator becomes noise. Bell only.

## Other considerations

Observations from running hive in raw tmux across two machines. None of this is hive's business; it is here so it is written down somewhere.

**Order matters if you use a theme.** A theme plugin's `run` line sets `status-left`, `status-right` and their lengths when it executes. Anything above that line is overwritten. Keep hive-related settings below it.

**One session, one window per project.** `sessionName()` is `hive-main` (tagged for a non-default store), shared by every project in this store; each project gets its own WINDOW inside it, stamped with `@hive-project-id`. Workers, wake delivery, `hive status` and `hive doctor` all resolve through that stamp, never through a session name, so two projects can share a window name with no correctness cost - only `path` is unique in hive's own project table. You never create the session yourself. `prefix c` gives you a shell to type `hive` into; typed from inside tmux, `hive` selects your project's window in the one shared session rather than creating anything.

**Every terminal gets its own view onto the same windows.** `hive <path>` from outside tmux attaches through its own VIEW SESSION rather than putting a client on the shared base session at all: two clients on one session share a current window and fight over it (measured 2026-08-04), and hive used to decide between the two by reading whether the base already had a client - a read that two terminals starting at the same instant both answered "no" to, landing both of them on the base and recreating the fight. There is no such read now. The first terminal and the fifth take the same path, so the everyday single-terminal case runs the same machinery the side-by-side case does, and one view session per attached terminal is normal rather than exceptional. A view session borrows the base session's windows with its own, independent current-window pointer, and owns no panes of its own. It is destroyed the instant its client detaches (`destroy-unattached`, set in the same tmux invocation that creates it) - close the terminal, or detach, and it is gone; the base session and every pane in it are untouched. `hive doctor` reports, but never kills, a clientless view session that somehow outlived its own client - `destroy-unattached` should already have made that unreachable, so the report is belt-and-braces, not a routine occurrence.

**`prefix c` leaves a shell window behind in whichever project's window you launched from.** A `display-popup` launcher avoids that, because the popup is not a window in any session and closes when its command exits:

```tmux
bind P command-prompt -p "project:" -I "~/Code/" "display-popup -E 'hive %%'"
```

**This is simply correct now, with no caveat.** Under the old per-project-session design this launcher armed the exact bug that started the topology redesign: `$TMUX` is set inside a popup, so `hive` took a `switch-client` path that moved your one client off whatever session it had been on, leaving that session clientless mid-spawn - the origin session's next `agent_spawn` then found no client and popped open an unwanted native window. Under one shared session there is no other session to switch to: `hive` from inside tmux (popup or otherwise) now runs `select-window` in the session you are already attached to, which only moves this client's own current window. Nothing to orphan, measured directly against the current code, not merely reasoned about.

**Windows are picked with `prefix w`, tmux's own default, since windows are projects now.** `choose-tree -Zw` already lists every hive-owned window by its plain project name - no `<project> - lead` suffix to strip, since nothing looks a window up by name anymore and the suffix is gone. No custom binding needed for this.

**Never start the outer tmux with `-L` or a custom `TMUX_TMPDIR`.** hive refuses a private socket paired with the default store, on purpose, and the error is long. Plain `tmux` is correct. The reasoning is in `.claude/rules/tmux-and-panes.md`. A private socket also turns auto-attach off entirely, whatever `hive setup --auto-attach` says and whichever store you are on, and that refusal is silent: the window hive would open gets a fresh shell that inherits nothing from hive, so hive cannot make it land on your private server (todo 355, same rule file).

**Quote a leading `=` in a tmux target.** `tmux kill-session -t =hive-main` breaks in zsh, which expands a leading `=` as a command path. Write `-t '=hive-main'`. The same applies to a view session's own name, `hive-<tag>view-<pid>` - `hive doctor`'s stray-view-session report already prints it quoted.

## What this does not cover

hive never writes to your `~/.tmux.conf` and never sets a global tmux option on your behalf. It only configures windows carrying its own `@hive-owned` marker. `hive setup --attach raw` prints the remaining global recommendation.

hive's own test suite runs against a private tmux socket but still reads your `~/.tmux.conf`, because tmux reads its config when the server starts. A test whose assertions depend on pane geometry states that dependency itself; see `test/layout.test.mjs`.
