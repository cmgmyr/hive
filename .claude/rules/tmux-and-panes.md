---
paths:
  - "src/tmux.ts"
  - "src/spawn.ts"
  - "src/scheduler.ts"
  - "src/tools/agents.ts"
  - "src/cli.ts"
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
- `agent_spawn`'s announcement, `agent_rename`'s `/rename`, and `agent_send`'s `text` path **REFUSE**. Each has a synchronous caller standing right there, so they return a receipt naming the dialog and carrying the pane's tail.
- `agent_send`'s `keys` path is **DELIBERATELY UNGUARDED against a dialog** and must stay so. `text` means "inject a user turn", which is what a dialog eats; `keys` means "drive this TUI on purpose", and pressing a key is the ONLY supported way to unstick a pane sitting on a dialog. Guarding it by symmetry would remove the one working escape hatch.
- **This refusal is a guardrail against a confused model, not a security boundary.** Do not extend this into refusing slash commands on the `text` path to close that gap - that is scope creep on an already-deep lane.
- **`captureRawPane`/`tailWindow` split one pane capture into two windows on purpose.** `paneAwaitingChoice` and `paneHasInputBox` read different ones; do not unify them "for consistency".

## A pane with unsubmitted human text holds its wake too

Only `pending` (real, human-typed text) holds. `ghost` must not, or every idle pane holds every wake forever. `unknown` must not either: a hold that silently starts firing on every unrecognised screen is worse than a detector that silently stops.

**`agent_send`'s text path and `agent_rename` REFUSE on the same condition.**

**`submit=false` is exempt, and that is a decision, not a gap.** The destructive event is the Enter, not the paste: a submitted merge sends a human's half-written sentence as a message he never finished and cannot take back, while `submit=false` leaves characters in a box where they are visible and editable - the `keys` category, drive-this-TUI-on-purpose, not inject-a-user-turn.

**THIS PROTECTION IS CLAUDE-CHROME-SHAPED, AND A NON-CLAUDE PANE HAS NONE OF IT.** In a worker spawned as `agent_spawn(name: "build", command: "bash")`, the send goes through. There the merge does not just submit a message, it **executes**: a human who typed `rm -rf ./buil` and walked away, plus an `agent_send(text: "npm test")`, is a shell running `rm -rf ./builnpm test`. `agent_rename` is the one path that cannot reach this, because it is gated on `isClaudeCommand` before it types; `agent_send`'s text path and the scheduler's delivery are not.

**The hold now has two reason strings sharing one prefix.** Code asking "is this an unsubmitted-input hold" must use the prefix predicate (`isUnsubmittedInputHold`), never an equality check against the plain constant, or it silently misses the transient retry variant.

## A tmux call that never answers is `null`, and it is a THIRD outcome

`execFileSync` with no `timeout` blocks for as long as the child runs, which against a wedged server is forever. Every call now carries a bound and `killSignal: "SIGKILL"`, since a wedged tmux is the process least likely to act on a SIGTERM.

**The bound is 10s and it is MEASURED, not felt.**

**What a timeout MEANS is the half that decides whether this is a fix or the same failure through another door.** `tmux()` used to have two outcomes: an answer, or a `TmuxError` that `tmuxSaysNothingThere()` classifies. A timeout is a third, and reading it as the second reaps live workers, which is the exact failure the bound exists to prevent. `TmuxTimeoutError` is a SUBCLASS of `TmuxError`, so every existing catch site keeps working.

**`HIVE_TMUX_TIMEOUT_MS` is testing only** (a 10s bound can only expire in real time), read at call time, and `hive doctor` reports it when set, because a knob that shortens a safety bound must not sit in an environment silently.

**IT BOUNDS THE DAMAGE AND LEAVES THE CAUSE OPEN.** `execFileSync`'s timeout kills the CHILD, not the tmux SERVER it was talking to, so a wedge now costs ten seconds per call instead of an hour of a core, and the wedged server keeps running. It REPORTS and never reaps.

## Three shell traps

- A leading `=` in a tmux target breaks when the string passes through zsh (path expansion). Safe in `execFileSync` arg arrays, unsafe in shell command strings. Target a session by id when its name starts with `=`.
- **Never run `tmux kill-server`.** It takes down whatever server the ambient env points at, which during development is the session the lead and workers are running in. Tear down with `kill-session -t =<name>`.
- **`-S` is overloaded.** In `tmux -S <path> ...` it names the socket. In `capture-pane -S -<n>` (`src/tmux.ts`'s `captureRawPane`/`inputBoxState`) it is the capture's START LINE, nothing to do with a socket. A check that scans nearby args for a bare `-S` to confirm a call is socket-pinned will misread a `capture-pane` start-line flag as one and silently stop refusing.

## All process execution goes through `execFileSync` with argument arrays

Never build a shell command string out of data.

`tmux()` in `src/tmux.ts` is the way to reach tmux, but it is **not the only path**, so do not read it as a coverage claim. Known others, not guaranteed exhaustive: `src/cli.ts`'s `attach()` calls `spawnSync("tmux", argv, { stdio: "inherit" })` twice (`:362`, `:373`) because it hands the terminal over rather than capturing output; doctor probes `execFileSync("tmux", ["-V"])` (`:1678`); and `ensureAttached` runs `execFileSync("osascript", ["-e", script])` (`src/tmux.ts:946`) where `script` comes from `attachScripts()` and **is a built string carrying the session name** - the one live exception to the sentence above, and the reason it is called out here rather than left to be discovered.

What those paths do NOT carry is what `tmux()` itself adds, which is exactly two things: the timeout bound, and `scratchStoreOnSharedSocket()`. **`untrustedTmuxServer()` is NOT one of them** - it is applied per call site (`ensureSession`, `targetLiveProbe`, `src/tmux.ts:416`, `src/spawn.ts:184`/`:295`, `src/cli.ts:1775`), so a NEW read path built on `tmux()` gets the timeout and the socket guard for free and still needs its own cross-server check. Pane titles, session names, agent names, wake bodies and `hive.yml` values all reach these calls, and every one of them is attacker-adjacent in the weak sense that matters here: they are typed by a human or written by a repo, not validated by hive.

## iTerm profile commands run with no shell and a minimal PATH

Auto-attach drives iTerm through AppleScript, and the command an iTerm profile runs does NOT get a login shell. It inherits a minimal `PATH` that does not include `~/.local/bin`, Homebrew, or any nvm or Herd directory, so a bare `hive` or `tmux` in one of those strings resolves to nothing and the failure surfaces as a window that opens and immediately dies.

Embed absolute binary paths in AppleScript strings. Resolve them at call time from the same place the dispatcher does rather than hardcoding a literal.

**hive cannot ensure the window it opens reaches ITS socket, so a process on a private one must not open one at all.** `attachScripts` emits neither `-L` nor `-S`, so the tmux the AppleScript shell runs resolves its socket from that shell's own environment.

**No shell does not mean no quoting.** `renderAttachCommand`'s shell-style quoting (`src/tmux.ts`) is therefore harmless on the iTerm branch and load-bearing on Terminal's `do script`, which really does run through the user's login shell.

See `.claude/skills/hive-internals` for the incidents, measurements, and mechanism behind these.
