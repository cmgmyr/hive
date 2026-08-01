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

**Known residual, still open.** The guard is env-shaped, not data-shaped, so rows written from a private tmux into a SCRATCH store are unprotected: a second shell setting only `HIVE_DATA_DIR` probes the shared server, finds none of those panes, and closes every worker in the spike store. The data-shaped fix records the socket path on each `agents` row at spawn and refuses to sweep rows whose socket does not match. It needs a migration.

**Second residual, opened by issue #27's L4 fix round R9, todo 176.** A lead row used to be immortal (the janitor exempts `kind='lead'`, `agent_close` refused it outright), so `hive restore` could only ever GUESS at a lead's liveness before deciding whether the store was in use - and every guess (todo 165, then todo 173) failed a different way. R9 stopped guessing: `hive restore` now counts any running lead row as in-use unconditionally, with no probe at all, and `agent_close` gained the retirement path that makes that safe - it closes a lead whose pane is CONFIRMED dead. But "confirmed dead" still means `isLive()`, which still resolves through this same cross-server blind spot: a caller on the wrong tmux server calling `agent_close` on a lead whose real pane lives elsewhere gets a false "dead" (`targetLive` answers `false`, not `null`, because the wrong server genuinely has no such pane) and retires a row that is actually still running. Before R9 this was unreachable - `agent_close` refused every lead, full stop - so this is a new, narrow surface, not an old one widened. Accepted for the same reason as the first residual: the real fix is the same socket-on-the-row migration.

**R9's own residual text overclaimed here, and R10's todo 181 item 1 is the correction, not a widening.** R9 wrote "closing this one deliberately (a human choosing to run `agent_close` on a specific, named lead)" as if that were already true. It was not: nothing checked who the caller was, so any WORKER could call `agent_close(name: "lead")` exactly like a human at a terminal, including hitting the cross-server false-dead case above against a lead it has no business touching at all. `agent_close` now refuses outright - before probing liveness, so this applies whether the target reads live, dead, or unprobed - whenever `currentActor()` starts with `agent:`. A plain claude session is `user:<name>` and a peer lead is `lead:N` (`src/context.ts`), so a human at a terminal and a peer lead both keep the retirement path; only a spawned worker loses it. The cross-server false-dead residual above still stands for the callers who keep the path - it is a caller-KIND gate, not a liveness-TRUTH fix, and that is still the socket-on-the-row migration's job.

## tmux session names are namespaced by data store

Project ids are SQLite row ids, unique only within one store, while tmux session names share one machine-wide namespace. `sessionName()` tags the name when `HIVE_DATA_DIR` is not the default; the default store keeps the documented `hive-<project_id>`.

Never derive a session name from a project id alone. A scratch store numbers its first project 1 too, and would resolve to the live session of whatever real project is id 1. Naming goes through the same guard as opening: `dataDirTag()` is `tagFor(storeDir())`. It was exempt for one commit on the grounds that building a string touches no disk, which answered the wrong question, since a session name is the target argument for `kill-session` and `respawn-pane`.

## Aliveness checks use `list-panes`

`display-message -t` silently falls back to a default target when the given one is dead.

## Never type into a pane that is waiting on a choice

Delivery is a paste followed by Enter. A pane showing a modal has nowhere to put the paste and reads the Enter as "choose the highlighted option", so the wake vanishes, no user turn is created, and hive answers a prompt nobody read.

A pane that is merely BUSY is fine. Claude queues the paste and delivers it as a user turn when the turn ends; that was verified twice against the transcript on disk. Busy is not modal, and conflating them sends you fixing the wrong thing.

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

**Open residuals.** A pane sitting on a dialog forever holds its wake forever, including past `max_wait_at`. And the check-to-Enter race is real: the screen is read, then the Enter follows 300ms after the paste, so a dialog raised in that gap still gets answered. Closing it needs delivery to stop meaning "typed at a terminal".

## Two shell traps

- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings. Target a session by id when its name starts with `=`.
- **Never run `tmux kill-server`.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>`.
