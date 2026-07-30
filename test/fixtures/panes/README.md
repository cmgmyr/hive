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

`folder-trust-dialog.txt` line 5 carries a captured absolute path with the
local username and a session uuid. That has been flagged twice in review as
non-blocking, and will likely be flagged again by a third reader: the
decision was to KEEP it. There is no secret in it, and byte-for-byte fidelity
is the only reason a captured fixture is trustworthy in the first place — see
"none of these were typed by hand" above. If it is ever removed, the way is
RE-CAPTURING from a short path, never hand-editing the bytes of the file
that is here now.

## Ghost placeholder text (issue #34)

- `ghost-suggestion.txt`, `queued-hint.txt`, `real-input.txt` — genuine
  full-screen `capture-pane -pe -S -50` captures off a live claude 2.1.220
  session, claude's own dim suggestion, the "press up to edit queued
  messages" hint, and a real unsubmitted-input control, respectively.
  Captured 2026-07-30 in an isolated private tmux server (`-L
  ghostcapture34`) against a scratch cwd, `HIVE_DATA_DIR`/`HIVE_AGENT_ID`
  unset so the session could not reach the real store or any other lane's
  pane; torn down after. The ghost line was elicited the way the original
  #34 spike describes: a context-heavy turn (reading real source files,
  then an imperative follow-up question), polled for tens of seconds after
  the turn ended. The real-input control is `agent_send`'s own mechanism
  (`send-keys -l`, no Enter) run by hand against the scratch pane.
  These replaced an EARLIER version of this file, kept for one PR (#37):
  the first version was reconstructed programmatically from issue #34's own
  measured bytes rather than freshly captured, which counselors review
  flagged as suspect (B6) -- correctly, since `real-input.txt` in
  particular turned out to be indistinguishable from "ghost-suggestion.txt
  with the wrapper deleted" rather than independent evidence. If the
  discriminator ever needs re-verifying again, replace all three the same
  way: a private tmux server, a scratch cwd, real `claude`, never
  hand-edited or reconstructed from prose.
- `dim-then-normal.txt` — SYNTHETIC, unlike every other file on this page:
  a variant of `ready-idle.txt` whose input-box row is
  `ESC[39m❯<NBSP>ESC[2mESC[22mREAL INPUT AFTER DIM RESET` (faint set, then
  immediately cancelled, before any visible character). This is not
  something claude has been observed to render; it is a hand-authored
  torture case for the SGR-fold logic itself (`leadingRunIsFaint` in
  src/tmux.ts), pinning a bug counselors review caught on PR #37 (B1): the
  first version asked "does '2' appear anywhere in the leading run" rather
  than folding the run in order, so a later `ESC[22m` that cancels a `ESC[2m`
  was ignored and real typed text misread as a ghost suggestion. Still
  replayed through a REAL tmux capture-pane -e (same `cat` + capture
  technique as every other fixture here), so the assertion is against
  tmux's actual serialization of these bytes, not a hand-simulated parse.
- `dialog-with-stale-input-line.txt` — also SYNTHETIC: `folder-trust-dialog.txt`
  with a genuine glyph+NBSP row (`❯<NBSP>STALE GHOST FROM SCROLLBACK`, no
  SGR) spliced into its otherwise-unmodified blank scrollback, simulating a
  ghost/real input-box row left behind in a pane's history (e.g. by a wake
  body embedding another pane's tail) before a real dialog appeared below
  it. Pins B3 from the same PR #37 review: `inputBoxState` used to trust the
  LAST glyph+NBSP row anywhere in its capture window with no check that an
  input box is actually showing, which is the CHOICE_DIALOG/D4 wedge
  repeating against the new detector. Every other marker in this file is
  untouched, so it still reads as a genuine dialog (CHOICE_DIALOG present,
  INPUT_BOX_PRESENT absent) exactly like the original.
- `drifted-prompt-glyph.txt` — also SYNTHETIC: `ready-idle.txt` with its
  input-box row changed from `❯<NBSP>` to a plain `> ` (no glyph at all).
  INPUT_BOX_PRESENT is still true (every other marker is untouched), so this
  simulates claude redesigning the prompt glyph the same way issue #30 was a
  redesign of the readiness markers. Pins S1 from the PR #37 review:
  `inputBoxState` must report `state: "unknown"`, not null, when the box is
  confirmed present but no recognisable prompt row can be found -- null is
  reserved for "there is legitimately nothing to report", and collapsing
  the two made a chrome drift indistinguishable from a confirmed-empty box.
- `multiline-pending.txt`, `multiline-empty-first-line.txt` — genuine
  captures, same technique and same session as the ghost-suggestion.txt
  batch (a second isolated run, 2026-07-30): real unsubmitted multi-line
  input, sent with `set-buffer`/`paste-buffer` and no Enter (the same
  mechanism `sendText` uses for multi-line text), confirming claude grows
  the box DOWNWARD with a plain-indented continuation row and no fresh `❯`,
  then redraws its closing border below both rows. `multiline-pending.txt`
  is "FIRST LINE OF PENDING\nSECOND LINE OF PENDING"; `multiline-empty-
  first-line.txt` is "\nSECOND LINE ONLY, FIRST LINE EMPTY", pressing Enter
  once before typing more. Pins S2 from the PR #37 review, and the second
  file is the dangerous direction specifically: the prompt row itself is
  textless in that capture, so a detector that only ever looked at the
  prompt row reports "empty" while real pending text sits one row below.
  `classifyInputBox` in src/tmux.ts scans forward from the prompt row for
  continuation content, stopping at the box's own closing border or a
  genuinely blank row.
