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
- `agent_send`'s `keys` path is **DELIBERATELY UNGUARDED** and must stay so. `text` means "inject a user turn", which is what a dialog eats; `keys` means "drive this TUI on purpose", and pressing a key is the ONLY supported way to unstick a pane sitting on a dialog. Guarding it by symmetry would remove the one working escape hatch.

The discriminator is `paneChoiceCheck()` / `paneAwaitingChoice()`. A dialog is the footer AND the absence of the input-box marker, never the footer alone: matching the footer alone was tried and broke, because a worker that greps for the string, or opens a captured fixture, renders it in its own transcript and gets refused forever with no real dialog to clear. A modal REPLACES claude's input affordance rather than sitting beside it, so the missing input box is the real signal. `INPUT_BOX_PRESENT` is shared by the readiness probe, this discriminator, and `input_box` reporting, and the three fail in opposite directions, so do not widen it.

The pane answer is cached per tick, and that cache is invalidated whenever hive delivers into a pane, because typing is the one thing inside a tick that can change the answer.

Pinned by `test/typing-guards.test.mjs` and `test/pane-fixtures.test.mjs`.

**Open residuals.** A pane sitting on a dialog forever holds its wake forever, including past `max_wait_at`. And the check-to-Enter race is real: the screen is read, then the Enter follows 300ms after the paste, so a dialog raised in that gap still gets answered. Closing it needs delivery to stop meaning "typed at a terminal".

## Two shell traps

- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings. Target a session by id when its name starts with `=`.
- **Never run `tmux kill-server`.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>`.
