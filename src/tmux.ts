import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { attachMode } from "./config.js";
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

// execFileSync's default maxBuffer is 1MB, which a dense capture-pane (many
// columns, heavy color/attribute use, "-e" widening every cell) can exceed.
// The failure mode without this is an uncaught ENOBUFS: tmuxSaysNothingThere
// does not match it, so it surfaces as an opaque tool error on a pane that
// was perfectly readable, rather than the TmuxError callers already know how
// to handle. 16MB comfortably covers even a wide, fully-attributed pane.
const TMUX_MAX_BUFFER = 16 * 1024 * 1024;

export function tmux(...args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: TMUX_MAX_BUFFER,
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

// Issue #73 counselors F3. `canonical()` above is right for a DIRECTORY - the
// only kind of path socketUnder() ever feeds it - but wrong for a full socket
// path, because the leaf ("default") is a live unix socket FILE tmux itself
// can transiently unlink and recreate with the server's identity completely
// unchanged. Calling canonical() on the leaf directly means a socket that
// happens to be mid-recreation at the exact moment this runs falls back to
// whatever RAW string TMUX handed us; every recorded value went through this
// same function already canonicalised, so the two representations of the
// IDENTICAL server (macOS's /tmp vs /private/tmp, for one) silently stop
// agreeing, and foreignSocket() reads every row as foreign until the leaf
// resolves again - the whole store looks foreign with no message saying why.
// Canonicalise only the CONTAINING DIRECTORY (mirroring socketUnder's own
// shape, which never touches the leaf either) and rejoin the two trailing
// segments verbatim: a directory is far more stable than the socket file
// living inside it, and this function itself stays a pure function of
// `path` alone.
//
// That is NOT the same as the predicate that USES it being independent of
// process.getuid() (counselors round 2, F3 - the previous wording here
// claimed exactly that, and it does not hold). foreignSocket() compares
// this value against defaultTmuxSocketPath(), and THAT side still rebuilds
// its uid segment from process.getuid() (socketUnder(), above) rather than
// reading it out of any path. The getuid() dependency did not leave the
// comparison; it moved to the other operand.
function canonicalSocketPath(path: string): string {
  const uidDir = dirname(path);
  const base = dirname(uidDir);
  return join(canonical(base), basename(uidDir), basename(path));
}

// The socket a tmux client started by THIS process would talk to. Pure in its
// inputs so it can be tested without touching the environment.
//
// Issue #73 counselors A1, accepted and recorded rather than fixed here. A
// socket PATH is a location, not a server identity: `TMUX` is
// `<path>,<server pid>,<session>` (counselors round 2 - this comment used to
// say "window index" for the third field, contradicting the correct format
// stated ~70 lines up; only the split below reads field 0, so nothing broke,
// but a file stating one wire format two ways is what a later reader trusts
// the wrong half of), and the split below keeps only `<path>`, discarding
// the pid. Two DIFFERENT tmux servers that happen to
// reuse the same socket path (the ordinary case across a reboot, since tmux
// always names the default socket `<base>/tmux-<uid>/default`) compare
// equal here. After a reboot, rows recorded on the old server read as
// non-foreign against the new one, pane ids restart at `%0` and collide
// with whatever the new server has already issued, and `agent_send` can
// type into the wrong pane believing it is the right one. This is
// PRE-EXISTING, not a regression this lane introduced - but this is the
// lane that closes the env-shaped half of the foreign-socket residual
// (`.claude/rules/tmux-and-panes.md`), so the claim has to be scoped
// truthfully rather than read as complete. What this function answers is
// "which socket path", never "which server" - closing that gap for real
// needs the pid (or the socket file's inode) recorded alongside the path,
// which is a second migration, not a one-line fix here.
export function tmuxSocketPath(tmux: string | undefined, tmuxTmpDir: string | undefined): string {
  // Input 1: already an absolute path, written by tmux itself.
  const inherited = tmux?.split(",")[0];
  if (inherited) return canonicalSocketPath(inherited);
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
//
// Issue #27's L4 fix round R10, todo 180 (the lead's own reproduction). An
// EMPTY target is not "no target given" to tmux; `list-panes -t ""` resolves
// to the CALLER's own current session and exits 0, confirmed against a real
// tmux. Every caller here uses "" to mean "no pane recorded yet" (a fresh
// lead row, a closed worker), so without this check an empty tmux_target
// read as permanently live: unretirable by agent_close, invisible to
// `hive doctor`, and a kill-pane against "" would hit whatever pane this
// process itself happens to be running in. Checked before the untrusted-server
// guard too - an empty target is never live regardless of which server
// answers.
export function targetLive(target: string): Liveness {
  if (target === "") return false;
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

// Issue #73, D2/D6. A ROW's own recorded socket disagreeing with the one this
// process would talk to is the same refusal untrustedTmuxServer() makes for
// the whole process, applied per-row instead: a pane id only means something
// relative to the server it came from, and a mismatch here means this row's
// pane was very likely recorded on, or has since moved to, a server this
// process cannot see into. '' is NOT foreign - it means "no fact recorded",
// true of every row written before this migration and of a timer whose
// deliver_actor names no agents row at all - and it behaves exactly as it did
// before this lane. Reading '' as foreign would silently stop the janitor
// sweeping every pre-upgrade row forever, trading a latent unsoundness for an
// immediate, silent regression (see the migration's own comment, src/db.ts).
//
// Counselors round 1 (#73, A4) proposed reading '' as foreign anyway, on the
// grounds that legacy rows stay exposed to the unsoundness until they drain.
// REJECTED: that restates D2's tradeoff above without engaging why the
// alternative is worse, and per this project's own runbook a suggestion
// that contradicts a recorded decision is not a finding unless it shows the
// existing reasoning fails. It does not. Behaviour unchanged.
export function foreignSocket(recorded: string): boolean {
  return recorded !== "" && recorded !== tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
}

// The row-level counterparts of targetLive/targetAlive: unknown the instant
// the row's own recorded socket says this process is looking at the wrong
// server, before tmux is ever asked about the target itself. D4 on
// plan-73-tmux-socket is the reason these return Liveness, never a plain
// boolean truthiness callers could coerce: a foreign row must read exactly
// like an unanswered probe to the janitor, deliverable() and every other
// caller that already knows how to hold rather than sweep on null. One place
// reads the predicate above, one place tests it.
export function rowLive(recordedSocket: string, target: string): Liveness {
  return foreignSocket(recordedSocket) ? null : targetLive(target);
}

export function rowAlive(recordedSocket: string, target: string, snapshot: AliveSnapshot): Liveness {
  return foreignSocket(recordedSocket) ? null : targetAlive(target, snapshot);
}

// tmux layout presets hive can apply to a window of split-placed workers.
// The tmux settings raw attach mode needs, and the doc that explains them.
//
// THIS IS THE ONLY COPY, DELIBERATELY. Three consumers read it and they used
// to be three independent transcriptions of the same advice: `hive setup
// --attach raw` and `hive doctor` print it (src/cli.ts), test/docs.test.mjs
// asserts docs/tmux.md explains every line of it, and test/layout.test.mjs
// derives the pane border it exercises from it. A copy in the test is the one
// that rots silently: change the recommendation and the CLI and the doc move
// together while the test goes on proving the OLD advice still works.
//
// It lives here rather than in src/cli.ts because it is tmux knowledge, and
// because a test importing dist/cli.js would drag the whole CLI's
// module-load-time store choice in with it.
export const RAW_ATTACH_TMUX_CONFIG = [
  "set -g allow-passthrough all",
  "set -g pane-border-status top",
  'set -g pane-border-format " #{pane_index} #{pane_title} "',
];
export const TMUX_DOC = "docs/tmux.md";

// The value RAW_ATTACH_TMUX_CONFIG recommends for one option, for a caller
// that has to act on it rather than print it. Returns null when the option is
// not in the block at all, so a caller can fail loudly instead of silently
// testing nothing.
export function recommendedTmuxOption(option: string): string | null {
  const line = RAW_ATTACH_TMUX_CONFIG.find((entry) => entry.startsWith(`set -g ${option} `));
  return line ? line.slice(`set -g ${option} `.length) : null;
}

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

// The glyph claude draws at the start of its input box, followed by NBSP
// (U+00A0) rather than an ordinary space -- confirmed against a real capture
// (test/fixtures/panes/ready-idle.txt), not assumed. Matching the pair, not
// the glyph alone, keeps this off any unrelated "❯" a worker's own output
// might render.
const PROMPT_GLYPH_NBSP = "❯ ";

const SGR_ESCAPE = /\x1b\[[0-9;]*m/g;

const stripSgr = (s: string): string => s.replace(SGR_ESCAPE, "");

// True when the leading run of SGR escapes -- the attributes claude applied
// to whatever comes right after the prompt, before any visible character --
// leaves faint (SGR 2) SET at the first visible cell. Counselors review on
// PR #37 (B1) caught the bug the first version of this had: it asked "does a
// '2' appear anywhere in the run", which fires even when a LATER escape in
// the same run cancels it. `\x1b[2m\x1b[22m` -- dim, then normal-intensity,
// which ink and chalk both emit to close a dim span -- renders as ordinary
// text, and queued-hint.txt already proves claude emits multi-escape leading
// runs, so a zero-width cancelled-dim marker ahead of real typed text is a
// realistic producer, not a hypothetical. Misreading that as "ghost" is the
// destructive direction: it would tell a lead a worker's real pending input
// is safe to overwrite.
// So this folds the run IN ORDER instead: 22, a bare 0 parameter, and the
// empty-parameter form ESC[m (SGR's default, also a full reset) all clear
// faint; 2 sets it. Parameters are read in the order they appear, including
// multiple parameters packed into one escape ("0;2").
function leadingRunIsFaint(s: string): boolean {
  const leadingRun = /^(?:\x1b\[[0-9;]*m)*/.exec(s)?.[0] ?? "";
  let faint = false;
  for (const seq of leadingRun.match(SGR_ESCAPE) ?? []) {
    const params = seq.slice(2, -1).split(";").filter((p) => p !== "");
    if (params.length === 0) {
      faint = false; // ESC[m: SGR's own default parameter is 0, a full reset.
      continue;
    }
    for (const p of params) {
      if (p === "0") faint = false;
      else if (p === "2") faint = true;
      else if (p === "22") faint = false;
    }
  }
  return faint;
}

export interface InputBoxState {
  state: "empty" | "pending" | "ghost" | "unknown";
  text: string;
}

// The horizontal rule claude draws as the input box's own top and bottom
// edge (see e.g. test/fixtures/panes/ready-idle.txt lines 45 and 47). A
// multi-line box grows DOWNWARD, pushing this rule further down the screen
// rather than adding a marker of its own, so it is the stop condition
// classifyInputBox scans for below.
const BOX_BORDER = /^─+$/;

// Issue #34's discriminator, and ONLY that: on the input-box's first row,
// text whose leading SGR run includes parameter 2 (faint) is not something
// anyone typed. A cursor-position rule was tried first and rejected -- it
// held for two cases and broke on a third, a dim hint whose cursor sat at
// neither the empty-box column nor the text's length. See the issue for the
// measurements; do not re-derive a different discriminator here.
//
// SGR 2 is common elsewhere on screen (the status line uses it for
// "[3h ago]" and for separators), which is why this only ever looks at the
// leading run of a row already scoped to the input box, never at "any dim
// text in the tail".
//
// Ghost suggestions and the queued-messages hint both render this way and
// both mean the same thing to a reader -- "not user input" -- so this does
// not try to tell them apart; both come back "ghost".
//
// MULTI-LINE (should-fix, counselors PR #37 S2). A wrapped or genuinely
// multi-line pending message grows the box past one row, and the first
// version of this only ever looked at the prompt row itself: a wrapped
// sentence was silently truncated to its first physical line with no
// marker, and -- the dangerous direction -- a multi-line message whose
// first LOGICAL line is empty (Enter pressed once before typing more) made
// the prompt row textless and reported "empty" while real text sat in the
// rows below it. Now scans forward from the prompt row, collecting
// continuation rows until BOX_BORDER (the box's own closing edge) or a
// genuinely blank row ends it, and only reports "empty" if NONE of them
// carry text either. The join is space-separated and does not reconstruct
// the original line breaks; this is a presence/content signal for a
// reader, not a byte-exact transcript.
//
// Control-stripped and length-capped (stripControlBytes, TAIL_LINE_CHARS)
// like every other pane-derived string that leaves this file, which the
// first version of this also skipped.
function classifyInputBox(rows: string[], promptRowIndex: number): InputBoxState {
  const promptRow = rows[promptRowIndex];
  const after = promptRow.slice(promptRow.indexOf(PROMPT_GLYPH_NBSP) + PROMPT_GLYPH_NBSP.length);
  const dim = leadingRunIsFaint(after);
  const firstLine = stripControlBytes(stripSgr(after)).trim();

  const continuation: string[] = [];
  for (let i = promptRowIndex + 1; i < rows.length; i++) {
    const stripped = stripControlBytes(stripSgr(rows[i])).trim();
    if (stripped === "" || BOX_BORDER.test(stripped)) break;
    continuation.push(stripped);
  }

  const text = [firstLine, ...continuation]
    .filter((line) => line !== "")
    .join(" ")
    .slice(0, TAIL_LINE_CHARS);
  return { state: text === "" ? "empty" : dim ? "ghost" : "pending", text };
}

// Bottom-up: the input box sits near the status line, not in scrollback, and
// only the LAST matching row reflects the pane's current state.
function findInputBoxRow(rows: string[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].includes(PROMPT_GLYPH_NBSP)) return i;
  }
  return null;
}

// Issue #34. Claude Code renders a dim, context-derived suggestion (and,
// separately, a "press up to edit queued messages" hint) inside an otherwise
// EMPTY input box. capturePane's plain "-p" throws away the one signal that
// tells either apart from real unsubmitted input: both render in SGR 2
// (faint), confirmed against a real pane. This reads with "-e" instead of
// adding it to capturePane itself, because capturePane's output rides into
// other panes verbatim (sanitizeTail feeds wake bodies and receipt tails),
// and raw escape bytes have no business riding along there. This capture is
// read, never typed anywhere.
//
// The current state of a pane's input box: real unsubmitted text, claude's
// own ghost/hint suggestion, empty, or unknown (below). null when the pane
// cannot be read, or when INPUT_BOX_PRESENT itself answers false, e.g.
// mid-turn or a modal dialog -- there is legitimately no box to report on.
//
// state: "unknown" (should-fix, counselors PR #37 S1) is a DIFFERENT
// failure from null, and collapsing them was itself a bug: INPUT_BOX_PRESENT
// true means claude has control and is not showing a modal, i.e. an input
// box IS on screen, so failing to find its prompt row (PROMPT_GLYPH_NBSP)
// means the chrome drifted -- claude changed how it draws the glyph or the
// NBSP -- not that there is nothing to report. Issue #30 is this exact
// failure shape for a different marker: a chrome change made every spawn's
// readiness check silently return false forever, indistinguishable from a
// slow pane, until someone went looking. Returning plain null here would
// repeat it: a caller cannot tell "box confirmed empty, nothing pending"
// from "the detector stopped working", and both currently read as absent
// from the receipt (inputBoxField omits a null the same as it would omit
// nothing at all). "unknown" is truthy and gets included, so drift is loud.
//
// GATED ON INPUT_BOX_PRESENT (counselors review on PR #37, B3): this used to
// trust the LAST row anywhere in the window containing the prompt pair, with
// no check that an input box is actually showing right now. That is
// findable, and hive is a source. watchedTail embeds a worker's tail into a
// wake body typed into the LEAD's pane; sanitizeTail only collapses a
// trailing EMPTY box, so a non-empty (ghost or real) row can land in the
// lead's own scrollback. If the lead's pane later shows a genuine permission
// dialog -- input box genuinely gone -- that stale row could still sit
// within this capture's window and get misread as the CURRENT box. It is
// also the D4 wedge repeating: `cat test/fixtures/panes/real-input.txt`
// renders this project's own fixture bytes into a worker's ordinary
// transcript, with nothing pending at all. D5 closed the same class for
// CHOICE_DIALOG by requiring the input box ABSENT; this closes it for the
// input box's own contents by requiring it PRESENT first.
//
// LABEL, DO NOT DELETE (decided on the plan pad): this is additive DATA
// alongside the ordinary tail, never a rewrite of it. agent_output's
// contract is "the rendered screen", and pending unsubmitted input is
// exactly what a reader needs to SEE when diagnosing a stuck pane; stripping
// it would make hive lie about the screen to fix a labeling problem. It
// fails soft: a misclassification is a wrong label sitting next to text the
// reader can still read for themselves, never a hidden line.
export function inputBoxState(target: string): InputBoxState | null {
  try {
    const raw = tmux("capture-pane", "-p", "-e", "-t", target, "-S", `-${tailCaptureLines()}`);
    if (!INPUT_BOX_PRESENT.test(raw)) return null;
    const rows = raw.split("\n");
    const promptRowIndex = findInputBoxRow(rows);
    return promptRowIndex === null ? { state: "unknown", text: "" } : classifyInputBox(rows, promptRowIndex);
  } catch {
    return null;
  }
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
// This is NOT the busy-pane case: a pane mid-turn shows no such footer, so it
// does not reproduce as MODAL, whatever else is true of it. Whether a busy
// paste eventually confirms once the target's turn ends is a SEPARATE,
// UNSETTLED question, and this comment used to answer it anyway: "Verified
// twice against the transcript on disk." .claude/rules/tmux-and-panes.md now
// names that exact sentence as the one that stayed wrong - a transcript
// proves the text ARRIVED, never that a user turn BEGAN, and a later
// measurement (wake 109, claude 2.1.220) found a busy paste enters the
// running turn as a `queued_command` attachment, firing no UserPromptSubmit,
// not a new turn. src/scheduler.ts's typed_busy comment (deliver()) already
// records that this file and the project's board reached opposite
// conclusions here and calls it unsettled - both sides resting on a single
// measurement - rather than settling it there; this file did not know that
// and is the one that stayed wrong. Not re-settled here either: the n=1 limit
// still stands on both accounts. Modal is not fine, regardless: nothing above
// this line depends on the busy question either way.
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

// A short, single-line field embedded INLINE inside a larger sentence hive
// itself authors, never typed alone - sanitizeTail's cousin for a value that
// is not a screen. Lives here, next to stripControlBytes and sanitizeTail,
// so tmux.ts stays the one place that decides what is safe to embed
// somewhere hive types; stateProvenance.ts's describeLastLogEvent() imports
// this rather than re-deriving it, and scheduler.ts's wake body and cli.ts's
// `hive status`/`hive doctor` printers all reach it that way, through the one
// formatter every one of them already calls, instead of three copies drifting
// apart the way lastLogEventSuffix and the CLI printers already had before
// this existed (round 2, both seats independently, plus Chris's decision to
// fix the CLI call sites in the same lane).
//
// Round 2 (both seats independently) found that capping the FORMATTED
// sentence - what this lane shipped first - caps the wrong string. The value
// this wraps, agent_state_log's `event` column, is process.argv[2] verbatim
// (src/hook.ts) with no validation, and every caller embeds it inside a FIXED
// template hive controls: "last log event: <this> (<age> ago)". Capping the
// finished sentence lets the attacker pad the EVENT half of it, pushing
// hive's OWN "(<age> ago)" suffix past the cap and out of the rendered text
// entirely - the true age is gone with no truncation marker, the exact
// forgery this function exists to prevent. A second shape (Codex): an event
// short enough to survive uncapped that itself CONTAINS the literal
// wrapping phrase, e.g. "notify (0s ago), last log event: stop", renders as
// two apparently genuine clauses.
//
// The fix is capping the EVENT ITSELF, before it is ever formatted, so
// hive's own suffix is always appended after whatever the attacker supplied
// and can never be pushed out. The cap is chosen SHORT enough that the
// forgery cannot fit AT ALL, not merely unlikely to: the shortest wrapping
// phrase any caller uses is "last log event: " (16 characters), and a
// minimal complete forgery needs that phrase plus at least one character of
// fake event, " (", one character of fake age, and " ago)" - about 25
// characters at an absolute minimum. Capping the raw event at
// EVENT_DISPLAY_CHARS keeps the ENTIRE forged template out of reach rather
// than just making it look odd. The real vocabulary (prompt/stop/notify) is
// 4-6 characters, so this costs nothing legitimate. A literal ", last log
// event:" fragment shorter than the cap can still appear verbatim in the
// rendered text; that is accepted rather than chased further; a value that
// starts with hive's own delimiter reads as garbled injection, not as a
// second clean clause with its own plausible age, and closing that
// completely would mean validating the event against a fixed vocabulary,
// which is a different, larger change than this lane makes.
//
// Truncation is marked, never silent, so a reader can tell a long event was
// cut rather than trust a suspiciously long value at face value.
const EVENT_DISPLAY_CHARS = 20;
export function sanitizeEventForDisplay(event: string): string {
  const clean = stripControlBytes(event).replace(/[\r\n]+/g, " ");
  return clean.length > EVENT_DISPLAY_CHARS ? `${clean.slice(0, EVENT_DISPLAY_CHARS)}[truncated]` : clean;
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

// Issue #72 fix round 1. paneChoiceCheck's `awaitingChoice` is a tri-state
// boolean (true/false/null), and a bare JSON `null` in a field named for a
// yes/no question cannot be told from `false` by a reader -- reachable with
// no tmux failure at all, since liveTargets() snapshots liveness once and a
// pane that dies between that snapshot and this function's own capture-pane
// call reports alive:true beside an unreadable pane. One function, used by
// every surface that renders this value, so hive status/doctor/agent_list
// cannot each spell the three states slightly differently and drift apart --
// the same reason describeForHuman exists in src/stateProvenance.ts.
export function describePaneChoice(awaitingChoice: boolean | null): string {
  if (awaitingChoice === true) return "awaiting a choice (dialog)";
  if (awaitingChoice === false) return "no dialog";
  return "could not be read";
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

// The one decision both attach sites make: does the iTerm-style branch carry
// -CC. "raw" and "control" answer outright; "auto" defers to whatever the
// caller's own iTerm detection found, which is what makes "auto" reproduce
// today's behaviour exactly at both sites (issue #81). Read at call time,
// same as attachMode() itself.
export function controlModeFor(iTermDetected: boolean): boolean {
  const mode = attachMode();
  if (mode === "raw") return false;
  if (mode === "control") return true;
  return iTermDetected;
}

// Pure, so the three modes are testable without an actual osascript. This
// branch is always the iTerm one, so iTermDetected is unconditionally true:
// "auto" here means what it always meant, -CC. "raw" drops it and keeps the
// app, running a plain attach through iTerm instead of opening a
// control-mode window. The Terminal fallback never carried -CC and stays
// that way regardless of mode; it is the fallback for a machine with no
// iTerm at all, not a second control-mode option.
export function attachScripts(tmuxPath: string, session: string): string[] {
  const cc = controlModeFor(true) ? "-CC " : "";
  return [
    `tell application "iTerm" to create window with default profile command "${tmuxPath} ${cc}attach -t ${session}"`,
    `tell application "Terminal" to do script "${tmuxPath} attach -t ${session}"`,
  ];
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
  for (const script of attachScripts(tmuxPath, session)) {
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

// Named and exported so a change here fails loudly in
// test/false-idle.test.mjs's dialog-ordering fixture instead of quietly
// shrinking the margin that fixture depends on (issue #55, todo 126 item 3).
export const ENTER_DELAY_MS = 300;

export async function sendText(target: string, text: string, submit = true): Promise<void> {
  if (text.includes("\n")) {
    const buffer = nextBufferName();
    tmux("set-buffer", "-b", buffer, "--", text);
    tmux("paste-buffer", "-d", "-p", "-b", buffer, "-t", target);
  } else {
    tmux("send-keys", "-t", target, "-l", "--", text);
  }
  if (submit) {
    await sleep(ENTER_DELAY_MS);
    tmux("send-keys", "-t", target, "Enter");
  }
}
