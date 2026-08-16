# Attic: test/auto-attach-scope.test.mjs

Comments removed from `test/auto-attach-scope.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// FIRST, before this file's own explanation: isolation has to precede anything
// that could reach a tmux server, and test/suite-isolation.test.mjs enforces
// that by reading this source top to bottom.
```

## line 13

```
// WHAT THIS FILE EXISTS FOR. ensureAttached's whole job is deciding whether to
// open a native terminal window, and the two live modes differ ONLY in which
// clients they count. The first version of this feature tested that decision
// as a pure function taking (sessionHasClient, serverHasClient) while the
// caller passed the SAME value for both, so the pure function's interesting
// case could not occur in production. Reverting "auto" to the per-session
// probe - the regression the feature exists to prevent - left all 1022 tests
// passing, measured before this file was written.
//
// So this asserts against a RECORD OF WHAT HAPPENED: a fake tmux on PATH logs
// every probe and answers a fixture, and a fake osascript logs the fact that
// hive tried to open a window. Nothing here inspects source text or re-checks
// a helper's arithmetic against itself.
//
// The fakes are how this stays deterministic. Counting real clients means
// attaching real ones, which needs a pty per client and makes a unit-level
// decision depend on terminal plumbing. Both the tmux wrapper and the
// AppleScript call reach their binaries through PATH, so replacing the
// binaries is enough to drive every branch.
```

## line 35

```
// A stray override from the ambient shell would silently pin every case to one
// mode: the maintainer's own tmux server exports HIVE_AUTO_ATTACH=0 today.
```

## line 49

```
// `list-clients -t =X` answers for one session; bare `list-clients` answers for
// the whole server. Anything else exits silently, so an unexpected tmux call
// shows up in the log rather than failing in a way that reads as a real bug.
```

## line 94

```
// TODO 355. WHICH SOCKET THIS PROCESS IS ON is a third dimension of every case
// below, and it used to be an accident: isolateTmux() above sets a private
// TMUX_TMPDIR in THIS process's env, so before todo 355 every case here ran on
// a private socket - the exact configuration whose auto-attach leaks a session,
// a client and a native window onto the developer's own tmux server. The two
// cases asserting a window DOES open were therefore describing the leak while
// claiming to describe the ordinary case.
//
// So the socket is now set per case, and "default" is what the ordinary case
// really has: an MCP server Claude Code started carries no tmux env at all, and
// a lead's or worker's own pane is on the default socket.
//
// SET TMUX RATHER THAN CLEARING TMUX_TMPDIR, which is not a style choice:
// dead-ends/2026-07-29-tmux-tmpdir-as-the-socket-signal.md records that TMUX
// overrides TMUX_TMPDIR completely and that a test which clears rather than
// sets exercises a configuration no real hive session has;
// test/server-store-mismatch.test.mjs pins the predicate itself with this same
// "<socket>,<pid>,<window>" shape.
//
// FOUR ARMS, NOT TWO, AND THE REASON IS A FALSE GREEN THIS FILE SHIPPED FOR ONE
// COMMIT. The first version of this had exactly two: TMUX set to the default
// socket, or TMUX deleted and private only through isolateTmux's ambient
// TMUX_TMPDIR. Across the whole file "TMUX is set" and "the socket is default"
// were then perfectly correlated, so the fixture could not tell hive's actual
// socket predicate from a guard keyed on TMUX's mere PRESENCE. Measured, not
// argued: `if (!process.env.TMUX) return;` passed all seven cases while leaving
// the leak open in its main production shape AND refusing every legitimate
// auto-attach. All three counselors seats found it independently.
// So the two private arms differ in WHICH INPUT makes them private, and the
// fourth arm is the ordinary case with no tmux environment at all.
```

## line 125

```
// Full isolation - a scratch store plus a private TMUX_TMPDIR, TMUX unset. This
// is the configuration todo 355 was reported against, and it is what every
// isolateTmux() file already runs in.
```

## line 129

```
// `tmux -L hivespike`: TMUX names a private socket and TMUX_TMPDIR is not set at
// all, which is what the dead-end above measured inside a real -L pane. Derived
// from defaultTmuxSocketPath rather than hand-built, so it differs from the
// default socket in the SERVER NAME only and cannot drift from hive's own
// canonicalisation (dead-ends/2026-08-11-one-sided-rehearsal-hand-built-socket.md
// is the same repo's record of a hand-built socket path silently not matching).
```

## line 139

```
// The ordinary case, and the one the guard's TOO-BROAD failure mode kills: an
// MCP server Claude Code starts has neither variable, so the socket resolves to
// the default one and auto-attach must still fire. Nothing pinned this before,
// which is exactly how a guard that refuses everything ships green.
// It costs the belt-and-braces the private TMUX_TMPDIR otherwise gives this
// file, and that is contained rather than ignored: every tmux and osascript
// call here resolves through PATH to a FAKE binary (the fixtures above), and
// `which tmux` returns the fake, so no case in this file can reach a real tmux
// server whatever its environment says. Do not add a case that runs a real tmux
// by absolute path.
```

## line 151

```
// A client line's contents never matter; tmux's own emptiness check is what
// hive reads. "" means nobody attached.
```

## line 173

```
// withEnv restores the previous value after every case, so one case's socket
// can never pin a later one - the same discipline attach-mode.test.mjs applies
// to HIVE_ATTACH_MODE.
```

## line 185

```
// ensureAttached is a no-op off darwin by construction, so the cases below
// would pass everywhere for the wrong reason. These four are covered by
// the macOS leg of the CI matrix only (ci.yml) - Linux runs two of the
// three legs and always skips them - so a skip off darwin is honest, a
// silent pass is not. THIS IS THE ONLY COVERAGE of the `auto` predicate,
// the same predicate whose false green was the headline lesson of
// .claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md,
// and it now runs on exactly one of three CI legs. If that macOS leg is
// ever dropped (it bills 10x on a private repo; see ci.yml's own comment
// on the OS split), `auto` loses all coverage and nothing goes red -
// check for a replacement before cutting it.
```

## line 219

```
// The negative control for the case above, and the reason it means anything:
// identical world, different mode, opposite outcome. Without this pair, a
// hard-coded "never attach" would satisfy the first case.
```

## line 229

```
// The predicate probe itself is still exactly one call - decision 1
// (pad 80, issue #117) requires this list stay byte-identical. The
// second entry is freeViewSessionName's has-session check (F1, same
// round), which runs AFTER the predicate has already decided to
// proceed; it names a pid-random view, so it is matched by shape
// rather than pinned as a literal.
```

## line 246

```
// COUNSELORS ROUND 2, F7. quietTmux rethrows a timeout now, and
// attachScripts -> freeViewSessionName -> quietTmux("has-session") sat
// OUTSIDE every try in this function - so this call could throw where
// its neighbours (the client probe, `which tmux`) return quietly.
// agent_spawn and agent_resume both reach ensureAttached AFTER
// committing the pane and the agents row, so the tool would report
// failure over a worker that is running, and the retry then collides
// with the row it just made.
//
// The world is the one that DOES open a window ("on keeps the
// per-session behaviour in that same world" above), so nothing but the
// wedge can explain the outcome here.
```

## line 266

```
// Proof the wedge happened where this case says it did, rather than the
// function returning early for one of its other reasons.
```

## line 286

```
// TODO 355. The leak: an MCP server on a PRIVATE tmux socket still opened a
// native window, and what landed was a stray session plus a control-mode client
// on the DEVELOPER's own tmux server - because attachScripts emits neither -L
// nor -S, so the AppleScript shell's tmux can only ever reach the default
// socket. Reproduced four times against a real desktop before the guard, and
// confirmed with a two-armed live run (todo 355 comment 788).
//
// WHAT MAKES THESE ASSERTIONS MEAN ANYTHING, since a return proves nothing on
// its own - ensureAttached has four of them and three are reachable here:
//   `off`                 - ruled out by the mode. These worlds set auto and
//                           on, and each names the control case below that
//                           opens a window in that same mode.
//   the list-clients probe - ruled out by probes() being EMPTY. That return IS
//                           the probe, so it cannot leave an empty probe log,
//                           and the fake tmux logs every call it receives.
//   `which tmux` failing   - strictly after the probe, so the same empty log
//                           rules it out. Note the fake tmux is genuinely on
//                           PATH here, so the resolution SUCCEEDS in both arms:
//                           this proves the guard sits above a working `which`,
//                           not above a rigged one.
//   platform !== darwin    - skipped off darwin, like every case above.
// Which leaves the socket guard as the only return that can produce this
// record. That is also why the guard's POSITION above the probe is load-bearing
// rather than an optimisation: below it, the leak is still closed and no
// assertion can tell which return fired.
//
// Each refusal case is one variable away from a case above that opens a window:
// same mode, same clients, same fakes, a different SOCKET - and the socket is
// varied through both of its inputs across the two cases, which is what stops
// this pinning TMUX's presence instead of the socket it names.
//
// THE THIRD CASE IS THE OTHER FAILURE MODE AND IT IS NOT AN AFTERTHOUGHT. This
// guard fails silently in BOTH directions: too narrow leaves the leak, too
// broad refuses every legitimate auto-attach with no error at all. The ordinary
// production case - an MCP server Claude Code started, no tmux environment
// whatever - had nothing pinning it, so a guard that refused everything would
// have shipped green.
```

## line 330

```
// Private through TMUX_TMPDIR, TMUX unset: the configuration todo 355 was
// reported against. Pair with "auto still surfaces a worker once nothing
// at all is attached" above, where openedAWindow() is true.
```

## line 344

```
// Private through TMUX, with TMUX_TMPDIR unset - the shape a real
// `tmux -L hivespike` pane produces, and the one that kills a guard keyed
// on TMUX's presence. Pair with "on keeps the per-session behaviour in
// that same world" above, which opens a window on this same mode.
//
// `on` rather than `auto` is deliberate: this is the one case the guard
// genuinely takes away from a human. Inside their own -L server they are
// an attached client on it, so under `auto` this function already returned
// at the probe; only `on`, whose probe reads base alone, ever reached the
// attach from here.
```

## line 365

```
// The too-broad direction. Neither variable set, so the socket resolves to
// the default one and the guard must NOT fire: this is every real
// agent_spawn from an MCP server Claude Code started. It is also the
// second half of the mutation kill - a guard reading TMUX's presence
// refuses here, where the two cases above pass it.
```
