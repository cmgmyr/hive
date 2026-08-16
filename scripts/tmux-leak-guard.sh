#!/bin/bash

set -euo pipefail

live_pid="$(tmux display-message -p '#{pid}' 2>/dev/null || true)"

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
