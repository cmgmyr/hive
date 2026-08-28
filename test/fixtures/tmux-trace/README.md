# tmux server trace fixtures

Two real `tmux -vv` server logs, captured on tmux 3.7c (macOS) and cut down, for
`test/tmux-trace.test.mjs` to parse. They are what `HIVE_TMUX_TRACE=<dir>` makes
`isolateTmux()` produce, reduced by `scripts/tmux-trace.mjs`.

`tmux-server-40413.log` is a bare `new-session`, a bare `new-window` 1s later,
and a `kill-session` 7ms after that window. `tmux-server-50001.log` is a
`new-session` carrying a command, killed 315ms later. Between them the two files
cover both halves of the wedge conjunction: bare versus commanded, and young
versus old at destruction.

The other two are the kill-pane cases, where tmux logs no per-pane destroy line
at all. `tmux-server-60002.log` kills a pane the log CAN identify, because
`window_add_pane: @0 after %1` names it, so its age dates from the kill-pane at
421ms rather than from the window destroy 858ms later. `tmux-server-60003.log`
kills `%1`, the first pane of a window, whose id is never named at its create -
so the reducer cannot tell which of that window's two panes died and must leave
both undated. The single-pane window in the same capture stays dated, which is
what stops that doubt spreading across the whole log.

Three things were done to the captures and each one matters:

- **Every `IDENTIFY_ENVIRON` and `spawn_pane: environment` line was cut.** A raw
  tmux log dumps the full environment of every process the server spawns, which
  on a developer's machine means real API keys. Never commit a raw one, and keep
  `--prune` in mind when running the instrument for real.
- **Scratch paths were rewritten** to `/scratch/project-a` through `/scratch/project-d`,
  so no fixture assertion can depend on the capturing machine's temp directory.
- **Config-time `bind-key` lines were kept, deliberately.** Several of them
  contain `kill-window` and `kill-pane` inside their bound command. They are the
  negative control for the reducer's destroy-verb match, which anchors at the
  start of the command: drop them and a regex that stopped anchoring would still
  look green.
