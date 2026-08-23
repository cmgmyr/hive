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

## Todo 399: the footer slot holding a different hint

- `footer-slot-taken.txt` — the only capture in this directory of the
  failure todo 399 names: claude's input box is plainly on screen and NOT
  ONE of `INPUT_BOX_PRESENT`'s four alternatives (`for shortcuts`,
  `shift+tab to cycle`, `mode on`, `permissions on`) appears anywhere in
  it, because the single UI line all four live on was showing "paste again
  to expand" instead. A genuine `capture-pane -p -e -S -54` — the identical
  command `inputBoxState` issues, so the SGR is intact — taken off the
  lead's own pane `%0` on main at 296d41b, 2026-08-14, claude 2.1.232, 105
  columns, `bypassPermissions`. 68 rows, 6261 bytes.

  **THIS STATE IS TRANSIENT AND CANNOT BE RE-TAKEN ON DEMAND.** The same
  pane had its mode footer back about a minute later. That is why no
  fixture here has ever carried it and why the whole class stayed
  theoretical: it comes and goes on its own, so neither `hive doctor` nor
  any after-the-fact investigation has ever seen it. Do not replace this
  file with a reconstruction, and do not delete it on the assumption
  another one can be captured.

  **DOCTORED IN EXACTLY ONE PLACE, SAID HERE BECAUSE A DOCTORED FIXTURE
  THAT DOES NOT SAY SO IS A FALSE RECORD.** Row 68 carries an OSC-8
  hyperlink to `https://claude.ai/code/session_<id>`. The 24-character id
  was replaced with `01SCRUBBEDSCRUBBEDSCRUBB`, the same length, so the
  file is still 6261 bytes and every escape, every column and every other
  byte is the capture's own. Nothing else was touched. The OSC-8 `id=`
  parameter on that same row is a terminal-local link-grouping token, not
  a session identifier, and is kept.

  That scrub is a DIFFERENT judgement from `folder-trust-dialog.txt`'s
  kept path above, not a reversal of it: that one is a local filesystem
  path carrying a username and a Claude Code session uuid, which names
  nothing outside this machine. This one is a URL into a hosted service.

  What it is FOR, and it is used in both directions:
  - the headline case for the box anchor (`inputBoxOnScreen`,
    `src/tmux.ts`) — the box is live, `inputBoxState` must classify it
    rather than return `null`, and `hive doctor` must probe it;
  - the control that `isAwaitingChoiceScreen` is unchanged by the anchor:
    this capture carries zero `Esc to cancel` and zero `ctrl+g to edit
    in`, so it is not a dialog before or after, and the anchor's effect on
    the dialog guard has to be proven on the dialog fixtures instead.

  Two things about its SHAPE are worth knowing before you write a test
  against it, because both differ from every 2.1.220 fixture above:
  - the box's TOP border is not a bare `─` rule. It carries an
    inverse-video title chip (`Hive Overnight Lead 2026-08-13`), so
    `BOX_BORDER`'s `/^─+$/` does not match it. The BOTTOM border (row 64)
    is bare, and the bottom one is the only border `classifyInputBox` and
    the anchor actually scan for.
  - four rows sit below that bottom border, not the usual three: two
    status lines, the taken footer slot, and a trailing row carrying only
    the OSC-8 link. Any "the box is at the bottom of the capture" rule has
    to allow for a status area of more than one line — a `statusLine`
    command is user-configurable and emits as many lines as it likes.

- `scrollback-box-above-dialog.txt` — SYNTHETIC, and the adversarial case
  against the anchor above rather than a capture of anything. It is
  `footer-slot-taken.txt`'s own live box — top border, prompt row, bottom
  border, both status lines and the taken footer, byte for byte — spliced
  into `tool-permission-prompt.txt`'s scrollback ABOVE its genuine dialog,
  which is exactly what a worker that `cat`s a captured pane, greps
  `src/tmux.ts`, or renders another pane's tail produces in its own
  transcript. Nothing else in either file is modified.

  ONE THING WAS CHANGED BEYOND THE SPLICE AND THE FIRST VERSION OF THIS ENTRY
  DID NOT SAY SO (counselors round 1, two seats): the splice added 6 rows and
  the file is still 51 lines, so six TRAILING BLANK rows were dropped from
  `tool-permission-prompt.txt`'s tail. Behaviourally inert - `findInputBox`
  trims trailing blanks and `capturePane` pops them, so no consumer can see
  the difference - but this page is the record, and "nothing else is
  modified" was false against the bytes.

  This is `dialog-with-stale-input-line.txt` one turn of the screw
  tighter. That fixture splices a bare glyph+NBSP row into blank
  scrollback, which is enough to kill a detector that trusts the last
  prompt row anywhere in the window. It is NOT enough to kill one that
  requires the prompt row to be bracketed by its own borders, because it
  has no borders — so a box anchor could pass it while still being wide
  open to the real thing. This fixture carries the complete chrome and
  therefore actually tests the bracketing.

  The live screen is a real tool-permission dialog, so the correct answer
  is box-ABSENT on every consumer: `inputBoxState` `null`,
  `isAwaitingChoiceScreen` true. Getting this wrong in the permissive
  direction is todo 392's `╰` bug rebuilt with a different glyph — a
  dialog's own surroundings proving there is no dialog.

- `footer-slot-taken-pending.txt` — SYNTHETIC, and the case that actually
  destroys a human's work rather than the one that was captured.
  `footer-slot-taken.txt` caught the pane with an EMPTY box showing its own
  "Press up to edit queued messages" hint, so it classifies `ghost` and
  `holdsHumanInput` is correctly false for it — which means the real capture
  alone cannot prove the unsubmitted-text hold was restored, only that the
  box is found again. This is that capture with its prompt row (row 63)
  replaced by `real-input.txt`'s OWN measured prompt-row shape
  (`ESC[39m❯<NBSP>` then plain text, a leading run that sets no faint
  attribute) carrying `REAL UNSUBMITTED TEXT, FOOTER SLOT TAKEN`. Every
  other byte of the capture is untouched, including the taken footer slot
  that makes all four `INPUT_BOX_PRESENT` alternatives absent.

  Read back through the real `inputBoxState` it is `{state: "pending"}` and
  `holdsHumanInput` is true — the wake hold firing on the exact screen where
  it was entirely absent before todo 399. A graft, not an invention: both
  halves are bytes this project captured off a real claude, from two
  different versions, and the join is that one row.

- `tail-echo-no-top-border.txt` — SYNTHETIC and deliberately minimal, the
  torture case for the TOP-border half of the box anchor the way
  `dim-then-normal.txt` is one for the SGR fold. Not a capture of anything.

  It exists because `scrollback-box-above-dialog.txt` cannot reach this
  half. Measured while building it: with a real dialog on screen the
  dialog's own block is 9 to 15 rows tall, so a scrollback echo above it is
  always further from the bottom of the capture than the anchor's tail bound
  allows, and the tail bound alone rejects it — the top-border requirement
  never gets a vote. This file takes the dialog's height out of the
  question: a glyph+NBSP row with a bare rule directly under it, both inside
  the tail bound, and NO border above the glyph row.

  The shape is one `.claude/rules/tmux-and-panes.md` already names as a real
  producer — `watchedTail` embeds a worker's tail into a wake body typed into
  the LEAD's pane, so a prompt row and its closing border can land in the
  lead's own scrollback with nothing above them. Correct answer:
  `inputBoxState` `null` and `isAwaitingChoiceScreen` true. Without the
  top-border requirement it reads `{state: "pending", text: "ECHOED TAIL FROM
  ANOTHER PANE"}`, which holds every wake aimed at that pane forever and
  tells the dialog guard there is no dialog.

## Todo 399, counselors round 1: the two regressions the lane's own fix introduced

Both were found by three independent seats, and both are cases where the
first version of the box anchor was WORSE than the footer regex it replaced.
Neither is hypothetical; both were reproduced against the real predicate on
an isolated tmux server before either fixture was written.

- `dialog-under-two-rules.txt` — SYNTHETIC, minimal, and the more serious of
  the two. A genuine tool-permission-shaped dialog with framed command output
  above it: two bare `─` rules with a line of test output between them, and no
  `❯`+NBSP prompt row anywhere on the screen.

  The first `inputBoxOnScreen` asked only whether `findInputBox` returned
  non-null, and it returns an anchor with `prompt: null` when it finds two
  borders and no prompt row between them. So this screen read
  `awaitingChoice: false` — **a real dialog reading as no dialog**, which is
  todo 392's `╰` bug rebuilt with a different glyph by the lane that was told
  not to rebuild it. Delivery would then paste and press Enter, and the Enter
  takes "1. Yes".

  It is a REGRESSION AGAINST THE RETIRED REGEX, not merely a gap: this screen
  carries no footer string at all, so `INPUT_BOX_PRESENT` classified it
  correctly. Synthetic because the reproduction needs the rules within the
  anchor's tail bound, and framed output is the ordinary producer — `───`
  separators are routine in pytest, rich, and most CLI output, which is also
  why the residual first recorded for non-claude panes ("it must PRINT
  claude's chrome") understated its own population.

  Correct answers: `inputBoxState` `{state: "unknown"}` — borders on screen,
  prompt row not findable, which is exactly the partial drift `hive doctor`
  warns on — and `isAwaitingChoiceScreen` true. That pair is the whole point:
  the classifier and the presence predicate ask different questions of the
  same anchor and are allowed to differ.

- `multiline-blank-interior.txt` — `multiline-pending.txt` with one blank row
  grafted between its two content rows, and nothing else changed. It is the
  shape of an ordinary two-paragraph unsubmitted message: a human types a
  paragraph, presses Enter twice, types another.

  The first `findInputBox` stopped its upward scan at any blank row, on the
  stated grounds that "the box claude draws has no blank rows inside it".
  That was measured only for an empty FIRST logical line
  (`multiline-empty-first-line.txt`, where the prompt row still carries `❯`
  and is non-blank after trim). An empty INTERIOR line is a different screen,
  and since continuation rows carry no side chrome it renders as a genuinely
  blank row inside the box. Result: `inputBoxState` `null`,
  `holdsHumanInput` false, and the wake pastes onto the half-typed message
  and submits it.

  **That is todo 389's clobber, re-armed by the lane that exists to close it,
  on the incident's own message shape** — pad 142 records the destroyed
  message as "92 characters over three logical lines, including a deliberate
  blank line". Correct answer: `{state: "pending"}` carrying BOTH paragraphs.
  The text half matters on its own account: the continuation scan stopped at
  the same blank row, so a receipt reported one paragraph of a message that
  has two, which is what a lead reads when deciding whether it is safe to
  interrupt someone.

### And one this directory cannot hold, recorded here because it is about how these fixtures are REPLAYED

Every fixture on this page is a 220-column capture and every test above
replays it into a 220-column pane, so no line ever wraps. `hive lead` creates
an 80-column pane, and `test/restart-lead.test.mjs` replays `ready-idle.txt`
into one — where each 220-character border renders as THREE consecutive rows.
The first `findInputBox` read the second row of a wrapped edge as the box's
top border and closed the bracket with the prompt row outside it: box absent,
hold gone, at 80 and 60 columns, green at 220.

No fixture can carry this, because the defect is in the geometry the bytes are
replayed INTO, not in the bytes. `test/pane-fixtures.test.mjs` pins it by
replaying `ready-idle.txt` at three widths instead. If you add a fixture whose
own capture width is close to the pane it will be replayed into, that test is
the one that will tell you.

## Todo 403: a pending message taller than the narrow capture window

- `tall-pending-esc-to-cancel.txt` — the lead's own pane holding an
  unsubmitted message 15 lines long whose text quotes `Esc to cancel`. Built
  from `footer-slot-taken-pending.txt`, a real capture of that same pane, by
  extending its pending message with continuation rows of the shape
  `multiline-pending.txt` measured (two leading spaces, no side chrome); every
  byte of chrome around the message is the real capture's. 83 rows.

  The screen it represents is not exotic: it is a human writing to the lead
  ABOUT the dialog predicate, which is what puts the detector's own trigger
  string inside the box. Before the window split, `paneAwaitingChoice` read
  `true` on it — the footer half matched the human's own typing while the box
  half went absent, because the box's top border sits 20 rows above the last
  non-blank row and the dialog path only ever saw 18. `agent_send`'s text path
  then refuses forever and every wake aimed at that pane is held, and nothing
  clears it, because a static screen does not scroll away.

  Two rows of it are asserted directly (`pane-fixtures.test.mjs`), which is
  the same defence `tool-permission-prompt.txt` and `bypass-mode-idle-narrow
  .txt` carry: the top border must sit MORE than 18 rows above the last
  non-blank row, or the fixture does not reach the bound it exists to test and
  `ready-idle.txt` would pass every assertion in its place; and the box must
  stay within `BOX_MAX_ROWS` (24), or it reads absent to both windows and the
  fixture pins the cap rather than the window.

  **It reads `paneHasInputBox` FALSE, on purpose, and that assertion pins a
  different decision than the rest of the fixture does.** The presence
  predicate stays on the narrow window because both of its callers are
  destroyed by a false PRESENT rather than by a miss — `restart-lead.sh`'s
  refusal 1 has `tmux kill-pane` on the other side of it, and its readiness
  wait types the moment that predicate says yes. This fixture is itself the
  producer: a bash pane that has merely `cat`-ed it renders a complete 16-row
  box, and over the raw window that pane would pass refusal 1 as claude.
  Moving `paneHasInputBox` to the raw window turns all three height
  assertions red.

  **This file is also a producer of the fail-open residual the dialog half
  now carries at a wider band** (`.claude/rules/tmux-and-panes.md`, "The
  window belongs to the HALF"). A non-claude pane showing this box reads
  box-present, so a `CHOICE_DIALOG` match there reads as no dialog. That
  residual is todo 399's and is accepted; what this lane added is a file in
  the corpus that reaches it at the new band. Worth knowing before you `cat`
  a fixture into a worker's own pane.

- `stray-esc-above-the-narrow-window.txt` — SYNTHETIC, and the fixture for the
  half of the split that did NOT move. A worker's own bash pane: it grepped
  `Esc to cancel` out of `src/tmux.ts`, which is what a worker on the dialog
  lane does, then carried on working. No claude chrome anywhere on it, and
  deliberately no rule or prompt row near the bottom, so the box anchor cannot
  be what answers. The quote sits 36 rows above the last non-blank row:
  OUTSIDE the narrow window the footer half reads, INSIDE the raw one.

  It exists because the footer half staying narrow is a DECISION, and a
  decision defended only in prose is one a later refactor removes for looking
  arbitrary. Shipped, this pane reads no dialog. Hand the footer half the raw
  window and it reads a permanent unclearable dialog on a pane with nothing on
  it — `agent_send`'s text path refusing forever, every wake held, and no
  claude chrome ever coming to falsify it.

  Its discriminating power is a row OFFSET, which makes it more fragile than
  anything else here: ten more lines at the bottom of the transcript move the
  quote into the narrow window, and the case would then read the other way
  round with nothing to say why. Both bounds are asserted on the bytes — more
  than 18 rows above the last non-blank row, and inside the raw window at the
  replay height — so that edit fails on the assertion instead.

### The height axis, which is this corpus's other structural blind spot

Todo 399 found that every fixture here was 220 columns replayed into a
220-column pane, so nothing could see a wrapping-border defect. Todo 403 is
the same shape one axis over: every fixture is replayed into ONE pane height,
so nothing could tell a defect in the capture WINDOW from one that depends on
the pane's own height. `capture-pane -S -18` returns the visible pane PLUS 18
rows, so the raw window shrinks with the pane (measured: 69, 49 and 39 rows at
50, 30 and 20 rows tall) while the narrow window stays 18 at every height.
`tall-pending-esc-to-cancel.txt` is replayed at all three, and the bug
reproduced identically at each — which is what makes "the cap is the window,
not the pane" a measurement rather than an assumption.

One residual this fixture deliberately does not test: a box TALLER THAN THE
PANE ITSELF has its top border scrolled off the screen and into scrollback, so
it can read absent whatever window hive asks for. That is claude's own
rendering rather than hive's window, and it fails closed.

## codex fixtures (todo 523)

Captured `tmux capture-pane -p` (`-e` variants add `-e` for the SGR bytes)
from a real `codex-cli 0.146.0` process, 2026-08-22, private tmux socket,
scratch cwd, torn down after with `tmux -S <path> kill-server`. Every file
here is a live capture, none hand-edited. Two of these fixtures are dialogs
codex itself raised; neither was answered.

- `codex-directory-trust-dialog.txt`: the directory-trust prompt shown on
  first launch in an unrecognised directory. No `Context N% used` footer,
  so `codexPaneHasInputBox` reads false; the highlighted `› 1. Yes, continue`
  option is codex's own choice-menu shape.
- `codex-sandbox-approval-dialog.txt`: a real sandbox-escalation approval,
  elicited by asking codex to write a file under `--sandbox read-only`.
  Escaped with Escape, never answered; the file it would have written does
  not exist. Also has no footer, and its own highlighted numbered option.
- `codex-idle-ghost.txt` / `-ghost-e.txt`: idle, showing codex's own dim
  placeholder hint ("Summarize recent commits"), plain and SGR-preserving
  captures of the same screen.
- `codex-idle-pending.txt` / `-pending-e.txt`: idle, with real unsubmitted
  text typed via `send-keys -l` and never sent.
- `codex-multiline-pending.txt` / `-pending-e.txt`: a multi-line paste sent
  the same way, still sitting in the box, Enter never sent.

What these fixtures do NOT and cannot cover: codex's pane TITLE (idle,
busy-spinner, "Action Required") and a genuinely LIVE cursor accepting
keystrokes one at a time - a fixture replay (`cat file; sleep`) prints a
screen once and the cursor sits below it, so nothing can be pending in it
(`.claude/sessions/dead-ends/2026-08-14-staging-a-pending-box-on-a-static-fixture-pane.md`).
Both are covered live instead, against a synthetic pane rather than real
codex, in `test/codex-live-pane.test.mjs`.
