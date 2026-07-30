import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DATA_DIR, dataDirTag, isDefaultStore, storeDir } from "./dataDir.js";

// tmux's stderr is the only thing that says whether tmux answered at all, and
// callers have to tell "tmux told me the target is gone" from "tmux never
// answered". Carry the text on the error instead of flattening it into a
// message string.
export class TmuxError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly notInstalled = false,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

export function tmux(...args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\n$/, "");
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer | string; message?: string };
    if (err.code === "ENOENT") {
      throw new TmuxError(
        "tmux is not installed. Install it (brew install tmux) to use agent tools.",
        "",
        true,
      );
    }
    const detail = typeof err.stderr === "string" ? err.stderr.trim() : err.stderr?.toString().trim();
    throw new TmuxError(`tmux ${args[0]} failed${detail ? `: ${detail}` : ""}`, detail ?? "");
  }
}

// tmux failed, but its answer says "there is nothing there". That is a fact
// about the world, not an unanswered probe, and callers act on it exactly as
// they act on a server that lists nothing.
//
// The distinction is load-bearing. tmux ships `exit-empty on`, so the server
// exits with its last session, which is precisely when stale rows need
// sweeping. Reading that as "unknown" leaves the janitor permanently disabled
// from the moment a hive session ends. See issue #14.
//
// Every string here was checked against a real tmux (3.7b) rather than
// assumed, since a wording this does not know reverts to "unknown" and stops
// the sweep:
//   no server running on <socket>   classic wording, still emitted
//   error connecting to <socket>    3.x: absent socket, stale socket, or a
//                                   socket path over the length limit
//   no current target               list-panes -a on a server with no
//                                   sessions (only reachable with
//                                   `exit-empty off`, which is exactly the
//                                   reachable-but-empty case issue #14 says
//                                   must keep sweeping)
//   can't find pane|window|session  a specific target the server looked for
//                                   and does not have
// tmux is not localized, so matching its English is stable.
const NOTHING_THERE = /no server running|error connecting to|no current target|can't find (pane|window|session)/;

export function tmuxSaysNothingThere(e: unknown): boolean {
  if (!(e instanceof TmuxError)) return false;
  // No tmux binary: nothing tmux manages can be alive either.
  if (e.notInstalled) return true;
  return NOTHING_THERE.test(e.stderr);
}

// Stays a plain boolean, unlike targetLive: its one caller asks "does this
// session exist" and falls through to new-session on false, which throws its
// own TmuxError if tmux is genuinely unreachable. Nothing is destroyed by
// guessing wrong here.
function quietTmux(...args: string[]): boolean {
  try {
    execFileSync("tmux", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// One wording for every write refused because this process is talking to a
// tmux server the store does not live on. Names both halves of the pairing and
// both ways out, the same shape as doctor's message: a refusal that says only
// "refused" sends someone hunting through source for the variable to change.
export function crossServerRefusal(action: string): Error {
  return new Error(
    `Refusing to ${action}: this process is talking to the tmux server at ` +
      `${tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)}, but hive is using its default ` +
      `store at ${DEFAULT_DATA_DIR}, whose sessions and panes live on ${defaultTmuxSocketPath()}. ` +
      "Anything written here records a pane id from the wrong server, where it can name an " +
      "unrelated live pane that agent_send would type into and agent_close would kill. Unset TMUX " +
      "and TMUX_TMPDIR to use the shared server, or set HIVE_DATA_DIR to a scratch store to go " +
      "with this one.",
  );
}

// Returns true when the session was created by this call.
//
// The refusal lives HERE, not at the callers, because this is the one function
// that creates a session on whatever server this process happens to reach.
// launchAgent has its own gate above its INSERT (so a refusal cannot strand a
// row), but hive lead and hive attach call this directly, and gating them
// individually would be two copies of a rule that belongs to the act of
// creating a session. hive attach was the visible half: under the bad pair it
// created a SECOND hive-1 on the private server and attached the user to an
// empty session while the real lead and its workers sat on the shared one.
export function ensureSession(name: string, cwd: string): boolean {
  if (quietTmux("has-session", "-t", `=${name}`)) return false;
  if (untrustedTmuxServer()) throw crossServerRefusal("create a tmux session");
  tmux("new-session", "-d", "-s", name, "-c", cwd);
  return true;
}

// A new session opens its first window with a default shell. The first real
// occupant (lead or agent) claims that window via respawn instead of leaving
// the shell behind as an idle pane. respawn-pane -e keeps the env flags
// pane-scoped; new-session -e would leak them into every later window.
export function claimInitialWindow(
  session: string,
  windowName: string,
  cwd: string,
  envFlags: string[],
  command: string,
): { pane: string; window: string } {
  const [pane, window] = tmux(
    "list-panes", "-t", `=${session}`, "-F", "#{pane_id} #{session_name}:#{window_id}",
  )
    .split("\n")[0]
    .split(" ");
  tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, ...envFlags, command);
  tmux("rename-window", "-t", window, windowName);
  return { pane, window };
}

export const SESSION_PREFIX = "hive-";
// dataDirTag is empty for the default store, so the everyday name stays the
// documented hive-<project_id>. A scratch store gets its own namespace; see
// src/dataDir.ts for why sharing one is dangerous.
//
// The name this returns is the target argument for kill-session and
// respawn-pane, so it is guarded exactly like opening the store: under a test
// runner with no HIVE_DATA_DIR this refuses rather than handing back "hive-1",
// which names a live session.
export const sessionName = (projectId: number) => `${SESSION_PREFIX}${dataDirTag()}${projectId}`;

// Window names double as iTerm tab titles (and notification labels), so they
// carry the project name: "hive - lead", "hive - worker-1".
export const windowTitle = (projectName: string, name: string) => `${projectName} - ${name}`;

// Pane targets are tmux pane ids (%N); everything else is session:window.
export const isPaneTarget = (target: string) => target.startsWith("%");

// Liveness that can say "I do not know". false means tmux answered and the
// target is not there; null means tmux never answered, and a caller that
// treats those the same destroys live state. That is issue #14, and it is why
// this is not a boolean.
export type Liveness = boolean | null;

// The question is which socket tmux will ACTUALLY use. Every earlier version
// of this answered a proxy question instead and was wrong in a new way each
// time, so it now computes the socket path outright and compares that.
//
// THREE INPUTS, IN TMUX'S OWN ORDER OF PRECEDENCE:
//
// 1. TMUX. Inside a pane tmux exports "<socket>,<pid>,<session>", and a tmux
//    client started there talks to THAT socket. It overrides TMUX_TMPDIR
//    completely. Measured, because this is the hole that shipped: inside a
//    `tmux -L hivespike` pane, bare tmux resolved to
//    /private/tmp/tmux-501/hivespike, and re-running it with TMUX_TMPDIR
//    pointed at a private directory STILL resolved to hivespike.
// 2. TMUX_TMPDIR, when tmux can reach it. tmux does not create it; handed one
//    it cannot reach it falls back. Measured: with TMUX_TMPDIR naming a missing
//    directory, `display-message -p '#{socket_path}'` answers the default
//    socket and the directory is still absent afterwards.
// 3. Otherwise /tmp, tmux's own default.
//
// Reading only input 2 was wrong in BOTH directions, and the tests could not
// see either because isolateTmux clears TMUX:
//   - Blind to `tmux -L spike`: TMUX_TMPDIR is unset there, so the guard read
//     "shared", and the janitor closed live ~/.hive rows whose panes are on the
//     shared server. That is the original bug through a different door.
//   - Refused a healthy setup: a pane on the SHARED server with a stray
//     TMUX_TMPDIR exported read "private", so hive would refuse to sweep a
//     machine where tmux is on the shared socket after all.
const DEFAULT_TMUX_TMPDIR = "/tmp";

const realpathOr = (path: string, fallback: string | null): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return fallback;
  }
};

const canonical = (path: string): string => realpathOr(path, path) ?? path;

// tmux keeps its sockets in <base>/tmux-<uid>/, and names the default one
// "default". hive never passes -L or -S, so the socket it would create or
// connect to is always <base>/tmux-<uid>/default.
const socketUnder = (base: string): string =>
  join(canonical(base), `tmux-${process.getuid?.() ?? 0}`, "default");

// The socket a tmux client started by THIS process would talk to. Pure in its
// inputs so it can be tested without touching the environment.
export function tmuxSocketPath(tmux: string | undefined, tmuxTmpDir: string | undefined): string {
  // Input 1: already an absolute path, written by tmux itself.
  const inherited = tmux?.split(",")[0];
  if (inherited) return canonical(inherited);
  // Input 2, but only when it is reachable; otherwise input 3.
  const reachable = tmuxTmpDir ? realpathOr(tmuxTmpDir, null) : null;
  return socketUnder(reachable ?? DEFAULT_TMUX_TMPDIR);
}

export const defaultTmuxSocketPath = (): string => socketUnder(DEFAULT_TMUX_TMPDIR);

export function privateTmuxSocket(tmux: string | undefined, tmuxTmpDir: string | undefined): boolean {
  return tmuxSocketPath(tmux, tmuxTmpDir) !== defaultTmuxSocketPath();
}

// Found 2026-07-29 during the #24 lane, by it happening to that lane's own
// worker: agent 40's row read "closed" while its pane was alive and working.
//
// A worker isolating tmux for a spike set TMUX_TMPDIR to a private dir and
// started a nested claude there, which inherited HIVE_DATA_DIR=~/.hive. Every
// claude session starts its own hive MCP server and every server runs the
// janitor, so that server probed the PRIVATE tmux for pane %3 and got an
// authoritative "no such pane". It then closed a live worker in the real store.
//
// This is not issue #14 and #14's fix cannot catch it. There, a probe FAILED
// and the fix was to tell "tmux did not answer" from "tmux says nothing is
// there". Here the probe SUCCEEDS: it reaches a real server and returns a
// correct answer to the wrong question. targetAlive("%3", snapshotOfSomeOther
// server) is false for exactly the same reason a genuinely dead pane is false,
// and there is nothing in the snapshot to tell them apart.
//
// Nor does the existing invariant cover it. "tmux session names are namespaced
// by data store" protects one tmux server reached from two stores, because
// project ids collide across stores. This is the inverse, one store reached by
// servers pointing at different tmux servers, and nothing namespaced it.
//
// So refuse. The unsafe pair is a PRIVATE tmux server plus the DEFAULT store,
// which has no legitimate use: hive's own sessions for the default store live
// on the shared server. Legitimate isolation sets both halves, a private tmux
// AND a scratch HIVE_DATA_DIR, and that keeps working untouched, which is what
// the whole test suite depends on. Enforced rather than documented, the same
// shape as storeDir() refusing the real store under a test runner.
//
// Refusing means answering "unknown", not "dead". Everything downstream
// already handles unknown conservatively because issue #14 made it: the
// janitor sweeps nothing, idle wakes do not fire on a watched agent looking
// gone, agent_close refuses instead of half-closing, and agent_send says the
// probe failed rather than telling a lead to destroy a live worker. One guard,
// carried everywhere by plumbing that already exists.
//
// Reads are only half of it. launchAgent in src/spawn.ts calls this too, and
// refuses, because the write path is what seeds the store with pane ids from
// the wrong server in the first place: an ungated spawn writes a private
// server's %0 into the shared store, where it can name an unrelated live pane.
// The first version of this comment called that "untidy but destroys nothing",
// which was wrong. See the note on launchAgent for the full trace.
export function untrustedTmuxServer(): boolean {
  if (!privateTmuxSocket(process.env.TMUX, process.env.TMUX_TMPDIR)) return false;
  try {
    // isDefaultStore, not ===: a symlink to ~/.hive is the real store, and
    // reading it as scratch would let this write pane ids from the wrong
    // server straight into the live database.
    return isDefaultStore(storeDir());
  } catch {
    // storeDir() refuses the real store outright when a test runner is the
    // entry point. A process that is not allowed to NAME this store is
    // certainly not allowed to decide its agents are dead, so treat the
    // refusal as untrusted rather than as permission to sweep.
    return true;
  }
}

// list-panes errors on a dead target; display-message would silently fall
// back to a default target and report success.
export function targetLive(target: string): Liveness {
  if (untrustedTmuxServer()) return null;
  try {
    tmux("list-panes", "-t", target);
    return true;
  } catch (e) {
    return tmuxSaysNothingThere(e) ? false : null;
  }
}

// One subprocess for the aliveness of every target at once; use this when
// checking many targets (the scheduler tick, agent_list) instead of one
// targetLive spawn per row.
export interface AliveSnapshot {
  panes: Set<string>;
  windows: Set<string>;
}

// An empty snapshot means tmux answered and nothing is alive; callers may act
// on it. null means tmux did not answer, liveness is unknown, and callers must
// not. No server is the first kind, not the second (see tmuxSaysNothingThere).
// Never throws: the scheduler is load-bearing (CLAUDE.md).
export function liveTargets(): AliveSnapshot | null {
  // A server this process must not draw conclusions from is the same answer as
  // a server that did not answer: unknown. See untrustedTmuxServer.
  if (untrustedTmuxServer()) return null;
  const snapshot: AliveSnapshot = { panes: new Set(), windows: new Set() };
  try {
    for (const line of tmux("list-panes", "-a", "-F", "#{pane_id} #{session_name}:#{window_id}").split("\n")) {
      const [pane, window] = line.split(" ");
      if (pane) snapshot.panes.add(pane);
      if (window) snapshot.windows.add(window);
    }
  } catch (e) {
    return tmuxSaysNothingThere(e) ? snapshot : null;
  }
  return snapshot;
}

export function targetAlive(target: string, snapshot: AliveSnapshot): boolean {
  return isPaneTarget(target) ? snapshot.panes.has(target) : snapshot.windows.has(target);
}

// tmux layout presets hive can apply to a window of split-placed workers.
export const WINDOW_LAYOUTS = [
  "tiled",
  "main-vertical",
  "main-horizontal",
  "even-horizontal",
  "even-vertical",
] as const;
export type WindowLayout = (typeof WINDOW_LAYOUTS)[number];
export const DEFAULT_LAYOUT: WindowLayout = "tiled";

export const isWindowLayout = (value: unknown): value is WindowLayout =>
  typeof value === "string" && (WINDOW_LAYOUTS as readonly string[]).includes(value);

// The main-* layouts give one pane the lead role. tmux picks it by position
// (the first pane in the window), not by name; the lead holds that spot
// because splits always append after it.
const MAIN_PANE_OPTION: Partial<Record<WindowLayout, { option: string; dimension: string }>> = {
  "main-vertical": { option: "main-pane-width", dimension: "#{window_width}" },
  "main-horizontal": { option: "main-pane-height", dimension: "#{window_height}" },
};

// Percentages for main-pane-width/height need tmux 3.4+; older versions type
// the option as a number and reject "50%". Fall back to half the window in
// cells so an old tmux still gets a lead-prominent layout.
function sizeMainPane(window: string, spec: { option: string; dimension: string }): void {
  try {
    tmux("set-window-option", "-t", window, spec.option, "50%");
    return;
  } catch {
    // Pre-3.4 tmux; fall through to cells.
  }
  // list-panes errors on a dead window instead of reporting another one's size.
  const cells = Math.floor(Number(tmux("list-panes", "-t", window, "-F", spec.dimension).split("\n")[0]) / 2);
  if (Number.isFinite(cells) && cells > 0) {
    tmux("set-window-option", "-t", window, spec.option, String(cells));
  }
}

// Arranging panes is cosmetic: a worker is already running by the time we get
// here, so a tmux that cannot do what we asked must not fail the spawn. The
// applied layout is stashed on the window so a later re-tile (agent_close)
// can restore it, including a per-spawn override that is not in hive.yml.
export function applyLayout(window: string, layout: WindowLayout): void {
  try {
    const main = MAIN_PANE_OPTION[layout];
    if (main) sizeMainPane(window, main);
    tmux("select-layout", "-t", window, layout);
    tmux("set-window-option", "-t", window, "@hive-layout", layout);
  } catch {
    // Leave tmux's own arrangement in place.
  }
}

// The layout hive last applied to this window, if any.
export function windowLayout(window: string): WindowLayout | null {
  try {
    const value = tmux("list-panes", "-t", window, "-F", "#{@hive-layout}").split("\n")[0];
    return isWindowLayout(value) ? value : null;
  } catch {
    return null;
  }
}

// The window a live pane belongs to. list-panes errors on a dead pane;
// display-message would answer for some other window instead.
export function paneWindow(pane: string): string | null {
  try {
    return tmux("list-panes", "-t", pane, "-F", "#{session_name}:#{window_id}").split("\n")[0] || null;
  } catch {
    return null;
  }
}

export function paneCurrentCommand(target: string): string | null {
  try {
    return tmux("display-message", "-p", "-t", target, "#{pane_current_command}");
  } catch {
    return null;
  }
}

export function capturePane(target: string, lines: number): string {
  const raw = tmux("capture-pane", "-p", "-t", target, "-S", `-${lines}`);
  const rows = raw.split("\n");
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.slice(-lines).join("\n");
}

// Todo 65. A pane showing a modal choice is not a pane you can deliver a
// message into, and typing into one anyway does something worse than losing the
// message: it answers the dialog.
//
// What happens, reproduced against claude 2.1.220 in a real pane. sendText
// pastes the body, which a dialog has nowhere to put and silently drops, then
// sends Enter, which a dialog reads as "choose the highlighted option". The
// input box is left EMPTY, no user turn is created, and the highlighted option
// is taken. In the reproduction that option was "1. Yes, I trust this folder";
// against a permission prompt it is whatever claude has highlighted, normally
// the one that says yes. hive would be approving things on the lead's behalf
// with the text of a wake-up.
//
// This is NOT the busy-pane case, which was the standing hypothesis and does
// not reproduce: a pane mid-turn queues the paste and delivers it as a user
// turn when the turn ends. Verified twice against the transcript on disk. Busy
// is fine. Modal is not.
//
// Matched on "Esc to cancel", which is the footer claude renders under every
// choice it is waiting on: the folder-trust prompt, the bypass-permissions
// confirmation and the tool permission prompt all carry it, and no ordinary
// prompt-box state captured during this work does. This is claude's chrome, so
// it is coupled to its version the same way awaitPrompt's markers are.
//
// Round 2, decision D5, superseding D4. This regex alone used to BE the
// answer to "is a dialog up"; it no longer is, because it is a bare substring
// match over a window that (since todo 72) holds up to 18 rows of
// WORKER-CONTROLLED transcript. A worker that greps for "Esc to cancel", or
// simply opens test/fixtures/panes/folder-trust-dialog.txt, renders that
// string in its own scrollback -- no dialog, just text -- and the old rule
// read it as one forever: agent_send would refuse indefinitely, telling the
// lead to clear a prompt that does not exist, since nothing about ordinary
// output ever scrolls a static screen away.
//
// The question was never "is this substring on screen". It is "is there an
// input box that would receive this paste". A modal REPLACES claude's input
// affordance rather than sitting beside it, so the two markers are mutually
// informative: INPUT_BOX_PRESENT (below) is what waitForPaneInput polls for
// as "claude has control and is not showing a modal", and CHOICE_DIALOG on
// its own only means "this text is somewhere on screen". A dialog is
// therefore CHOICE_DIALOG present AND INPUT_BOX_PRESENT absent -- see
// paneAwaitingChoice and paneChoiceCheck. Fixture-verified both ways:
// INPUT_BOX_PRESENT is absent from folder-trust-dialog.txt and
// model-picker-dialog.txt, present in ready-idle.txt and busy-mid-turn.txt.
//
// Both ways of being wrong were weighed and they are not symmetric. A false
// positive holds a wake (or refuses a tool call) for another tick/retry; a
// lead can see it pending. A false negative answers a dialog nobody read. So
// CHOICE_DIALOG stays the loose half of the pair on purpose -- narrowing IT
// would risk missing a real dialog whose wording drifts. INPUT_BOX_PRESENT is
// what carries the precision now, since a modal's defining property is what
// it replaces, not what footer text it happens to render.
const CHOICE_DIALOG = /Esc to cancel/;

// The marker claude renders under its own input box, and only there: present
// whenever claude has control of the terminal and is NOT showing a modal
// choice, absent from every modal screen captured for this project. Shared
// with waitForPaneInput's readiness probe below deliberately -- same chrome,
// one detector -- and reused here as D5's discriminator.
const INPUT_BOX_PRESENT = /╰|for shortcuts|shift\+tab to cycle/;

// D5: a screen is awaiting a choice when the dialog footer is present AND the
// input box is not -- see the comment above CHOICE_DIALOG for why the pair,
// not the footer alone, is the answer. One function so paneAwaitingChoice and
// paneChoiceCheck cannot drift onto two different definitions of "dialog".
const isAwaitingChoiceScreen = (screen: string): boolean =>
  CHOICE_DIALOG.test(screen) && !INPUT_BOX_PRESENT.test(screen);

// null means the pane could not be read, which is not the same as "no dialog".
// Callers decide; the scheduler treats it as go-ahead, because its liveness
// probe has already answered for this pane and holding a wake on a question
// nothing can answer is how issue #14 stranded every timer it touched.
//
// Todo 72. Captures tailCaptureLines() rows (18), not a smaller number of its
// own: this used to read 12, and the #27 lane's dialog-refusal call sites
// (agent_rename, agent_send) read 18 for their own reasons (see
// paneChoiceCheck below), which left two windows answering "is a dialog up"
// with no stated reason for the difference. Widening this one to match is
// safe on its own terms, not just for consistency: a bigger capture is a
// strict superset of a smaller one read at the same instant, so every screen
// the 12-line window used to catch it still catches, and the production
// verification this function already has -- a wake held 50 seconds against a
// real trust prompt on 2026-07-29 -- exercised a footer well within 12 lines,
// which is still well within 18. The D5 rewrite (round 2) is what makes the
// wider window safe to keep rather than just consistent: the false-positive
// cost that made "bigger is strictly safer" wrong for a bare CHOICE_DIALOG
// match evaporates once INPUT_BOX_PRESENT has to be absent too, since 18 rows
// of ordinary transcript containing "Esc to cancel" still has the input box
// on it.
export function paneAwaitingChoice(target: string): boolean | null {
  try {
    return isAwaitingChoiceScreen(capturePane(target, tailCaptureLines()));
  } catch {
    return null;
  }
}

// Typing is what makes a control byte dangerous, so the rule lives here, next
// to sendText and capturePane, rather than in whichever caller happened to
// need it first. src/tools/agents.ts encodes the same hazard for agent names
// and should read from here too; it is left alone for now only because it
// REJECTS rather than strips and sits outside this branch's diff.
//
// send-keys -l stops tmux interpreting key NAMES but passes a raw control byte
// straight through to the TUI, so a literal 0x03 arrives as Ctrl-C. And an ESC
// terminates the bracketed paste sendText wraps multi-line text in, so
// everything after it lands as keys rather than text. Newlines are kept: they
// are the one C0 byte a multi-line message needs, and paste-buffer carries
// them as text.
const TERMINAL_CONTROL_BYTES = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

export const stripControlBytes = (s: string): string => s.replace(TERMINAL_CONTROL_BYTES, "");

// How much of a captured pane is worth carrying somewhere it will be typed.
// Six lines reaches the status line claude keeps at the bottom of its pane and
// the line above it, which is where "waiting for N background agents" appears.
const TAIL_LINES = 6;
const TAIL_LINE_CHARS = 160;

// A pane tail, made safe to type into another terminal. This is the one thing
// hive sends that hive did not write: it is whatever the worker's screen
// happens to render. tmux renders a pane to a screen, so capture-pane output is
// normally already clean, which is exactly why this needs pinning by its own
// test - nothing reachable through a real pane would notice if it stopped
// working.
//
// Blank rows are dropped BEFORE the cap, so six lines is six lines of content
// rather than six rows of a mostly empty screen.
export function sanitizeTail(raw: string): string {
  return raw
    .split("\n")
    .map((line) => stripControlBytes(line).trimEnd().slice(0, TAIL_LINE_CHARS))
    .filter((line) => line !== "")
    .slice(-TAIL_LINES)
    .join("\n");
}

// Capture enough rows that sanitizeTail still has TAIL_LINES of content after
// dropping the blank ones a TUI leaves around its prompt box.
export const tailCaptureLines = (): number => TAIL_LINES * 3;

// Issue #27. A synchronous caller that refuses to type into a dialog (D1)
// needs both the yes/no answer and the tail for its receipt, and (since todo
// 72) both paneAwaitingChoice and this one read the same tailCaptureLines()
// window, so one capture correctly serves both instead of forking tmux twice
// for the same pane in the same call. null keeps paneAwaitingChoice's
// meaning: the pane could not be read, so callers proceed (D3) rather than
// reading it as "no dialog".
export function paneChoiceCheck(target: string): { awaitingChoice: boolean | null; tail: string } {
  try {
    const raw = capturePane(target, tailCaptureLines());
    return { awaitingChoice: isAwaitingChoiceScreen(raw), tail: sanitizeTail(raw) };
  } catch {
    return { awaitingChoice: null, tail: "" };
  }
}

// Round 2, D5. watchedTail (src/scheduler.ts) embeds a captured pane tail
// into a wake body, which is then typed into the LEAD's pane as a user turn.
// A worker sitting on a real dialog carries "Esc to cancel" in its tail, so
// without this the lead's own screen would end up containing the exact
// substring CHOICE_DIALOG matches, and the next tick's re-read of that pane
// (deliver() invalidates the choice cache on every delivery) would see it.
// D5 mostly closes this on its own, since the lead's pane also carries
// INPUT_BOX_PRESENT and so no longer reads as a dialog either way, but
// masking here is one line and removes the dependency on that holding
// forever: hive should not be able to trigger its own detector.
export function maskChoiceMarker(text: string): string {
  return text.replace(CHOICE_DIALOG, "[dialog marker masked]");
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// When nobody is watching a project's tmux session, pop open a native
// terminal attached in control mode so spawned workers appear on screen
// automatically. iTerm control mode (-CC) maps each tmux window to a native
// window/tab. Disable with HIVE_AUTO_ATTACH=0.
export function ensureAttached(session: string): void {
  if (process.platform !== "darwin" || process.env.HIVE_AUTO_ATTACH === "0") return;
  try {
    if (tmux("list-clients", "-t", `=${session}`).trim() !== "") return;
  } catch {
    return;
  }
  // iTerm runs the command directly (no shell, minimal PATH), so the tmux
  // path must be absolute; and shells would mangle a leading "=" anyway, so
  // pass the bare session name (tmux prefers exact matches).
  let tmuxPath: string;
  try {
    tmuxPath = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }
  const scripts = [
    `tell application "iTerm" to create window with default profile command "${tmuxPath} -CC attach -t ${session}"`,
    `tell application "Terminal" to do script "${tmuxPath} attach -t ${session}"`,
  ];
  for (const script of scripts) {
    try {
      execFileSync("osascript", ["-e", script], { stdio: "ignore", timeout: 8000 });
      return;
    } catch {
      // App missing or automation not permitted; try the next one.
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A TUI is not ready for input the instant its pane exists: keystrokes sent
// before it puts the terminal in raw mode sit in the pty buffer and can be
// swallowed. Poll the rendered screen for claude's input box instead of
// guessing a sleep. Returns false on timeout (or a dead pane), and callers
// must NOT type on a false: sending into a pane that has not taken the
// terminal loses the text silently and reports success.
export async function waitForPaneInput(target: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  // Each poll forks a tmux process. Claude is usually up within a second, so
  // poll tightly at first and back off after that rather than paying 40 forks
  // to wait out a timeout.
  const interval = () => (Date.now() - start < 1000 ? 200 : 500);
  while (Date.now() < deadline) {
    let screen: string;
    try {
      screen = capturePane(target, 30);
    } catch {
      return false;
    }
    // The prompt box border and the shortcuts hint both only appear once the
    // TUI has taken over the pane. This is claude's chrome, so it is coupled
    // to its version: if a redesign drops every marker, every spawn returns
    // false at the timeout and no worker gets its visible [hive] line. That
    // is loud rather than silent -- agent_spawn reports announced: false with
    // a note every time -- and the system-prompt brief still lands, so the
    // crew keeps working. It degrades, it does not hang, and it does not
    // pretend. If you are here because announced is always false, check this
    // regex against a current claude before changing the caller.
    //
    // Issue #30. claude 2.1.220 dropped both original markers: the input box
    // is now drawn with a straight rule rather than rounded corners, and the
    // hint line reads "... shift+tab to cycle ... for agents" rather than
    // "for shortcuts". Neither appears anywhere in a captured 2.1.220 ready
    // screen (test/fixtures/panes/ready-idle.txt), which is why every spawn
    // was timing out. INPUT_BOX_PRESENT (declared above, next to
    // CHOICE_DIALOG) is this same regex: shared rather than duplicated,
    // because round 2's D5 promoted it from a readiness hint to the thing
    // that tells a dialog from ordinary transcript, and one drifting out of
    // sync with the other would quietly break that pairing. The old markers
    // are kept alongside the current one in case an older claude on someone's
    // machine still renders them; they cost nothing since they never match
    // here.
    if (INPUT_BOX_PRESENT.test(screen)) {
      await sleep(250);
      return true;
    }
    await sleep(interval());
  }
  return false;
}

// tmux buffers are SERVER-GLOBAL, so a fixed buffer name is shared by every
// hive process talking to that server, and every claude session runs its own
// scheduler against one database.
//
// The interleaving: timers #7 and #8 come due in the same 3-second window in
// two different server processes. A claims #7 and B claims #8, both atomically
// and both correctly. Both call set-buffer with the same name; B's write lands
// second; A's paste-buffer -d types #8's body into A's pane and deletes the
// buffer; B's paste-buffer then fails with "no buffer", throws out of deliver,
// and is swallowed by tick's catch-all. Wake #8 is already fired_at, so no
// scheduler retries it: its text went to the wrong lead and its own delivery is
// gone for good.
//
// The race predates this branch. What the branch changed is how often it
// happens: watchedTail makes every wake with watched agents multi-line, so this
// path went from the rare case to the common one, which is why it is fixed here
// rather than left as a pre-existing bug. Unique per send, so two of them
// cannot collide even within one process.
let bufferSeq = 0;
const nextBufferName = () => `hive-input-${process.pid}-${++bufferSeq}`;

export async function sendText(target: string, text: string, submit = true): Promise<void> {
  if (text.includes("\n")) {
    const buffer = nextBufferName();
    tmux("set-buffer", "-b", buffer, "--", text);
    tmux("paste-buffer", "-d", "-p", "-b", buffer, "-t", target);
  } else {
    tmux("send-keys", "-t", target, "-l", "--", text);
  }
  if (submit) {
    await sleep(300);
    tmux("send-keys", "-t", target, "Enter");
  }
}
