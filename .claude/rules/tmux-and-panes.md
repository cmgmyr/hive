---
paths:
  - "src/tmux.ts"
  - "src/spawn.ts"
  - "src/scheduler.ts"
  - "src/tools/agents.ts"
  - "src/cli.ts"
  - "src/leadMessage.ts"
  - "src/harnesses.ts"
  - "src/processes.ts"
---

# tmux, panes, and typing into them

Do not remove a guard because its reasoning is not in `CLAUDE.md`.

## A private tmux server paired with the DEFAULT store is refused, not believed

Get the boundary right. The danger is a private socket plus the DEFAULT store, not isolation as such. Legitimate isolation sets BOTH a private `TMUX_TMPDIR` and a scratch `HIVE_DATA_DIR`, and the entire suite depends on that staying allowed.

`untrustedTmuxServer()` refuses a PAIR (private socket + default store) and full isolation is deliberately exempt from it, exactly as above. `ensureAttached()` refuses on the SOCKET ALONE, and full isolation is refused by it - the very configuration the paragraph above calls legitimate. Both are correct because they answer different questions.

**A socket path is a location, not a server identity (accepted and recorded, not fixed).** Two different tmux servers that reuse the same socket path compare equal here.

**PIDs wrap.** A reissued pane can in principle land on its predecessor's exact pid - guardrail against a confused machine, not a guarantee and not a security boundary.

## A row's `tmux_target` is always a PANE id, whatever the placement

**`killAgentPane`'s window branch is NOT dead code and must stay**: an MCP server started before this change keeps writing window ids into the shared store, and `kill-pane` against a window id fails, so deleting it would leak a live process instead of erroring.

## A pane must never be recorded onto a row that is no longer running

**The caller owns the recovery**, because only the caller knows what it built: `changes === 0` means there is a live pane belonging to nobody, so both callers kill that pane and throw. Leaving it is the one outcome that leaks a process nothing tracks.

## tmux session names are namespaced by data store, not by project

One session per STORE, one window per project inside it: `sessionName()` takes no argument and returns `hive-main` for the default store.

## Aliveness checks use `list-panes`

`display-message -t` silently falls back to a default target when the given one is dead.

## A pane hive is about to claim is created WITH its command, never as a login shell it then replaces

`ensureSession`, `createWindow` and `split-window` all pass the command to the call that makes the pane. Do not go back to creating the pane bare and running `respawn-pane -k` into it, and do not add a new path that does: tmux forks a pane's child before that child has its own process group or controlling terminal, so a pane destroyed in that window kills nothing, and the login shell left behind holds a pty forever. It is a leak of a fixed machine-wide resource (`kern.tty.ptmx_max`), not an untidy process.

**`hive attach`'s project window is the one deliberate exception** (`src/cli.ts`, `cmdAttach`): its bare pane is a human's own shell and nothing destroys it seconds later.

**Two consequences the next editor here inherits.** A command that exits immediately now destroys the session `new-session` just made, so the claim throws rather than recording a dead pane - that is the reported behaviour, not a bug to smooth over. And hive's window options land one call AFTER the process is live; panes resolve inherited options at lookup time, so that is safe, and a test asserting the old ordering is asserting something that is no longer true.

## Hive-owned windows carry hive's required tmux options

A split may target a window the user created, so an unmarked window is the user's and hive must not write these options to it. The settings are best-effort: losing cosmetic configuration must never fail a spawn whose process is already live.

## A project's window is found by its `@hive-project-id` stamp, never by name

A split worker's PRIMARY placement is the store lookup one section below (`parent_actor_id` -> the spawning lead's `agents` row -> `tmux_target` -> its window), never the stamp and never ambient `TMUX_PANE`.

`allow-passthrough` is a pane option inherited from the window. Probes must use `show-options -p -A`; without `-A`, tmux reports that inherited, working value as unset.

## A split worker's window is the SPAWNING LEAD's window, resolved from the store

Never through ambient `TMUX_PANE`, which names whoever happens to be calling rather than who the row says spawned this worker, and never through a window name.

The parent row's `tmux_target` is trusted only after `rowLive()` returns `true` - the same foreign-socket conservatism every other tmux_target read in this file already applies. A parent row recorded on a socket this process cannot see into must read as unresolvable, not as "no parent".

## Never type into a pane that is waiting on a choice

Delivery is a paste followed by Enter. A pane showing a modal has nowhere to put the paste and reads the Enter as "choose the highlighted option", so the wake vanishes, no user turn is created, and hive answers a prompt nobody read.

A pane that is merely BUSY is fine.

- `deliverable()` in `src/scheduler.ts` **HOLDS**. A wake is a timer that retries, so a dialog delays it: not cancelled, not claimed. The check sits ABOVE `claimOneShot`, because after the claim "not now" and "never" are the same thing.
- `agent_spawn`'s announcement, `agent_rename`'s `/rename`, and `agent_send`'s `text` path **REFUSE**. Each has a synchronous caller standing right there, so they return a receipt naming the dialog and carrying the pane's tail. **That is an argument about the SHAPE of the stop - a receipt rather than a retry - and never about whether to proceed.** Neither caller is a human: a lead calling `agent_send` is an autonomous session, so "someone is watching" is not a reason to type.
- **An unreadable pane is the THIRD outcome and must not be read as "no dialog".** `paneChoiceCheck` answers `null` for a capture it could not take. `agent_send`'s text path refuses on it (on a SUBMITTING send - the destructive event is the Enter, so `submit=false` is exempt exactly as it is for the box check) and `agent_rename` refuses. On those REFUSE-path sites, gate the box read on `awaitingChoice === false`, never on `!== true`, or the two conditions drift apart again; `deliverable()`'s own box read deliberately runs on `!== true`, per the next bullet.
- **`deliverable()` DELIVERS on an unreadable choice check, and that asymmetry is deliberate - do not "fix" either side to match the other, and do not build a STICKY hold here.** A wake is ownerless once scheduled, so refusing or cancelling it on one failed observation loses the delivery with nobody present to resubmit; a submitting `agent_send` has a synchronous caller who retries in seconds. If this is ever revisited, the only sanctioned alternative is a RE-EVALUATING hold placed below every check that does not read the pane. The full argument, its history (an earlier version of this bullet falsely claimed `deliverable()` holds here), and the measured blast radius of the wrong placement are in the `hive-internals` reference for this rule.
- `agent_send`'s `keys` path is **DELIBERATELY UNGUARDED against a dialog** and must stay so. `text` means "inject a user turn", which is what a dialog eats; `keys` means "drive this TUI on purpose", and pressing a key is the ONLY supported way to unstick a pane sitting on a dialog. Guarding it by symmetry would remove the one working escape hatch.
- **This refusal is a guardrail against a confused model, not a security boundary.** Do not extend this into refusing slash commands on the `text` path to close that gap - that is scope creep on an already-deep lane.
- **`captureRawPane`/`tailWindow` split one pane capture into two windows on purpose.** `paneAwaitingChoice` and `paneHasInputBox` read different ones; do not unify them "for consistency".

## Free text is typed as a BRACKETED PASTE, never as `send-keys -l`, at any length

tmux hands a pane its input in 1022-byte writes. `paste-buffer -d -p` wraps the
whole text in bracketed-paste markers, so the receiving TUI rejoins those writes;
`send-keys -l` does not, so each write lands as an independent burst of
keystrokes and claude's input box keeps only the last one. A message past 1022
bytes arrives with its head missing, cut mid-word, and `agent_send` still
returns `sent: true`.

**`-p` emits those markers only for a pane whose application asked for them**
(DECSET 2004). Measured: claude and codex both set it, a plain shell pane does
not, and a pane in COPY MODE has it cleared out from under it. So the guarantee
is conditional and the next two prohibitions are what make it safe to rely on.

- **`sendText` (`src/tmux.ts`) must stay unconditional.** It used to branch on
  `text.includes("\n")` and type newline-free text with `send-keys -l`; that
  dropped three of the lead's real assignments in one evening (todo 599).
- **Do not reintroduce a length threshold to get the single call back.** 1022 is
  a pty constant measured on one kernel, so a threshold is wrong elsewhere in
  exactly the same silent way.
- **`agent_send`'s `keys` path still reaches `send-keys` directly and must.**
  Driving a TUI on purpose is what it is for.
- A test simulating a HUMAN typing still uses `send-keys -l`; that is what a
  human's keystrokes are, and it is how the `real-input.txt` fixture was made.

## A pane in tmux COPY MODE is never typed into

tmux clears a pane's bracketed-paste flag in copy mode, so `paste-buffer -p`
sends no markers there and the following Enter is eaten by the mode instead of
submitting. Both tmux calls exit 0. That restores the head loss above AND
strands what survives, unsubmitted, with every receipt reporting success.

- **Both typing sites check it, and both must keep checking it.** `agent_send`'s
  text path REFUSES with a retriable note; `deliverable()` HOLDS, exactly like
  the dialog and unsubmitted-text checks, and delivers once the pane leaves copy
  mode. One predicate, `paneInCopyMode` (`src/tmux.ts`).
- **The predicate is `#{pane_in_mode}`, never `#{bracket_paste_flag}`.** The flag
  answers the question more directly, but reads 0 for a legitimate shell pane,
  so refusing on it refuses panes that are fine.
- **Do not cancel copy mode and paste anyway.** It works, and it takes a human's
  scrollback position away while they are reading it. Waiting is what the other
  holds already do.
- **`keys` is unaffected and is the deliberate escape hatch**, as everywhere else
  in this file.

## Only ONE channel into a pane is shortened, and widening it breaks an assignment

`agent_send`'s `text` over 300 characters, inbound to a LEAD from anyone who is not that lead, is stored whole and typed as a one-line pointer (`src/leadMessage.ts`, todo 475). That is the entire exception.

- **Do not widen it to worker-bound text at any length.** There the message IS the assignment, and a truncated assignment is a broken one. Pinned by `test/lead-message-shortening.test.mjs`.
- **Do not shorten at write time.** The row must store the FULL text and the pointer must be rendered at delivery, or the lookup the pointer names reads something that was never written.
- **Every field interpolated into the pointer goes through `flatten`** (`src/slug.ts`), the sender's name included. A raw control byte in any of it reaches tmux as a keystroke and submits the pointer early.
- **A lookup that misses must say WHICH miss it is.** The pointer outlives its row, so `pruned`, `never-issued` and `other-project` are distinct answers. Do not collapse them into "not found".

## A pane with unsubmitted human text holds its wake too

Only `pending` (real, human-typed text) holds. `ghost` must not, or every idle pane holds every wake forever. `unknown` must not either: a hold that silently starts firing on every unrecognised screen is worse than a detector that silently stops.

**`agent_send`'s text path and `agent_rename` REFUSE on the same condition.**

**`submit=false` is exempt, and that is a decision, not a gap.** The destructive event is the Enter, not the paste: a submitted merge sends a human's half-written sentence as a message he never finished and cannot take back, while `submit=false` leaves characters in a box where they are visible and editable - the `keys` category, drive-this-TUI-on-purpose, not inject-a-user-turn.

**THIS PROTECTION IS CHROME-SHAPED, SO A PANE HIVE CANNOT CLASSIFY IS NOT TYPED INTO AT ALL.** Each classifying harness (`claude`, `codex` as of todo 523) carries its OWN detectors on `HarnessCapabilities.paneClassifier` (`src/harnesses.ts`); every guarded call site resolves `harnessFor(command).paneClassifier` and reads THAT harness's screen with THAT harness's regexes, never another harness's. That indirection is not decoration: reading one harness's chrome with a different harness's detectors fails in OPPOSITE directions regardless of which two harnesses they are - a dialog check tuned to the wrong wording degenerates to a bare-phrase match and either refuses forever on a stray coincidence or (worse) never matches a real dialog at all, while a box-content check finds no box, reads `null`, `holdsHumanInput` is false, and the merge goes through - where it does not just submit a message, it **executes** (a human who typed `rm -rf ./buil` and walked away, plus an `agent_send(text: "npm test")`, is a shell running `rm -rf ./builnpm test`). `registerHarness` throws if `classifiesPaneScreen` and `paneClassifier` disagree (`src/harnesses.ts`), so a harness cannot claim classifiability while carrying no classifier at all. **It does not check that the classifier is a DISTINCT set of detectors** - a harness that deliberately reuses another's `paneClassifier` (a fork sharing its parent's chrome, say) passes the same as one with its own, and that is accepted, not a gap: nothing here has evidence two harnesses can't legitimately share detectors, so this guard is only ever "classifiable without a classifier," never "classifiable without your OWN classifier." For a harness with no entry at all, `screenClassifiable` (`src/harnesses.ts`) gates every path that types: `agent_send`'s text path refuses, `wake_set`/`wake_when_idle` refuse the target at creation, `deliverable()` holds as a backstop, and `agent_rename` was already gated on `supportsRename`, which may no longer be set without `classifiesPaneScreen`.

- **An empty command is "no fact recorded", never "unclassifiable".** A wake can name a pane with no `agents` row behind it at all (`resolveDelivery`'s `TMUX_PANE` fallback, `src/tools/wakes.ts`), and reading that as unclassifiable stops every wake a plain session ever set for itself. Same rule as `tmux_socket = ''` and `pane_pid = ''`.
- **`keys` stays unguarded and is the remedy every refusal here must name.** `text` means "inject a user turn" and a pane with no user turns has nowhere to put one; `keys` means "drive this TUI on purpose", which is what a non-claude pane needs. Refusing text there does not make such a pane undriveable.
- **Refuse a wake at the door, do not only hold it.** A plain `wake_set` has no `max_wait_at` to end at, so a delivery-time hold alone would sit forever. `deliverable()`'s hold is the BACKSTOP - for a timer created before the refusal shipped, and for one whose row changed command underneath it. It is labelled `needs you`, and it is ranked LAST in the statusline chooser: it is always the oldest, so preferring it would mask every newer, actionable hold permanently.
- **`hive lead` must never claim a command for a pane it did not create.** The row's `command` is what every guard here reads, so relabelling an adopted pane disarms them. The write is keyed on `createdPane` and lives in the restart CAS, not in `ensureLeadRow` - which runs BEFORE the adopt decision. The same boolean gates clearing an unclassifiable hold. A mismatch on adopt is PRINTED, because the new command silently not taking effect is worse than the old row being wrong.
- **Never mint a notice hive could not deliver.** An age-out replacement is parentless, so `noticeDisposition` can never age it out, and the hold keeps it forever: one immortal row per age-out. Guard it at `ageOutNotice`, never inside `insertNotice` - two callers stamp episode claims against its return, and a refused insert there claims a finish that can then never be re-reported.

**The hold now has two reason strings sharing one prefix.** Code asking "is this an unsubmitted-input hold" must use the prefix predicate (`isUnsubmittedInputHold`), never an equality check against the plain constant, or it silently misses the transient retry variant.

## A tmux call that never answers is `null`, and it is a THIRD outcome

`execFileSync` with no `timeout` blocks for as long as the child runs, which against a wedged server is forever. Every call now carries a bound and `killSignal: "SIGKILL"`, since a wedged tmux is the process least likely to act on a SIGTERM.

**The bound is 10s and it is MEASURED, not felt.**

**What a timeout MEANS is the half that decides whether this is a fix or the same failure through another door.** `tmux()` used to have two outcomes: an answer, or a `TmuxError` that `tmuxSaysNothingThere()` classifies. A timeout is a third, and reading it as the second reaps live workers, which is the exact failure the bound exists to prevent. `TmuxTimeoutError` is a SUBCLASS of `TmuxError`, so every existing catch site keeps working.

**`HIVE_TMUX_TIMEOUT_MS` is testing only** (a 10s bound can only expire in real time), read at call time, and `hive doctor` reports it when set, because a knob that shortens a safety bound must not sit in an environment silently.

**AND A FOURTH OUTCOME HIDES INSIDE THE SECOND: `tmuxSaysNothingThere()` IS TRUE WHEN THE BINARY IS MISSING.** It tests `notInstalled` before it ever tests `NOTHING_THERE`, so with no tmux on `PATH` `liveTargets()` answers with an EMPTY SNAPSHOT - indistinguishable, to any caller reading only `panes.size`, from a server that really has no panes. Sweeping on that is old behaviour and stays; REPORTING on it is not. Anything that tells a human something HAPPENED must gate on `AliveSnapshot.serverAnswered`, or an unset PATH becomes an incident report (`.claude/rules/store-and-datadir.md`, the teardown record). Keep the two questions apart: "what did the server say" and "was there anything to ask".

**IT BOUNDS THE DAMAGE AND LEAVES THE CAUSE OPEN.** `execFileSync`'s timeout kills the CHILD, not the tmux SERVER it was talking to, so a wedge now costs ten seconds per call instead of an hour of a core, and the wedged server keeps running. It REPORTS and never reaps.

## Three shell traps

- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings. Target a session by id when its name starts with `=`.
- **Never run `tmux kill-server`.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>`.
- **`-S` is overloaded.** In `tmux -S <path> ...` it names the socket. In `capture-pane -S -<n>` (`src/tmux.ts`'s `captureRawPane`/`inputBoxState`) it is the capture's START LINE, nothing to do with a socket. A check that scans nearby args for a bare `-S` to confirm a call is socket-pinned will misread a `capture-pane` start-line flag as one and silently stop refusing.

## All process execution goes through `execFileSync` with argument arrays

Never build a shell command string out of data.

`tmux()` in `src/tmux.ts` is the way to reach tmux, but it is **not the only path**, so do not read it as a coverage claim. Known others, not guaranteed exhaustive: `src/cli.ts`'s `attach()` calls `spawnSync("tmux", argv, { stdio: "inherit" })` twice (`:381`, `:392`) because it hands the terminal over rather than capturing output; doctor probes `execFileSync("tmux", ["-V"])` (`:1885`); and `ensureAttached` runs `execFileSync("osascript", ["-e", script])` (`src/tmux.ts:1129`) where `script` comes from `attachScripts()` and **is a built string carrying the session name** - the one live exception to the sentence above, and the reason it is called out here rather than left to be discovered.

What those paths do NOT carry is what `tmux()` itself adds, which is exactly two things: the timeout bound, and `scratchStoreOnSharedSocket()`. **`untrustedTmuxServer()` is NOT one of them** - it is applied per call site (`ensureSession`, `targetLiveProbe`, `src/tmux.ts:432`, `src/spawn.ts:186`/`:297`, `src/cli.ts:1987`), so a NEW read path built on `tmux()` gets the timeout and the socket guard for free and still needs its own cross-server check. Pane titles, session names, agent names, wake bodies and `hive.yml` values all reach these calls, and every one of them is attacker-adjacent in the weak sense that matters here: they are typed by a human or written by a repo, not validated by hive.

## iTerm profile commands run with no shell and a minimal PATH

Auto-attach drives iTerm through AppleScript, and the command an iTerm profile runs does NOT get a login shell. It inherits a minimal `PATH` that does not include `~/.local/bin`, Homebrew, or any nvm or Herd directory, so a bare `hive` or `tmux` in one of those strings resolves to nothing and the failure surfaces as a window that opens and immediately dies.

Embed absolute binary paths in AppleScript strings. Resolve them at call time from the same place the dispatcher does rather than hardcoding a literal.

**hive cannot ensure the window it opens reaches ITS socket, so a process on a private one must not open one at all.** `attachScripts` emits neither `-L` nor `-S`, so the tmux the AppleScript shell runs resolves its socket from that shell's own environment.

**No shell does not mean no quoting.** `renderAttachCommand`'s shell-style quoting (`src/tmux.ts`) is therefore harmless on the iTerm branch and load-bearing on Terminal's `do script`, which really does run through the user's login shell.

See `.claude/skills/hive-internals` for the incidents, measurements, and mechanism behind these.
