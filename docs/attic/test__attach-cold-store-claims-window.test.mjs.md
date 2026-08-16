# Attic: test/attach-cold-store-claims-window.test.mjs

Comments removed from `test/attach-cold-store-claims-window.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Pad 79, T5(b). `hive attach` on a cold store calls ensureSession and used
// to never claim the window it just created: no @hive-project-id stamp, no
// rename. That window was invisible to findProjectWindow forever after, and
// a later `hive lead` for the same project - the only other place that ever
// claims a fresh session's initial window - always finds started.created ===
// false by then (the session already exists) and falls to its OWN
// read-then-create, stamping a SECOND window and leaving the attach's window
// an orphan. A state bug, not a crash: nothing throws, the store and tmux
// just accumulate an unstamped window per cold `hive attach`.
```

## line 88

```
// PR gate finding on the first version of the fix above. That version only
// handled a TRULY cold store (ensureSession creates the session, so
// started.created is true and its first window is the one to claim). It
// missed the OTHER way cmdAttach can reach a project with no window: the
// session already exists, carrying only OTHER projects' windows, because
// their `hive lead` ran first and this one never has. Gated on
// started.created alone, that case fell straight through: in tmux,
// resolveInTmuxTarget got `window: undefined`, its `!windowId` returned
// null, and attach() did nothing at all - no tmux command, no output, exit
// 0. Outside tmux, resolveAttachTarget's conditional select-window spread
// just dropped, landing the human on a view showing whatever base's CURRENT
// window happened to be - plausibly another project's, the exact
// pop-into-a-stranger's-tab failure this whole design exists to prevent.
```

## line 120

```
// Warms the session with a DIFFERENT project's lead, so by the time
// this describe's own cases attach, the session exists and already
// carries a window - just not one stamped for the project under test.
```

## line 176

```
// Fakes a pane's TMUX the same way test/attach-caller-session.test.mjs
// does: a real view session grouped with base, with the caller's TMUX
// env pointed at it, so a genuine tmux command's effect (the view's
// current window moving) is observable with no real client attached.
```
