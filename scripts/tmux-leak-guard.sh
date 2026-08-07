#!/bin/bash
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
set -euo pipefail

live_pid="$(tmux display-message -p '#{pid}' 2>/dev/null || true)"

# -ww: unlimited output width. Not observed to matter here (measured against
# this machine's own ps with and without it, no truncation either way at a
# line over 11000 characters), added as free insurance against a narrower
# default on some other platform rather than a fix for something reproduced.
leaked="$(ps -ww -eo pid,ppid,stat,etime,comm,command | awk '$5 == "tmux" && /hive-test-/')"
if [ -n "$live_pid" ]; then
  leaked="$(printf '%s\n' "$leaked" | awk -v p="$live_pid" '$1 != p')"
fi
leaked="$(printf '%s\n' "$leaked" | sed '/^[[:space:]]*$/d')"

if [ -n "$leaked" ]; then
  echo "::error::the suite left hung tmux processes behind (todo 294):"
  printf '%s\n' "$leaked"
  echo "::error::each one carries its own now-deleted hive-test-* scratch path in -c;"
  echo "::error::isolateTmux()'s exit-time kill-server (test/helpers.mjs) should have reaped it."
  exit 1
fi

echo "no leaked hive-test tmux processes"
