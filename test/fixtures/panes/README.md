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

## Todo 392: the ordinary tool-permission prompt

Three genuine captures off a real claude 2.1.231 session, 2026-08-13, for the
detector gap todo 392 measured live: `INPUT_BOX_PRESENT` (src/tmux.ts) counts
a `╰` as proof claude's input box is on screen, but a tool-permission prompt
renders a bordered PREVIEW of the pending change whose bottom border is `╰`
too, so the dialog's own chrome was read as "no dialog". Captured against an
isolated private tmux server (`TMUX_TMPDIR` set to a scratch directory, `TMUX`
unset — no `-L`, matching `isolateTmux()`'s own technique), a scratch cwd, and
`HIVE_DATA_DIR` pointed at a scratch directory with every other `HIVE_*` var
unset, so the session could not reach the real store; torn down after. `-x 220
-y 50`, same pane size as every other fixture here, and the same `-S -50`
capture depth.

- `tool-permission-prompt.txt` — the whole bug. `claude --permission-mode
  default`, then a task asking for `NotebookEdit` against a scratch
  `.ipynb`: outside the default allow list, so it reliably stops on a real
  prompt rather than auto-approving. Reads "Do you want to insert this cell
  into scratch.ipynb?" with numbered options and "Esc to cancel · Tab to
  amend" below a `╭…╰` preview box of the pending cell. Carries `╰` twice —
  once from the startup banner still visible above (this is the pane's
  first turn, so nothing has scrolled it away yet) and once from the
  preview box's own closing border — and either one alone is enough to
  trip the old regex.
- `manual-mode-idle.txt` — the second, separate gap: manual (`default`)
  permission mode's footer reads "⏸ manual mode on · ← for agents", with
  no "(shift+tab to cycle)" — the only mode that drops it, which is why a
  manual-mode worker used to carry no `INPUT_BOX_PRESENT` marker of its own
  at all. Captured from the SAME session as the prompt above, after a
  warm-up turn (asked to list numbers 1 to 150, no tools) that pushed the
  startup banner well down the pane's own scrollback.

  Todo 392 round 2 review corrected the reason given for that warm-up.
  The original version justified it by treating `capture-pane -S -18`'s
  RAW output as the detector's own capture window (measured at 68 rows
  against an 80-line scroll on a real tmux 3.7b — visible-pane-height plus
  18, not "the last 18 rows"). That measurement is real, but it describes
  `capture-pane -S -N` itself, not what hive's own `capturePane()`
  (`src/tmux.ts`) returns: `capturePane` strips TRAILING blank rows from
  that raw output first, then takes the LAST N of what remains. Verified
  directly against the ORIGINAL, pre-warm-up capture (kept in this lane's
  own working notes, not shipped): replayed into a real pane and read back
  through the real `paneAwaitingChoice`/`waitForPaneInput`, the startup
  banner's `╰` never reached either function even without the warm-up —
  the footer was already the pane's own LAST printed line with nothing
  blank after it to strip, so the trim-then-slice window was rows 33-50
  either way, never rows 2-13 where the banner sits. The fixture itself is
  unaffected by this correction — a genuinely idle manual-mode pane
  mid-lane, which is what a real worker looks like by the time anything
  checks it, is still the more representative capture — only the STATED
  reason for needing the warm-up was wrong. `scripts/restart-lead.sh`'s own
  dialog check is a different story: it reads `capture-pane -S -N`
  directly, with none of `capturePane`'s trimming, so its effective window
  really is the wider one this paragraph used to (wrongly) attribute to
  hive itself — see that script's own comment on `awaiting_choice` for the
  fix. Zero hits for `╰`, "for shortcuts", or "shift+tab to cycle" in this
  fixture, matching what todo 392's own live probe measured on a real idle
  manual-mode worker.
- `plan-approval-dialog.txt` — the third gap: the plan-approval dialog
  ("Claude has written up a plan and is ready to execute. Would you like to
  proceed?") renders no "Esc to cancel" anywhere on it, so `CHOICE_DIALOG`
  misses it outright before `INPUT_BOX_PRESENT` ever enters into it.
  `claude --permission-mode plan`, then an ordinary task, captured once the
  plan was written and the approval prompt rendered. Zero hits for `Esc to
  cancel`, `╰`, "for shortcuts", and "shift+tab to cycle" alike. Round 2
  review (M2) uses this fixture's OWN "ctrl+g to edit in Zed" line (the
  dialog's chrome, an editor-shortcut hint, not its prose) as `CHOICE_DIALOG`'s
  alternative in place of "Would you like to proceed" — measured stable
  across two different `$EDITOR` configurations (only the editor NAME
  varies: "Zed" here, "Vim" when `$EDITOR`/`$VISUAL` are unset and claude
  falls back to a default), and far less plausible in ordinary shell output
  than the dialog's own prose, which reads almost verbatim as an installer
  confirmation.
- `manual-mode-pending.txt` — round 2 review (F9): manual mode's PENDING
  case was never measured, only its idle one (`manual-mode-idle.txt`
  above), and getting it wrong is the dangerous direction — if the mode
  footer hid or changed while a human was mid-sentence, a wake would paste
  onto their half-typed line and submit it. `claude --permission-mode
  default`, then real unsubmitted text via `send-keys -l` (no Enter,
  `agent_send`'s own mechanism) once idle. The footer reads "manual mode
  on" during composition too, dropping only its own trailing "· ← for
  agents" hint — nothing depends on that half. Read back through the real
  `inputBoxState`: `{state: "pending", text: "REAL UNSUBMITTED PENDING TEXT
  FOR F9"}`, `holdsHumanInput` true, exactly the shape every other mode's
  own pending fixture already has.
- `bypass-mode-idle-narrow.txt` — M1 completion, flagged after round 2
  landed. `mode on` (round 2's fix for the narrow-pane total miss) covers
  auto/manual/plan, but `bypassPermissions` mode's footer reads "bypass
  permissions on (shift+tab to cycle) ...", not "\<word\> mode on" — the
  identical total miss left open for the one mode this project's own
  maintainer runs by default. `claude --permission-mode bypassPermissions`,
  captured at **40 columns**, not this file's usual 220 — deliberately, so
  the capture actually isolates "permissions on" as the sole surviving
  `INPUT_BOX_PRESENT` alternative (a 220-column capture would also carry
  "(shift+tab to cycle)" intact and prove nothing about the new
  alternative). Measured at 220/80/60/40/30/25 columns first: "bypass
  permissions on" survives everywhere "(shift+tab to cycle)" does not,
  intact through 30 columns and gone by 25 (cut down to "bypass" alone).
  "permissions on" was added rather than the fuller "bypass permissions
  on" — measured to break at the identical width, so the shorter fragment
  costs nothing. Zero hits for "shift+tab to cycle", "for shortcuts", or
  "mode on"; one hit for "permissions on". Carries one `╰`, from the
  startup banner (this is the pane's first turn, no warm-up done) — same
  as `tool-permission-prompt.txt`, and confirmed harmless the same way
  `manual-mode-idle.txt`'s own entry above explains: the banner sits well
  above `capturePane()`'s real trim-then-slice window, which starts from
  this pane's own last line (the footer, with nothing blank after it).
