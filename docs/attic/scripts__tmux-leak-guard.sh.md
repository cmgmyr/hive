# Attic: scripts/tmux-leak-guard.sh

Comments removed from `scripts/tmux-leak-guard.sh` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
# Todo 294. A BACKSTOP, not the primary check - see below for why - that
# fails if a tmux process carrying an isolated test's scratch project path
# is still alive.
#
# THE PRIMARY CHECK IS isolateTmux()'s OWN exit handler (test/helpers.mjs),
# which asks each file's private socket directly (`tmux -S <that file's own
# socket> list-sessions`) what it left running, before killing it. That
# check names the FILE and the SESSION; this script can only ever name a
# pid discovered after the fact by a separate process, on a separate run.
#
# WHY THIS STILL EXISTS, GIVEN THAT. This has a real, known coverage gap:
# it can only see a leak that happens to carry a scratch path in its argv
# (via `-c <scratch project dir>`), and several real call sites never pass
# one at all - test/probe.test.mjs, test/lead-data-dir.test.mjs (no -c),
# test/attach-mode.test.mjs's ensureSession() calls (-c is process.cwd(),
# the checkout itself), test/helpers.mjs's own createLiveAndDialogPanes. A
# leak from any of those prints green here. It stays as a second, coarser
# net specifically because it is EXTERNAL to the process that could leak -
# a wedged or killed test file cannot suppress it the way a bug in its own
# exit handler could suppress the primary check.
#
# A THIRD CHECK EXISTS NOW (todo 375 item 3), AND HALF THE LIST ABOVE IS ITS
# BUSINESS RATHER THAN THIS SCRIPT'S. `scripts/tmux-leaks.mjs`, run by `npm
# test` itself, asks every SOCKET the run created whether a server is still on
# it - no argv involved - and it runs locally as well as in CI.
#
# SAY EXACTLY WHICH OF THE FOUR IT COVERS, because an earlier version of this
# paragraph claimed all of them and that was false (counselors round 2, F6:
# a comment is an assertion here, and this one was wrong in the reassuring
# direction). test/attach-mode.test.mjs's ensureSession() calls and
# test/helpers.mjs's createLiveAndDialogPanes run on the FILE'S OWN socket,
# which isolateTmux() registers, so the socket check has always seen those
# two. test/probe.test.mjs and test/lead-data-dir.test.mjs start servers on a
# SECOND, bespoke TMUX_TMPDIR, which isolateTmux knows nothing about - it
# appends only its own socket - so those were genuinely uncovered by both
# checks at once. They register their sockets explicitly now
# (recordScratchTmuxSocket, test/helpers.mjs), as do the two further
# secondary-server sites the audit turned up that this script never listed:
# test/tmux-socket.test.mjs's second-server restart and
# test/isolated-hive.test.mjs's `hive up` instance.
#
# So the coverage rule is: the socket check sees every socket that REGISTERS
# ITSELF, automatically for a file's own and by that call for a bespoke one.
# A future test that starts a server on a third socket and does not call it is
# invisible to both nets.
#
# THIS SCRIPT STAYS for two reasons that survive all of the above: it is
# external to the process that could leak, and it can see a server whose
# socket FILE is already gone, which a socket probe never can. That gap is
# recorded in scripts/tmux-leaks.mjs's own header too - neither check claims
# to have closed it.
#
# Run this AFTER `npm test` completes (any invocation - CI or local), never
# during: cleanup() and isolateTmux()'s own exit-time kill-server both need
# every test file's process to have actually exited first.
#
# WHAT COUNTS AS A LEAK, WITHIN ITS COVERAGE. A process created under an
# isolated TMUX_TMPDIR that DOES carry a scratch project path in its
# command line - see test/helpers.mjs's scratchDirs(). Selecting by that
# path, not by session name, is load-bearing: the LIVE tmux server backing
# a real hive lead can carry a session name that reads exactly like stale
# test garbage (a pre-topology "hive-1", see CLAUDE.md's Invariants
# section), so a guard that keys off the name instead of the path can flag
# the wrong process entirely. This script never does that.
#
# MUST ALSO BE TMUX. The path alone matches too much: any process whose
# command line merely MENTIONS the string hive-test- - a shell running the
# very command that greps for it, this script's own invocation, a developer
# debugging this exact leak with `ps | grep hive-test-` in their history -
# reads as a leak. Measured concretely: a shell whose command text happened
# to contain the string was flagged, while a genuinely leaked tmux process
# was not. Filtered on the COMMAND NAME (ps's own comm field, the kernel's
# resolved-executable basename, not argv - immune to path length and not
# spoofable by an arbitrary argument), never on the session name; the two
# are different axes and only the second one is forbidden - tmux-the-binary
# is not a session name; -o comm on a process invoked as bare "tmux" (how
# both src/tmux.ts and this suite's own helpers always invoke it) reports
# exactly "tmux", not a path, so this needs no prefix or suffix matching.
#
# THE LIVE SERVER IS RESOLVED EXPLICITLY AND EXCLUDED, not inferred. If this
# process happens to be running inside a real hive tmux pane (a lead or
# worker's own session), `tmux display-message` answers that server's own
# pid, which this script excludes by pid rather than by guessing from the
# command line. Outside any tmux pane (a fresh CI runner, most cases) the
# command fails and there is nothing to exclude, which is also correct.
```

## line 91

```
# -ww: unlimited output width. Not observed to matter here (measured against
# this machine's own ps with and without it, no truncation either way at a
# line over 11000 characters), added as free insurance against a narrower
# default on some other platform rather than a fix for something reproduced.
```
