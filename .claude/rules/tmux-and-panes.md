---
paths:
  - "src/tmux.ts"
  - "src/spawn.ts"
  - "src/scheduler.ts"
  - "src/tools/agents.ts"
---

# tmux, panes, and typing into them

These cost real state when they were broken: a live worker closed mid-lane, and a wake that answered a dialog nobody read. Each is enforced by code and pinned by a test. Do not remove a guard because its reasoning is not in `CLAUDE.md`; the reasoning is here and next to the code.

## A private tmux server paired with the DEFAULT store is refused, not believed

A probe against the wrong server SUCCEEDS and answers the wrong question correctly, so nothing in the snapshot separates it from a genuinely dead pane. `targetAlive("%3", snapshotOfSomeOtherServer)` is false for exactly the reason a dead pane is false.

`untrustedTmuxServer()` refuses the pair. `liveTargets()` and `targetLive()` answer `null`, which every consumer already handles conservatively. `launchAgent` refuses ABOVE its INSERT, because the row is the first statement precisely so a rejection never leaves a half-built pane. Both halves are gated, reads and writes: under the bad pair `sessionName()` returns the untagged name, `ensureSession` creates a second session on the private server, and the pane id from that fresh server gets written into the SHARED store, where it very likely names a stranger's pane.

Get the boundary right. The danger is a private socket plus the DEFAULT store, not isolation as such. Legitimate isolation sets BOTH a private `TMUX_TMPDIR` and a scratch `HIVE_DATA_DIR`, and the entire suite depends on that staying allowed. The test is which socket tmux will actually use, computed in tmux's own order of precedence: `TMUX`'s first comma-separated field, else a reachable `TMUX_TMPDIR`, else `/tmp`, always `<base>/tmux-<uid>/default`. Three earlier versions asked a proxy question instead and each was wrong differently. Two corrections worth keeping: tmux does not create `TMUX_TMPDIR`, so a value naming a missing directory resolves to the SHARED socket; and inside a pane `TMUX` overrides `TMUX_TMPDIR` completely, so `tmux -L spike` is a private server with no `TMUX_TMPDIR` set at all.

Pinned by `test/server-store-mismatch.test.mjs`.

**The guard is now data-shaped, not just env-shaped.** Issue #73 added `agents.tmux_socket`, written in the same statement as every `tmux_target` write: `launchAgent`'s INSERT and its pane UPDATE (`src/spawn.ts`), and `ensureLeadRow`'s fresh INSERT and `cmdLead`'s restart CAS (`src/cli.ts`), all from `tmuxSocketPath()`, the identical function `untrustedTmuxServer()` above already decides server identity with. `foreignSocket()` plus the row-level `rowLive()`/`rowAlive()` (`src/tmux.ts`) refuse to believe a row whose recorded socket disagrees with the one this process would talk to: they answer `null`, the same conservative unknown every consumer here already had to handle for the process-level guard. An empty socket means "no fact recorded", never foreign - every row written before this migration reads that way and behaves exactly as it did before, so a second shell setting only `HIVE_DATA_DIR` no longer closes every worker in the spike store; it now gets `null` for each one instead and sweeps nothing. Wired into `isLive()`/`summaryLiveness()` (`src/tools/agents.ts`, the choke point for `agent_close`/`agent_send`/`agent_list`), the janitor's agents sweep and its timers sweep (a timer LEFT JOINs to its `deliver_actor`'s own agents row for this, since a timer names a pane, not a row, and a join miss reads as the same "no fact recorded" empty case, scoped to `agents.status = 'running'` - see `DELIVER_SOCKET_JOIN`'s own comment for why an unscoped join let a closed row launder a foreign pane past this guard), `deliverable()`, `watchedTail()`'s and `hive doctor`'s own per-worker pane-capture reads (two independent call sites, each gated separately rather than through one shared helper), `watchedStates()`'s idle-wake check, and `startYmlCommand`/`cmdLead`'s stillThere check/`hive doctor`'s lead report (`src/cli.ts`).

Counselors round 1 on PR #80 found this claim overclaimed its own coverage: `deliverable()`, `watchedStates()`, `startYmlCommand`, `cmdLead`'s stillThere check and doctor's lead report had no test at all. The fix round that followed closed some of that gap and is honest about what remains. Pinned now: `test/tmux-socket.test.mjs` (the write side); `test/tmux-socket-foreign.test.mjs` for `isLive()`, both janitor sweeps, `tick()`'s `deliverable()` (a fixture with two lead rows sharing one `actor_id`, one closed on this socket and one running on a foreign one - the shape the join scoping above exists for), and `tmuxSocketPath()`'s own directory-only canonicalisation (`canonicalSocketPath()`, so an unlinked-then-recreated socket file cannot flip a live row foreign); `test/false-idle.test.mjs` for `watchedTail()`'s foreign-socket gate; and `test/state-provenance-cli.test.mjs` for doctor's per-worker pane-capture gate and its stuck-row report (a foreign-socket running row the janitor cannot sweep, named rather than left silent). `watchedStates()`'s own foreign-socket branch, `startYmlCommand`, `cmdLead`'s stillThere check and doctor's lead-liveness report still have no test; narrowed here rather than left to overclaim.

Counselors round 2 (F3, R2-3) found this list itself under-claiming in the one place it most needed to be right: `test/server-store-mismatch.test.mjs` pins `defaultTmuxSocketPath()` (which calls `canonicalSocketPath()` internally) against an independently-derived regex, not against a second call to the same function - the one assertion in the suite that actually kills a constant-returning `canonicalSocketPath`. The two dedicated tests in `test/tmux-socket-foreign.test.mjs` do not: they only assert the function agrees with itself across two inputs, which a hard-coded constant would also pass.

**A socket path is a location, not a server identity (counselors A1, accepted and recorded, not fixed).** `tmuxSocketPath()` keeps only the path field of `TMUX` (`<path>,<server pid>,<session>`) and drops the pid. Two different tmux servers that reuse the same socket path - the ordinary case across a reboot, since tmux always names the default socket `<base>/tmux-<uid>/default` - compare equal here. After a reboot, rows recorded on the old server are never foreign to the new one, pane ids restart at `%0` and collide with whatever the new server has already issued, and `agent_send` can type into the wrong pane. Pre-existing, not something this lane introduced, but this is the lane that claims to close the env-shaped residual above, so the claim has to stop short of "which server" and say only "which socket path". Closing it for real needs the pid or the socket file's inode recorded alongside the path - a second migration, not a fix that belongs in this one. See `tmuxSocketPath()`'s own comment (`src/tmux.ts`).

**Issue #27's L4 fix round R9, todo 176, and how issue #73 closed it.** A lead row used to be immortal (the janitor exempts `kind='lead'`, `agent_close` refused it outright), so `hive restore` could only ever GUESS at a lead's liveness before deciding whether the store was in use - and every guess (todo 165, then todo 173) failed a different way. R9 stopped guessing: `hive restore` now counts any running lead row as in-use unconditionally, with no probe at all, and `agent_close` gained the retirement path that makes that safe - it closes a lead whose pane is CONFIRMED dead. "Confirmed dead" means `isLive()`, and until issue #73 that resolved through the same cross-server blind spot: a caller on the wrong tmux server calling `agent_close` on a lead whose real pane lives elsewhere got a false "dead" (`targetLive` answered `false`, not `null`, because the wrong server genuinely has no such pane) and retired a row that was actually still running. `isLive()` now consults `rowLive()` first, so that same caller gets `null` and `agent_close`'s own `if (live === null) throw probeFailed(agent)` - already sitting above the confirmed-dead close - declines instead of retiring. Pinned by `test/agent-close-foreign-socket.test.mjs`, alongside the control that the matching-socket case still retires exactly as before.

**R9's own residual text overclaimed here, and R10's todo 181 item 1 is the correction, not a widening.** R9 wrote "closing this one deliberately (a human choosing to run `agent_close` on a specific, named lead)" as if that were already true. It was not: nothing checked who the caller was, so any WORKER could call `agent_close(name: "lead")` exactly like a human at a terminal, including hitting the cross-server false-dead case above against a lead it has no business touching at all. `agent_close` now refuses outright - before probing liveness, so this applies whether the target reads live, dead, or unprobed - whenever `currentActor()` starts with `agent:`. A plain claude session is `user:<name>` and a peer lead is `lead:N` (`src/context.ts`), so a human at a terminal and a peer lead both keep the retirement path; only a spawned worker loses it. For those callers, the cross-server false-dead case is now closed too, by the paragraph above: this is a caller-KIND gate for who may reach the retirement path at all, alongside a liveness-TRUTH fix for what that path believes once reached.

## tmux session names are namespaced by data store, not by project

One session per STORE, one window per project inside it: `sessionName()` takes no argument and returns `hive-main` for the default store. Project ids are SQLite row ids, unique only within one store, so a project id was never a safe namespace on its own, and tmux session names share one machine-wide namespace regardless. `sessionName()` tags the name when `HIVE_DATA_DIR` is not the default; the default store keeps the documented `hive-main`.

Naming goes through the same guard as opening: `dataDirTag()` is `tagFor(storeDir())`. It was exempt for one commit on the grounds that building a string touches no disk, which answered the wrong question, since a session name is the target argument for `kill-session` and `respawn-pane`. A scratch store still needs its own namespace for the identical reason it always did: `hive-main` in a scratch store must not resolve to the live session of the default store's own project window.

## Aliveness checks use `list-panes`

`display-message -t` silently falls back to a default target when the given one is dead.

## Hive-owned windows carry hive's required tmux options

Every window hive creates is marked with the window option `@hive-owned=1`
and receives `allow-passthrough all`, `pane-border-status top`, hive's pane
border format, and `monitor-bell on` before its real process starts. A split
may target a window the user created, so an unmarked window is the user's and
hive must not write these options to it. The settings are best-effort: losing
cosmetic configuration must never fail a spawn whose process is already live.

## A project's window is found by its `@hive-project-id` stamp, never by name

Under one store-scoped session (`sessionName()`, above), every project's
window carries `@hive-project-id`, set in the same `configureHiveWindow` call
that sets `@hive-owned`. `cmdLead` (`src/cli.ts`) resolves a project's window
by reading this stamp off the session's windows, never by matching the
window's name. `splitTargetWindow` (`src/spawn.ts`) reads it too, but only as
the fallback for a spawn with no resolvable parent - a split worker's
PRIMARY placement is the store lookup one section below (`parent_actor_id` ->
the spawning lead's `agents` row -> `tmux_target` -> its window), never the
stamp and never ambient `TMUX_PANE`. A window name is cosmetic now (the
project name alone, not "<project> - lead"), and two projects can
legitimately share one: only `path` is unique in the `projects` table, so two
real checkouts named the same thing is not a hypothetical.
Reading `@hive-project-id` at window scope needs no `-A`: measured live
against a real tmux, `show-options -w` (with or without `-A`) and
`list-windows -F` all agree once a value is set at window scope, whether
queried via the window itself or via one of its panes. `-A` only matters
descending FROM window scope INTO a pane-scope `show-options` query - the M7
trap on `pad 71` (`allow-passthrough`, a genuinely pane-inherited option) -
never at matching scope, which is what every `@hive-project-id` read is.

A worker's own placement="window" (its own dedicated window, not a split into
its project's) does not stamp ownership yet and still resolves by
`windowTitle()`; that is 3b's, not this invariant's.

`allow-passthrough` is a pane option inherited from the window. Probes must
use `show-options -p -A`; without `-A`, tmux reports that inherited, working
value as unset.

## A split worker's window is the SPAWNING LEAD's window, resolved from the store

`splitTargetWindow` (`src/spawn.ts`) resolves a split-placed worker's target
window through `parent_actor_id` -> the parent's `agents` row -> its
`tmux_target` (a pane id) -> `paneWindow()` of that pane - never through
ambient `TMUX_PANE`, which names whoever happens to be calling rather than
who the row says spawned this worker, and never through a window name (todo
267, `decisions/2026-08-05-tmux-topology-windows-not-sessions.md`). This is
the cross-repo case the whole redesign started from: a worker's STORE scope
(`agents.project_id`) and where its PANE appears are separate questions, and
a worker recorded under a different project than its spawning lead is meant
to land in the lead's window regardless (`.claude/rules/project-scoping.md`
now names this as a third axis, beyond files and store).

The parent row's `tmux_target` is trusted only after `rowLive()` returns
`true` - the same foreign-socket conservatism every other tmux_target read
in this file already applies. A parent row recorded on a socket this process
cannot see into must read as unresolvable, not as "no parent"; skipping this
check would let a stale or foreign parent row send a worker's pane to a
window on a server this process has no business trusting. When the parent
is unresolvable (no row, dead pane, foreign socket), `splitTargetWindow`
falls back to `findProjectWindow` (the `@hive-project-id` stamp lookup,
above) - the honest answer for a spawn with no resolvable parent: an
unattended run, or a caller that is not a lead.

## Never type into a pane that is waiting on a choice

Delivery is a paste followed by Enter. A pane showing a modal has nowhere to put the paste and reads the Enter as "choose the highlighted option", so the wake vanishes, no user turn is created, and hive answers a prompt nobody read.

A pane that is merely BUSY is fine, and that conclusion still holds. The mechanism this file described until 2026-08-02 did not, and the difference decides how you read a wake that never confirms.

Measured against Claude Code 2.1.220 by delivering wake 109 into a worker that was mid-turn: the paste is enqueued (a `queue-operation` transcript entry with `operation: "enqueue"`), removed from the queue 0.8s later, and enters the RUNNING turn as `type: "attachment"` carrying `attachment.type: "queued_command"`. The model read it and acted on it 3.1s after typing, while the turn it interrupted carried on to its own end. It is NOT delivered as a user turn, and it is NOT held until the turn ends.

The consequence is the part that bites. An attachment fires no `UserPromptSubmit`, so no `prompt` row reaches `agent_state_log`, and `checkConfirmations()` in `src/scheduler.ts` can only set `confirmed_at` from a prompt row carrying the `[hive wake #N]` marker at or after `typed_at`. A wake delivered into a busy pane arrives, is read, is acted on, and still reads `unconfirmed` for the rest of its life. That is a PERMANENT false negative, not a delivery that confirms late. `timers.typed_busy` (schema v8) records the busy observation at typing time so the two cases can be told apart afterwards.

Busy is still not modal, and conflating them still sends you fixing the wrong thing.

How this stayed wrong is the transferable part. The old sentence claimed it was "verified twice against the transcript on disk", and the wake text genuinely IS in the transcript, so a reader who goes looking finds it and reads an attachment as a user turn. The transcript answers "did the text arrive". It never answers "did a user turn begin". For the second question read `agent_state_log`. A record citing one channel cannot settle a claim about the other, and both of this project's records about this made that mistake in opposite directions.

The same measurement names a confirmation channel hive does not use yet: the transcript entry is structured JSON, carries the `[hive wake #N]` marker in `attachment.prompt`, is timestamped, and sits at a path hive already resolves for claude workers (`resolveTranscriptDir` in `src/transcript.ts`, reached today only by `agent_status`'s `transcript_dir` in `src/tools/agents.ts`). That is a better instrument than scraping a rendered pane, and it is still coupled to undocumented Claude Code internals, so weigh both before building on it.

Four paths type into a pane, guarded two different ways:

- `deliverable()` in `src/scheduler.ts` **HOLDS**. A wake is a timer that retries, so a dialog delays it: not cancelled, not claimed. The check sits ABOVE `claimOneShot`, because after the claim "not now" and "never" are the same thing.
- `agent_spawn`'s announcement, `agent_rename`'s `/rename`, and `agent_send`'s `text` path **REFUSE**. Each has a synchronous caller standing right there, so they return a receipt naming the dialog and carrying the pane's tail.
- `agent_send`'s `keys` path is **DELIBERATELY UNGUARDED against a dialog** and must stay so. `text` means "inject a user turn", which is what a dialog eats; `keys` means "drive this TUI on purpose", and pressing a key is the ONLY supported way to unstick a pane sitting on a dialog. Guarding it by symmetry would remove the one working escape hatch.

  **Issue #27's L4 fix round R6, todo 169 (counselors opus F3): this path gained a SEPARATE guard, against a different target, not a reversal of the paragraph above.** The dialog exemption is an argument about a SUPERVISOR unsticking a SUBORDINATE's TUI, and it does not reach the lead: nothing supervises the lead, the same premise `agent_close`'s own refusal rests on. Without a kind check, a worker could send `keys: ["C-c", "C-c"]` (or `C-d`) at "lead" and end its session exactly as effectively as the `agent_close` this project already refuses, with no dialog guard, no `confirm_self`, and no kind check of its own to catch it. `agent_send` refuses `keys` on a `kind='lead'` target when the CALLER is not itself a lead; `text` on a lead is unaffected, and a lead sending `keys` to another lead is unaffected, preserving the escape hatch for the multi-lead direction this project is deliberately building toward. Pinned by `test/typing-guards.test.mjs` alongside the dialog cases above.

  **Issue #27's L4 fix round R8, todo 175 item 3 (BOTH SEATS): "the caller is itself a lead" is checked against a real, running `kind='lead'` agents row (`isRunningLeadActor`, `src/spawn.ts`), not against `HIVE_AGENT_ID` alone.** `isLeadActorId` is a string prefix check with no row lookup behind it, so a caller could satisfy it by setting `HIVE_AGENT_ID` to any string shaped like `lead:<n>`, naming no row at all - the branch's own test proved it, passing `HIVE_AGENT_ID: "lead:999"` with no seeded row and getting the escape hatch anyway.

  **This refusal is a guardrail against a confused model, not a security boundary, and that distinction matters for how you reason about it.** It is not equivalent to `agent_close`'s refusal, which is enforced regardless of what tools the caller reaches for. A worker with Bash reaches the exact same outcome as raw `keys` by calling `tmux send-keys` directly, since that runs outside hive entirely; and `agent_send`'s own `text` path is untouched by design (see above), so `text: "/exit"` ends the lead's session with no `keys` involved at all. Do not extend this into refusing slash commands on the `text` path to close that gap - that is scope creep on an already-deep lane, and the residual is written down here instead. Worth recording alongside it: the WAKE route is genuinely closed, and for a real reason - `deliver()` prefixes every body (`src/scheduler.ts`), so a wake body can never be a bare slash command.

The discriminator is `paneChoiceCheck()` / `paneAwaitingChoice()`. A dialog is the footer AND the absence of the input-box marker, never the footer alone: matching the footer alone was tried and broke, because a worker that greps for the string, or opens a captured fixture, renders it in its own transcript and gets refused forever with no real dialog to clear. A modal REPLACES claude's input affordance rather than sitting beside it, so the missing input box is the real signal. `INPUT_BOX_PRESENT` is shared by the readiness probe, this discriminator, and `input_box` reporting, and the three fail in opposite directions, so do not widen it.

The pane answer is cached per tick, and that cache is invalidated whenever hive delivers into a pane, because typing is the one thing inside a tick that can change the answer.

Pinned by `test/typing-guards.test.mjs` and `test/pane-fixtures.test.mjs`.

## A pane with unsubmitted human text holds its wake too

The sibling of the dialog hold, not a reversal of it, and the two are told apart by opposite signals. A modal REPLACES the input box, so `paneAwaitingChoice` needs the box ABSENT. A human mid-typing has a box very much PRESENT with real text in it, so the dialog check cannot see this case at all.

It matters for the same reason: delivery is a paste followed by Enter, so a box that already holds typed text gets the wake body pasted onto the end of it and both submitted as one message. Observed on two machines before this was closed - the wake arrives merged with whatever the human was halfway through writing.

`deliverable()` holds, above `claimOneShot`, exactly where the dialog check sits and for the identical reason: after the claim, "not now" and "never" are the same thing. The discriminator is `inputBoxState()`, which already existed and was reporting-only - its sole consumer was `agent_status`/`agent_output`'s `input_box` field. Only `pending` (real, human-typed text) holds. `ghost` must not, or every idle pane holds every wake forever, since an idle claude shows its own hint. `unknown` must not either: it means the detector's chrome-matching drifted (issue #30's shape), and a hold that silently starts firing on every unrecognised screen is worse than a detector that silently stops - the loud failure is `input_box` reporting `unknown` on a receipt, not a wake that quietly never fires.

The two pane reads are deliberately NOT fused into one capture. `paneAwaitingChoice` reads plain, `inputBoxState` needs `-e` for the ghost/pending discriminator, and the `-e` serializer disagrees with the plain one about which rows are blank (it emits OSC 8 and SO/SI controls that the SGR-only strip leaves behind). See `src/tools/agents.ts`'s own comment - and note that comment's OTHER historical reason, ENOBUFS past `execFileSync`'s default `maxBuffer`, no longer applies since `tmux()` passes a 16MB buffer. The row-disagreement half is what still holds the two apart.

**Open residuals.** TWO conditions now hold a wake indefinitely, both past `max_wait_at`: a pane sitting on a dialog, and a pane with unsubmitted human text. The second is a deliberate choice rather than an oversight - hold-until-the-box-clears was chosen over hold-until-`max_wait_at` so there is ONE rule for "a human is busy with this pane" instead of two, accepting that text left sitting in a box holds that wake forever. And the check-to-Enter race is real: the screen is read, then the Enter follows 300ms after the paste, so a dialog raised in that gap still gets answered.  Closing either needs delivery to stop meaning "typed at a terminal".

## Two shell traps

- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings. Target a session by id when its name starts with `=`.
- **Never run `tmux kill-server`.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>`.

## All process execution goes through `execFileSync` with argument arrays

`tmux()` in `src/tmux.ts` is the only way this codebase reaches tmux, and it takes an array. Never build a shell command string out of data. Pane titles, session names, agent names, wake bodies and `hive.yml` values all reach these calls, and every one of them is attacker-adjacent in the weak sense that matters here: they are typed by a human or written by a repo, not validated by hive.

An argument array has no shell, so quoting is not a thing you can get wrong. A command string reintroduces the whole class, and the shell trap above is the mild version of it that has already been hit: a leading `=` expanding as a path.

## iTerm profile commands run with no shell and a minimal PATH

Auto-attach drives iTerm through AppleScript, and the command an iTerm profile runs does NOT get a login shell. It inherits a minimal `PATH` that does not include `~/.local/bin`, Homebrew, or any nvm or Herd directory, so a bare `hive` or `tmux` in one of those strings resolves to nothing and the failure surfaces as a window that opens and immediately dies.

Embed absolute binary paths in AppleScript strings. Resolve them at call time from the same place the dispatcher does rather than hardcoding a literal, since the interpreter this project pins moves with the machine's Node install (`.claude/rules/native-addon.md`).
