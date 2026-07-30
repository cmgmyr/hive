# Pane fixtures

Captured `tmux capture-pane -p -S -50` output from a real `claude` process,
version 2.1.220, on 2026-07-29. Each file is the exact bytes read back off a
live pane; none of these were typed by hand. See todo 68 / issue #27 / #30.

- `ready-idle.txt` — idle at the input box, no dialog. Neither `╰` nor
  "for shortcuts" appears anywhere in it, which is #30 itself: the marker
  `waitForPaneInput` polls for does not exist in this version's chrome.
- `folder-trust-dialog.txt` — the folder-trust prompt shown on first launch
  in an unrecognised directory.
- `model-picker-dialog.txt` — the `/model` picker.
- `busy-mid-turn.txt` — mid-turn, streaming a response, no dialog. This is
  the case that must read as "not a dialog": busy is fine, modal is not.

`folder-trust-dialog.txt` and `model-picker-dialog.txt` both carry the
"Esc to cancel" footer; `ready-idle.txt` and `busy-mid-turn.txt` do not.
