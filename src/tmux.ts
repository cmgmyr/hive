import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { attachMode, AutoAttach, resolvedAutoAttach } from "./config.js";
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

// What a session start left behind: the ids of the window and pane THIS call
// created, or nothing when the session was already there. A discriminated
// union rather than `{created, pane?, window?}` so a caller cannot reach for
// a window id on the path where there is none (todo 278).
export type SessionStart = { created: true; pane: string; window: string } | { created: false };

// The refusal lives HERE, not at the callers, because this is the one function
// that creates a session on whatever server this process happens to reach.
// launchAgent has its own gate above its INSERT (so a refusal cannot strand a
// row), but hive lead and hive attach call this directly, and gating them
// individually would be two copies of a rule that belongs to the act of
// creating a session. hive attach was the visible half: under the bad pair it
// created a SECOND hive-main on the private server and attached the user to
// an empty session while the real lead and its workers sat on the shared one.
//
// Todo 278 (counselors codex #1), TWO CHANGES, both about what this function
// tells its caller.
//
// It RETURNS THE IDS IT CREATED. `new-session -P -F` prints the new session's
// first pane and window directly, so claimInitialWindow below no longer has to
// ask which window the session is showing - see its own comment for the lead
// this used to kill.
//
// It TREATS "duplicate session" AS SUCCESS BY SOMEONE ELSE. has-session-then-
// new-session is a check-then-act, and it used to be harmless only because
// racers had DIFFERENT session names (one session per project). Under one
// store-scoped session, two `hive lead` runs in different repos used to be
// able to both probe an absent session and both try to create it, and so
// could a `hive attach` racing either. The loser used to die with a raw
// "duplicate session: hive-main", which is tmux's answer to "it already
// exists", the same fact the probe above returns false for. Matched on
// tmux's own stderr (measured against tmux 3.7b: `duplicate session: base`),
// and narrow deliberately: any OTHER new-session failure still throws.
//
// DEFENCE IN DEPTH NOW, NOT A LIVE PATH - pad 79 T5's own review caught an
// earlier version of this comment claiming otherwise after `hive attach`
// moved inside the claim below it describes. Every production call
// (launchAgent, src/spawn.ts; cmdLead and cmdAttach, src/cli.ts) now reaches
// ensureSession from INSIDE withWindowClaim's cross-process exclusion
// (src/spawn.ts), which already serializes the has-session probe against the
// create for every caller this codebase has, so two of THESE three can no
// longer race each other into this catch at all. Kept anyway, and tested
// directly rather than only through the callers above
// (test/initial-window-claim.test.mjs, 10/10 under raceProcesses): the
// exclusion is per-store, not a property of ensureSession itself, so a
// future call site added outside a withWindowClaim section - a script, a
// second CLI command, anything that does not route through it - would hit
// this race for real and get tmux's raw stderr instead of the benign
// { created: false } this catch was built to hand back.
export function ensureSession(name: string, cwd: string): SessionStart {
  if (quietTmux("has-session", "-t", `=${name}`)) return { created: false };
  if (untrustedTmuxServer()) throw crossServerRefusal("create a tmux session");
  try {
    const [pane, window] = tmux(
      "new-session", "-d", "-P", "-F", "#{pane_id}\t#{session_name}:#{window_id}", "-s", name, "-c", cwd,
    ).split("\t");
    return { created: true, pane, window };
  } catch (e) {
    if (!isDuplicateSession(e)) throw e;
    return { created: false };
  }
}

// tmux's answer when new-session names a session that already exists. Split
// out so a test can pin the string against a REAL tmux error rather than a
// hand-built one: this is a match on another program's English, and the cost
// of it silently drifting is ensureSession rethrowing a race it is supposed to
// absorb. tmux is not localized, so matching its English is stable.
export function isDuplicateSession(e: unknown): boolean {
  return e instanceof TmuxError && /duplicate session/.test(e.stderr);
}

// A new session opens its first window with a default shell. The first real
// occupant (lead or agent) claims that window via respawn instead of leaving
// the shell behind as an idle pane. respawn-pane -e keeps the env flags
// pane-scoped; new-session -e would leak them into every later window.
//
// Todo 278 (counselors codex #1), THE MOST DESTRUCTIVE FINDING OF ITS ROUND.
// `start` is the pane and window ensureSession itself created, passed in.
// This used to identify "the initial window" by running
// `list-panes -t =<session>`, which resolves to the session's CURRENT window -
// not the one the caller made. Under one store-scoped session that is a
// different window the moment anyone else adds one, and `new-window` MAKES
// ITS RESULT CURRENT: project A creates the session, project B creates and
// stamps its own window in it before A gets here, and A's list-panes then
// resolves B's window. A overwrote B's stamp and ran `respawn-pane -k`,
// KILLING LEAD B and replacing it with lead A. Both lead rows then named one
// pane, and B's own liveness probe SUCCEEDED because that pane was alive, so
// B's sends and wakes went to A.
//
// Never ask which window is current. A pane id or a window id, always.
// projectId is REQUIRED, not optional, and `number | null` rather than
// `number | undefined` - deliberately, after a defect this asymmetry caused
// (found in /simplify review, todo 265/266): an optional parameter let one
// call site (launchAgent's createdSession branch, src/spawn.ts) forward a
// projectId already in scope to EVERY placement, stamping a placement="window"
// worker's own private window with the project's ownership stamp and handing
// a later `hive lead` or split-placed worker that private window to land in.
// A required parameter forces every call site to choose: a project's shared
// window passes its id, a worker's own dedicated window passes null,
// explicitly, and a future call site will not compile until its author
// decides which. Honest limit: this only binds TypeScript call sites: the
// .mjs test suite can still pass anything it likes. Worth having anyway,
// since TS is where the defect actually happened.
export function claimInitialWindow(
  start: { pane: string; window: string },
  windowName: string,
  cwd: string,
  envFlags: string[],
  command: string,
  projectId: number | null,
): { pane: string; window: string } {
  const { pane, window } = start;
  configureHiveWindow(window, true, projectId);
  tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, ...envFlags, command);
  tmux("rename-window", "-t", window, windowName);
  return { pane, window };
}

export const SESSION_PREFIX = "hive-";
// One session per STORE, not per project: every project in a store shares
// this session, one window each. dataDirTag is empty for the default store,
// so the everyday name is the documented hive-main. A scratch store gets its
// own namespace; see src/dataDir.ts for why sharing one is dangerous.
//
// The name this returns is the target argument for kill-session and
// respawn-pane, so it is guarded exactly like opening the store: under a test
// runner with no HIVE_DATA_DIR this refuses rather than handing back
// "hive-main", which names a live session.
export const sessionName = () => `${SESSION_PREFIX}${dataDirTag()}main`;

// A second `hive <path>` outside tmux, when the base session already has a
// client, attaches through its own VIEW SESSION instead of adding a second
// client to the base (two clients on one session share a current window and
// fight over it - pad 71 "SECOND PROJECT, SIDE BY SIDE INSTEAD", measured
// 2026-08-04). A view session owns no panes; it is a second session grouped
// with the base one (`new-session -t <base>`), so it borrows the base's
// windows with its OWN current-window pointer.
//
// Named by the invoking process's pid, which rules out a collision ACROSS
// processes - two pids are never equal. It does NOT rule out a collision
// against a view this SAME pid already created and left running: counselors
// on issue #117 found this reachable two ways. First, ensureAttached runs
// once per agent_spawn inside the long-lived MCP server process (one pid for
// the server's whole life), so a second spawn under auto_attach:"on" (which
// probes only the base session, and reads it as clientless while a human is
// actually watching through the first view - autoAttachProbe's own comment)
// issues new-session against the SAME name a moment after the first one
// created it. Second, the tmux client this name's session gets is a child of
// iTerm/Terminal, not of the process that named it, so the view can outlive
// the pid that created it and a later process can be handed that same pid
// back by the OS. Neither route is a same-process-in-flight race - a single
// process cannot run ensureAttached twice AT ONCE, since it is fully
// synchronous - so this is a genuine naming collision, not a concurrency bug.
export const viewSessionName = () => `${SESSION_PREFIX}${dataDirTag()}view-${process.pid}`;

// The collision-checked wrapper every session-CREATING call site uses.
// viewSessionName() above stays pure and unguarded (its own callers include
// tests and doctor's reporting, which need the deterministic first-attempt
// name, not one that mutates tmux to compute) - this is the only place that
// probes the live server and only when about to create a session. Bumps with
// a NUMERIC suffix, not a fresh scheme, so isViewSessionName's pattern only
// has to grow, not change shape; see that function's own comment.
function freeViewSessionName(): string {
  const base = viewSessionName();
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!quietTmux("has-session", "-t", `=${candidate}`)) return candidate;
  }
  throw new Error(`could not find a free view session name based on ${base} after 1000 attempts`);
}

// Recognizes ANY process's view session, not just this one's own -
// viewSessionName() above only ever builds the CURRENT pid's name. Doctor's
// stray-view-session report (todo 273) and restart-lead.sh's session
// derivation both need to tell "a view session" apart from the base session
// among a list of names already filtered to the hive- prefix, for a session
// this process did not create and whose pid it does not know. The suffix
// alone is enough - dataDirTag() can appear ahead of "view-", but never
// inside it - so this needs no dataDirTag() of its own, unlike viewSessionName.
// scripts/restart-lead.sh mirrors this exact suffix in bash rather than
// shelling out to node for it; keep the two in sync by hand if this changes.
//
// The trailing `(-\d+)?` is freeViewSessionName's bump suffix (issue #117):
// a name like `hive-view-4242-2` still has to read as a view, or
// restart-lead.sh's EXCLUDE-views filter would mistake a bumped view for the
// durable base session it is trying to isolate - the dangerous direction,
// since that filter's whole job is telling the two apart.
export const isViewSessionName = (name: string): boolean => /view-\d+(-\d+)?$/.test(name);

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
  return targetLiveProbe(target).live;
}

// Todo 336. { live, pid } from ONE list-panes call, not two: the pid a
// caller needs to tell a reissued pane from its predecessor (see
// PaneProbe's own comment) is answered by the same probe that already
// decides liveness, so a caller that wants both never pays for a second
// fork. pid is null whenever live is not true - there is nothing to read a
// pid off of, and a stale pid from a PRIOR probe would be exactly the kind
// of fact this file exists to stop rows from carrying.
export interface PaneProbe {
  live: Liveness;
  pid: string | null;
}

export function targetLiveProbe(target: string): PaneProbe {
  if (target === "") return { live: false, pid: null };
  if (untrustedTmuxServer()) return { live: null, pid: null };
  try {
    // `list-panes -t <pane>` lists every pane in that PANE'S WINDOW, not just
    // the one target - measured directly after this looked right and was not
    // (a two-pane window returned two rows, and the naive `[0]` picked
    // whichever pane tmux happened to list first, silently reporting a
    // SIBLING pane's pid). #{pane_id} in the format string is what tells the
    // rows apart; isPaneTarget matches targetAlive's own pane-vs-window
    // split immediately below. A window target has no single pane's pid to
    // report at all - null, the same "cannot judge" this file already
    // returns for a foreign socket, not a guess at which pane in it would
    // count.
    const rows = tmux("list-panes", "-t", target, "-F", "#{pane_id} #{pane_pid}")
      .split("\n")
      .map((line) => line.split(" "));
    const pid = isPaneTarget(target) ? (rows.find(([id]) => id === target)?.[1] ?? null) : null;
    return { live: true, pid };
  } catch (e) {
    return { live: tmuxSaysNothingThere(e) ? false : null, pid: null };
  }
}

// One subprocess for the aliveness of every target at once; use this when
// checking many targets (the scheduler tick, agent_list) instead of one
// targetLive spawn per row.
export interface AliveSnapshot {
  panes: Set<string>;
  windows: Set<string>;
  // Todo 336. Populated from the same list-panes call as panes/windows, so a
  // caller that already has a snapshot gets every pane's current pid for
  // free - no second fork. Absent from the map (not just falsy) for any
  // pane not in the snapshot at all, i.e. dead or foreign.
  pids: Map<string, string>;
}

// An empty snapshot means tmux answered and nothing is alive; callers may act
// on it. null means tmux did not answer, liveness is unknown, and callers must
// not. No server is the first kind, not the second (see tmuxSaysNothingThere).
// Never throws: the scheduler is load-bearing (CLAUDE.md).
export function liveTargets(): AliveSnapshot | null {
  // A server this process must not draw conclusions from is the same answer as
  // a server that did not answer: unknown. See untrustedTmuxServer.
  if (untrustedTmuxServer()) return null;
  const snapshot: AliveSnapshot = { panes: new Set(), windows: new Set(), pids: new Map() };
  try {
    for (const line of tmux(
      "list-panes", "-a", "-F", "#{pane_id} #{pane_pid} #{session_name}:#{window_id}",
    ).split("\n")) {
      const [pane, pid, window] = line.split(" ");
      if (pane) snapshot.panes.add(pane);
      if (pane && pid) snapshot.pids.set(pane, pid);
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

// Todo 336. Read time, for a pane already confirmed live: the pane's
// CURRENT pid, straight from a snapshot's own map, no second probe.
//
// `snapshot.pids?.` rather than a bare `snapshot.pids.`, deliberately: many
// existing tests (standing-watch, wake-hold-notify, delivery-state, probe,
// scheduler, tmux-socket-foreign) construct a synthetic `{panes, windows}`
// snapshot literal by hand and pass it straight to `tick()`, a convention
// this file's own comments call out as deliberate (see liveTargets()'s
// docstring and test/scheduler.test.mjs). TypeScript's AliveSnapshot type
// requires `pids`, but an untyped .mjs literal can still omit it, the same
// tension `configureHiveWindow`'s `projectId` argument already has - and the
// resolution is the same: a caller that never mentions pid identity reads as
// "no fact recorded" for every pane, not as a crash. Measured: without the
// `?.`, four pre-existing suites threw `Cannot read properties of undefined
// (reading 'get')` inside deliverable(), caught by tick()'s own per-candidate
// guard, and the SYMPTOM was an unrelated assertion failing several lines
// later - the thrown TypeError itself never surfaced in any of those diffs.
export function targetPid(target: string, snapshot: AliveSnapshot): string | null {
  return snapshot.pids?.get(target) ?? null;
}

// Todo 336. Write time: capture a just-recorded pane's pid to store
// alongside its id, so a LATER read can tell the pane apart from whatever a
// server restart reissues its id to. list-panes, not display-message - see
// targetLiveProbe/paneWindow's own comments on why display-message silently
// answers for the wrong target on a dead one. "" (never null) matches the
// column's own DEFAULT '' convention (src/db.ts): a failed read here must
// read exactly like a pre-migration row, "no fact recorded", not "recorded
// as absent".
export function panePid(target: string): string {
  return targetLiveProbe(target).pid ?? "";
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

// Todo 336. The row-level, pid-aware counterparts of the pair above, for a
// caller that needs to tell "the pane we meant" from "a pane the server
// reissued this id to" - see deliverable()'s own comment in src/scheduler.ts
// for the one caller today. Same foreign-socket bias as rowLive/rowAlive: a
// row this process cannot honestly judge answers { live: null, pid: null },
// never a pid read against the wrong server's pane.
export function rowLiveProbe(recordedSocket: string, target: string): PaneProbe {
  return foreignSocket(recordedSocket) ? { live: null, pid: null } : targetLiveProbe(target);
}

export function rowAliveProbe(recordedSocket: string, target: string, snapshot: AliveSnapshot): PaneProbe {
  if (foreignSocket(recordedSocket)) return { live: null, pid: null };
  const live = targetAlive(target, snapshot);
  return { live, pid: live ? targetPid(target, snapshot) : null };
}

// Issue #149 (todo 348). Shared by src/scheduler.ts's janitor() agents sweep
// and its deliverable() pane-identity check: a pane the current tmux server
// reissued to someone else after a restart reads LIVE, not dead, so
// `rowAlive(...) === false` cannot see it - the fact PIDs exist to catch.
// One function, defined next to PaneProbe/rowAliveProbe rather than in a
// consumer file, so a future caller of this file's pane-identity primitives
// finds it here instead of re-deriving the same comparison - the same
// reasoning CHOICE_DIALOG's own comment gives for the sibling dialog/
// input-box discriminators (.claude/rules/tmux-and-panes.md).
//
// True only when a pane genuinely EXISTS but is not the one this row was
// recorded against - never when it is simply gone (probe.live is false or
// null, the ordinary dead/unknown branches handle those) and never when
// either side has no fact to compare: recordedPid === "" is a pre-migration
// row or one written before this column existed, and probe.pid === null
// means live did not read true or the read raced a close. Both must stay
// "cannot judge, proceed as before this check existed" - an upgrade must not
// start holding or closing every pre-existing row in every store.
export function paneReissued(recordedPid: string, probe: PaneProbe): boolean {
  return probe.live === true && recordedPid !== "" && probe.pid !== null && probe.pid !== recordedPid;
}

// tmux layout presets hive can apply to a window of split-placed workers.
// The tmux settings raw attach mode needs, and the doc that explains them.
//
// THIS IS THE ONLY COPY, DELIBERATELY. Three consumers read it and they used
// to be three independent transcriptions of the same advice: `hive setup
// --attach raw` prints it (src/cli.ts), test/docs.test.mjs asserts docs/tmux.md
// explains every line of it, and `hive doctor` points to that same document.
// A copy in a consumer is the one that rots silently: change the recommendation
// and the CLI and the doc can otherwise drift independently.
//
// It lives here rather than in src/cli.ts because it is tmux knowledge, and
// because a test importing dist/cli.js would drag the whole CLI's
// module-load-time store choice in with it.
export const RAW_ATTACH_TMUX_CONFIG = [
  "set -g allow-passthrough all",
];
export const TMUX_DOC = "docs/tmux.md";

// Hive configures only windows it created. The marker is the boundary: a
// split can deliberately land in a window the user made, and a pane border
// would take a row from that window. `created` is true only at the window-
// creation sites, where the marker and options are applied before the real
// process is respawned into the window. Later callers must prove the marker
// is already present. All of this is cosmetic/best-effort; a running worker
// without these settings is better than a failed spawn.
//
// projectId stamps @hive-project-id alongside @hive-owned - the ownership key
// cmdLead and splitTargetWindow look a project's SHARED window up by, instead
// of by window NAME (decisions/2026-08-05-tmux-topology-windows-not-sessions.md).
// REQUIRED, not optional, and `number | null` - deliberately, after a defect
// this asymmetry caused (found in /simplify review, todo 265/266): an
// optional parameter let one call site forward a projectId already in scope
// to every window it created regardless of whether that window was the
// project's SHARED one, stamping a worker's own PRIVATE window
// (placement="window") with it and handing a later lookup that private
// window to land in. Pass null for a window that must never resolve as
// anyone's shared window - a worker's own placement="window" window is
// exactly that case. No default value, deliberately, so every TypeScript
// call site states its choice; a caller from the untyped .mjs test suite can
// still omit it, and the runtime check below treats that the same as null.
// Honest limit: this only binds TypeScript call sites, same caveat as
// claimInitialWindow's.
export function configureHiveWindow(window: string, created: boolean, projectId: number | null): void {
  try {
    if (!created) {
      // list-panes errors when the target is dead. display-message silently
      // falls back to another window, which could borrow that window's marker
      // and turn a stale target into apparent permission to write.
      const owned = tmux("list-panes", "-t", window, "-F", "#{@hive-owned}").split("\n")[0];
      if (owned !== "1") return;
    }
    // One tmux client, not five. The suite creates many windows concurrently;
    // separate clients exhausted macOS's process/PTY capacity and made a later
    // unrelated respawn fail. `;` is tmux's own command separator argument,
    // still passed through execFileSync with no shell involved.
    tmux(
      ...(created ? ["set-window-option", "-t", window, "@hive-owned", "1", ";"] : []),
      // != null (not !==) catches both null (an explicit "never stamp this
      // window") and undefined (an untyped .mjs caller that omitted the
      // argument entirely) the same way.
      ...(created && projectId != null
        ? ["set-window-option", "-t", window, "@hive-project-id", String(projectId), ";"]
        : []),
      "set-window-option", "-t", window, "allow-passthrough", "all", ";",
      "set-window-option", "-t", window, "pane-border-status", "top", ";",
      "set-window-option", "-t", window, "pane-border-format", " #{pane_index} #{pane_title} ", ";",
      "set-window-option", "-t", window, "monitor-bell", "on", ";",
      // `latest` (tmux's default) sizes a window to whoever focused it last,
      // so two clients on the same window (a base client and a view client,
      // above) fight over its size. `smallest` is identical to today's
      // behaviour with one client and only differs once a view session
      // exists. `manual` was considered and rejected (lane 1): it freezes the
      // window and stops following a resize even with a single client.
      // Chris accepted the letterboxing this trades in deliberately: it is a
      // visible signal that a view session is open, not a bug to fix later.
      "set-window-option", "-t", window, "window-size", "smallest",
    );
  } catch {
    // Leave the window and its process usable with tmux's existing settings.
  }
}

// A project's SHARED window in the one store-scoped session, found by its
// @hive-project-id ownership stamp - never by window name (decisions/2026-
// 08-05-tmux-topology-windows-not-sessions.md). cmdLead (src/cli.ts) and
// splitTargetWindow (src/spawn.ts) both call this; extracted (/simplify
// review, item 3) after they carried a character-for-character identical
// lookup and two copies of the justification below.
//
// #{@hive-project-id} is a WINDOW-scope custom option read directly at
// window scope via list-windows -F - not the M7 trap on pad 71, which is
// specifically about reading a window-scope value through a PANE-scope
// show-options query without -A. Measured live against a real tmux (this
// comment's claim, not just pad 71's): show-options -w, with or without -A,
// and list-windows -F all agree once a value is set at window scope: -A
// only matters descending from window to pane scope, never at matching
// scope. No -A appears below because this query never descends.
//
// cmdLead's own call site carries a SEPARATE comment about what its
// stillThere check depends on this lookup being ownership-derived - that
// comment stays there, not here: it is about cmdLead's restart path, not
// about this lookup in general, and splitTargetWindow has no stillThere to
// protect.
// The raw fetch half of findProjectWindow below, split out for a caller that
// matches against it repeatedly rather than once - `hive status`'s cmdStatus
// loops over every project in the store, and sessionName() names the same
// one session for all of them, so forking list-windows inside that loop
// forks the identical listing once per project where one fork would do
// (cli.ts hoists this above its own loop and matches per project against
// the single result, the same pattern its own hiveSessions() already uses
// for doctor's two session-report consumers).
export function listOwnedWindows(session: string): [string, string][] {
  return tmux(
    "list-windows", "-t", `=${session}`, "-F", "#{session_name}:#{window_id}\t#{@hive-project-id}",
  )
    .split("\n")
    .map((row) => row.split("\t") as [string, string]);
}

export function findProjectWindow(session: string, projectId: number): string | undefined {
  return listOwnedWindows(session).find(([, ownerId]) => Number(ownerId) === projectId)?.[0];
}

// The inverse of findProjectWindow: not "which window does this project own"
// but "which project does this window carry the stamp for". Todo 268 -
// launchAgent's split branch needs this to tell whether a worker's pane just
// landed in a window a DIFFERENT project owns (the cross-repo case: a worker
// recorded under project 9's parent lead lives in project 1's window), so
// the spawn receipt can say so rather than leaving a caller to reconstruct it
// from project_id, which is exactly the field it cannot reconstruct.
// show-options errors ("invalid option") on a custom option never set
// anywhere on this window, rather than answering empty - same as
// configureHiveWindow leaving @hive-project-id unset for a placement="window"
// worker's own window (null passed there, deliberately). Read that as "no
// owner", same as an empty stamp.
export function windowOwner(window: string): number | null {
  try {
    const value = tmux("show-options", "-w", "-v", "-t", window, "@hive-project-id");
    return value === "" ? null : Number(value);
  } catch {
    return null;
  }
}

// Todo 276 (counselors opus #2). The window a lead's PREVIOUS pane is sitting
// in, when that window is one this project may take back - or null when it is
// not. Liveness is the caller's question (rowLive, at the call site); this
// answers the ownership half, and it is an EXCLUSION rather than a
// membership requirement.
//
// The distinction is the whole finding. cmdLead used to prove ownership by
// requiring the pane to be a member of findProjectWindow's result, and read a
// failed membership test as "the pane is gone" - a biconditional nothing
// supports. A lead pane that merely MOVED (`tmux break-pane` to get it
// full-screen, or the topology upgrade) is live, socket-matching and
// correctly recorded, and still failed that test, so cmdLead split a SECOND
// claude in beside it under the same HIVE_AGENT_ID. Membership PROVING
// ownership was sound; failed membership proving death was not.
//
// Two things have to hold for the pane's window to be adoptable, and they are
// both narrower than "any live pane":
//   - the window is one of THIS store's session's own windows. A pane
//     stranded in an old per-project session (hive-<project.id>, the accepted
//     cross-upgrade residual at cmdLead's own call site) is live and is still
//     not adoptable: nothing in this store points at that session any more.
//   - the window carries no ownership stamp, or carries THIS project's. A
//     stale target pointing into ANOTHER project's window stays refused,
//     which is the property test/lead-window-ownership.test.mjs pins.
//
// The returned target is re-qualified with the BASE session's own name rather
// than whatever session paneWindow() happened to report. list-panes resolves
// a pane's `#{session_name}` to ANY session the window belongs to, and once a
// view session is grouped with the base it can and does answer with the
// VIEW's name (measured against tmux 3.7b: a pane created in `base` reported
// `view1:@1` while view1 existed). A view is transient; a target carrying its
// name outlives it by seconds. Only the window id is load-bearing here, so
// only the window id crosses back out.
export function adoptableWindow(session: string, projectId: number, pane: string): string | null {
  const paneWin = paneWindow(pane);
  if (!paneWin) return null;
  const windowId = paneWin.split(":")[1];
  const match = listOwnedWindows(session).find(([window]) => window.split(":")[1] === windowId);
  if (!match) return null;
  const owner = match[1] === "" ? null : Number(match[1]);
  if (owner !== null && owner !== projectId) return null;
  return `${session}:${windowId}`;
}

// A window created directly - not the session's already-existing first
// window (claimInitialWindow, above, is for that) - stamped and launched in
// one step. The sibling of claimInitialWindow for every OTHER window hive
// creates: cmdLead's fresh window for a project with no window yet in the
// shared session, launchAgent's placement="window" worker windows, and
// launchAgent's own split branch when splitTargetWindow finds no existing
// window for the project. Extracted (/simplify review, item 4) after three
// near-identical copies of this exact sequence - new-window -P -F,
// destructure, configureHiveWindow, respawn-pane -k - which is precisely the
// drift buildEnvFlags' own comment (src/spawn.ts) already recorded this
// codebase getting bitten by once: a var added to one copy and not the
// others. One of the three copies used a bare session name rather than
// `=${session}` for -t; standardised on the `=` form here, matching every
// other session target in this file, since a bare name lets tmux's fuzzy
// session-name matching pick a different session than the one meant -
// harmless today (session names are unique in practice) but not a
// distinction worth keeping once there is only one copy of this to write.
export function createWindow(
  session: string,
  windowName: string,
  cwd: string,
  envFlags: string[],
  command: string,
  projectId: number | null,
  // Todo 316: an undetached new-window switches the session's (and any
  // attached client's) current window to it, which is the
  // placement="window" half of that todo - a human looking at one tab gets
  // yanked onto the worker's the instant it spawns. launchAgent's two
  // callers (src/spawn.ts) pass true so a background spawn cannot move a
  // human's tab. Defaults to false: cmdLead's fresh-lead-window caller
  // (src/cli.ts) does not need it either way, since it always runs its own
  // explicit attach()/select-window right after regardless of which window
  // new-window left current - but changing the default would still break
  // callers that build multi-window fixtures on top of it and depend on the
  // unchanged behaviour: initial-window-claim.test.mjs's intruder-window
  // fixture (todo 278, its own "fixture check" test asserts new-window's
  // default directly) and view-session.test.mjs/attach-view-race.test.mjs's
  // multi-window setups.
  detach = false,
): { pane: string; window: string } {
  const created = tmux(
    "new-window", ...(detach ? ["-d"] : []), "-P", "-F", "#{pane_id}\t#{session_name}:#{window_id}",
    "-t", `=${session}`, "-n", windowName, "-c", cwd,
  );
  const [pane, window] = created.split("\t");
  configureHiveWindow(window, true, projectId);
  tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, ...envFlags, command);
  return { pane, window };
}

// The decision and mechanics behind a second real terminal's `hive <path>`
// attach, outside tmux (src/cli.ts's `attach()`). Extracted so a test can
// drive the actual function two real clients would exercise, rather than a
// reimplementation that could silently drift from it - the exact shape
// dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md warns
// against.
//
// Two clients on ONE session share its current window and fight over it
// (pad 71 "SECOND PROJECT, SIDE BY SIDE INSTEAD", measured 2026-08-04), so a
// second attach when `session` already has a client routes through a VIEW
// SESSION instead: `new-session -t <session>` groups with it, borrowing its
// windows with an INDEPENDENT current-window pointer of its own. A view
// session owns no panes, so destroying it can never kill a worker.
//
// The view is not created here as a separate tmux() call: it is created,
// stamped and (when a window is found) navigated in the SAME chained
// invocation this function returns, for two independent reasons measured
// against tmux 3.7b.
//
// First, destroy-unattached (the view's whole teardown story) fires the
// instant it is set on a session with zero clients - it is not a "next
// detach" check - so creating the view first and setting the option in a
// LATER, separate call would destroy it before its own client ever attaches.
// Chaining `new-session` (which both creates and attaches, as one atomic
// step) with `set-option` right after it, in the ONE invocation that
// performs the real attach, guarantees the view already has a client by the
// time tmux evaluates the option.
//
// Second, `new-session -t <base> -s <view>` followed by `; <cmd> -t =<view>`
// in that SAME chained invocation intermittently answers "no such session"
// for the exact-match `=view` form specifically - measured, reproducible,
// gone the instant the chained sub-commands address the session by its BARE
// name instead. Every OTHER target in this file uses the `=` exact-match
// form deliberately (tmux's fuzzy prefix matching can pick the wrong
// session); this one chain does not, and is safe only because viewSessionName
// is tagged by pid and cannot collide with anything else on the server.
// Todo 272. `hive attach` (and cmdLead's own cold-start attach) used to land
// on whatever window the session happened to be showing, because attaching
// to a session with no client selects nothing on its own - the session's
// current window is whatever it last was, not necessarily this project's.
// A window id (@N) is shared across every session in the group, but
// `select-window -t <id>` with no session qualifier moves the CURRENT
// window of every session sharing it (measured) - the exact yank a view
// session exists to avoid, so this is qualified with the TARGET session's
// own name in both branches: base's name in the no-client branch (base has
// no client yet, so selecting its own current window here cannot yank
// anyone), the view's name in the has-client branch (only its own
// independent current-window pointer may move; base stays untouched).
//
// REVERSAL, recorded because a rejected suggestion and the change that
// followed it need to read as the same idea judged differently, not as one
// contradicting the other. A /simplify pass on this lane proposed chaining
// the no-client branch's select-window into the returned argv, the way the
// has-client branch already does, to save one fork. Rejected at the time on
// the grounds that it changes behaviour: cmdAttach's non-TTY branch never
// SPAWNS what this function returns, it only PRINTS advice built by hand, so
// chaining would have stopped the window being selected on that path. That
// reasoning was right about the mechanism and wrong about which behaviour to
// keep. The smoke test against a real build found the actual bug: the
// non-TTY branch's hand-built advice (`tmux attach -t <session>`) knew
// nothing about the project's window or an already-attached base session, so
// it could walk a human straight into the current-window fight this lane
// exists to prevent - pad 71 opened on exactly this shape, two pieces of
// hive's own advice pointing opposite ways, neither citing the other. The
// fix is not "print smarter"; it is that resolveAttachTarget must be usable
// to DESCRIBE the target as well as to REACH it, which an eager side effect
// makes impossible - a function that also performs the outcome cannot be
// reused to name it without performing it a second time. So this returns
// argv now, unconditionally, with every tmux mutation folded INTO it; the
// side effect the non-TTY path could not afford was the bug, not something
// worth preserving. cmdAttach spawns this on the TTY path and renders it
// into a pasteable command on the non-TTY one, from the one source that
// cannot drift.
// `known` is a window the caller already resolved and this lookup would get
// wrong - cmdLead's adopted-pane branch (todo 276), whose lead pane is live in
// a window that does not carry this project's stamp. Everything else omits it.
// Todo 279 (counselors codex #4): THE list-clients READ IS GONE, and with it
// the race it carried. This function used to branch on whether the base
// session already had a client - a read whose answer is executed LATER, by a
// caller that spawns the returned argv - so two terminals attaching at the
// same instant both read zero clients, both got a plain attach, and both
// landed on base: the two-clients-on-one-session fight the view session
// exists to prevent, recreated by the check meant to avoid it. There is no
// way to make a read-then-execute atomic across two processes while the
// decision depends on the read at all.
//
// So EVERY attach from outside tmux goes through its own view session now.
// Deleting the read beats guarding it: a serialized read would still leave
// the EXECUTION outside the lock, which is the same read-then-act one level
// up that todo 277 rejected for the reconcile shape - taking it here would
// have left this round inconsistent with itself. It also collapses the
// everyday one-terminal path and the side-by-side two-terminal path into one
// path, so there is no longer a mode that is correct with one terminal and
// wrong with two.
//
// WHAT IT COSTS, written down rather than left to be discovered: the daily
// single-terminal attach now runs through machinery built for the second
// terminal, and a view session stops being exceptional. `tmux ls` shows one
// per attached terminal, and doctor's stray-view report (todo 273) gets
// noisier in proportion, with destroy-unattached below as the thing keeping
// that honest - it is what makes a view disappear the instant its client
// goes, so a stray one really is a fault rather than the normal case.
//
// destroy-unattached is set ON THE VIEW, in this same chain, at creation.
// NEVER on the base session and never globally (pad 76's view-session design,
// point 3): leads run detached, so a global one would kill the base session
// and every lead in it the moment the last client detached.
// The chain both outside-tmux attach paths share, extracted so it is defined
// once: create (and attach to) a pid-named view session grouped with
// `session`, then set destroy-unattached on it in the SAME chained
// invocation - see the comment block above for why that chaining is load-
// bearing. resolveAttachTarget appends its own select-window clause after
// this; attachScripts (below) uses it as-is, since it has no projectId to
// resolve a window with and was never asked to navigate one.
function viewSessionChain(session: string, view: string): string[] {
  return [
    "new-session", "-t", `=${session}`, "-s", view,
    ";", "set-option", "-t", view, "destroy-unattached", "on",
  ];
}

export function resolveAttachTarget(
  session: string,
  projectId: number,
  controlMode: boolean,
  known?: string,
): string[] {
  const cc = controlMode ? ["-CC"] : [];
  const window = known ?? findProjectWindow(session, projectId);
  const view = freeViewSessionName();
  return [
    ...cc,
    ...viewSessionChain(session, view),
    ...(window ? [";", "select-window", "-t", `${view}:${window.split(":")[1]}`] : []),
  ];
}

// The session the CALLER is in, for a hive command run from inside a tmux
// pane. Two sources, in this order, and the order is the finding (todo 279).
//
// `#{client_session}` is the session the human's own client is looking at.
// That is the right answer even though it is not the pane's own session:
// once a view session is grouped with the base, a pane CREATED in the base
// is shown to a client attached to the VIEW, and moving the base's current
// window would move the OTHER terminal while leaving this one exactly where
// it was. Measured against tmux 3.7b with a real client on the view: a pane
// created in `base` answered `client_session=view1`, while `$TMUX`'s own
// session id still resolved to `base`.
//
// With two clients, tmux resolves "the current client" by most recent
// activity - measured: a client on base and a client on view1, probing from
// a pane in base's window, answered `view1`, the one that had just been
// used. That is the right client for a human who just typed a command, and
// it is a heuristic rather than a guarantee; there is no way to ask tmux
// which client's terminal a process's stdout is on, because a pane's tty is
// the PANE's, not the client's.
//
// Falling back to `$TMUX`'s third field (the session id of the session this
// pane was created in) covers the case where nothing is attached at all - a
// pane in a detached session. Nothing is looking at it, so nothing can be
// yanked, and its own session is the honest answer. null when neither
// resolves: the caller then has nothing to move.
export function callerSession(): string | null {
  try {
    const attached = tmux("display-message", "-p", "#{client_session}");
    if (attached) return attached;
  } catch {
    // No client, or no server; fall through to the pane's own session.
  }
  const sessionId = process.env.TMUX?.split(",")[2];
  if (!sessionId) return null;
  try {
    return tmux("display-message", "-p", "-t", `$${sessionId}`, "#{session_name}") || null;
  } catch {
    return null;
  }
}

export function windowIdsIn(session: string): string[] {
  try {
    return tmux("list-windows", "-t", `=${session}`, "-F", "#{window_id}").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// The in-tmux sibling of resolveAttachTarget: what to run when `hive <path>`
// is typed in a pane rather than in a bare terminal. Returns argv for the
// same reason that one does - so cmdAttach can describe the target as well as
// reach it - or null when there is nothing to move to.
//
// Todo 279 (counselors codex #3 and opus #1 independently, so certain). This
// used to be one line: `select-window -t <window>`, where the window came
// from findProjectWindow qualified with the BASE session's name.
// select-window on a session-qualified target moves THAT SESSION's current
// window, so from a pane inside a VIEW session it moved BASE's - yanking the
// other terminal to a window nobody there asked for, while the caller did not
// move at all. The comment that used to sit at the call site ("the caller is
// already IN the session this pane belongs to") stopped being true the moment
// a view session existed, which is the same commit that made views possible.
//
// A BARE window id is not the fix and never was: the code's own measurement
// records that `select-window -t @4` moves the current window of sessions
// sharing it, chosen by tmux rather than by the caller. Qualify it with the
// CALLER's session.
//
// A caller in an UNRELATED tmux session - their own work session, not hive's
// - cannot select a window it does not have, so it gets the same view session
// every outside-tmux attach gets, reached with switch-client rather than
// attach because this client already exists. The old switch-client
// implementation handled that case and `new-session -t` alone does not, so it
// is handled explicitly here rather than left to fail. The view is created
// DETACHED and destroy-unattached is set LAST, after switch-client has put a
// client on it: set any earlier and tmux destroys it on the spot, since that
// option fires immediately on a session with zero clients rather than at the
// next detach.
export function resolveInTmuxTarget(session: string, window: string | undefined): string[] | null {
  const windowId = window?.split(":")[1];
  if (!windowId) return null;
  const caller = callerSession();
  if (caller && windowIdsIn(caller).includes(windowId)) {
    return ["select-window", "-t", `${caller}:${windowId}`];
  }
  const view = freeViewSessionName();
  return [
    "new-session", "-d", "-t", `=${session}`, "-s", view,
    ";", "select-window", "-t", `${view}:${windowId}`,
    ";", "switch-client", "-t", view,
    ";", "set-option", "-t", view, "destroy-unattached", "on",
  ];
}

// Renders resolveAttachTarget's returned argv into a command a human can
// PASTE into their own shell, for cmdAttach's non-TTY branch. Two things a
// generic shellQuote() cannot get right here:
//
// A bare leading `=` in a tmux target (every session target this function
// ever builds) triggers zsh EQUALS EXPANSION when a human pastes it
// unquoted (.claude/rules/tmux-and-panes.md, "Two shell traps") - quoted
// unconditionally here, not left to a "looks safe" heuristic, because the
// character IS in shellQuote's own safe set and shellQuote would leave it
// bare.
//
// A bare ";" is TMUX's OWN chaining syntax inside one argv, passed to
// execFileSync/spawnSync with no shell involved - it is not a shell
// separator there. Typed at a real shell UNQUOTED, that same token WOULD be
// a shell separator, splitting one `tmux ...` invocation into two broken
// fragments. Quoted here (`';'`, matching this file's own quoting
// convention) so a human's shell passes it through to tmux as the single
// literal argument it always was.
export function renderAttachCommand(argv: string[]): string {
  return argv
    .map((token) => (token === ";" ? "';'" : token.startsWith("=") ? `'${token}'` : shellQuote(token)))
    .join(" ");
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

// THE POLICY, IN ONE PLACE, over a box some caller has already read. Three
// call sites decide "is a human mid-sentence at this pane" - the scheduler's
// wake hold, agent_send's text refusal, and agent_rename's - and todo 317
// found the first two had already written `?.state === "pending"` twice by
// hand. That is the shape CHOICE_DIALOG's own comment (below) exists to
// prevent for the sibling signal: "One function so paneAwaitingChoice and
// paneChoiceCheck cannot drift onto two different definitions of dialog."
// The same argument applies here and had not been made yet.
//
// It takes an already-read box rather than a target on purpose, so it adds
// no capture: agent_send and agent_rename need the InputBoxState itself for
// their receipts, and the scheduler reads through its own per-tick cache.
// Deciding the policy and performing the read are separate jobs, and only
// the policy is shared.
//
// ONLY "pending". "ghost" must not, or every idle claude pane holds or
// refuses forever, since an idle claude draws its own dim hint in the same
// box. "empty" is the ordinary case. "unknown" must not either: it means the
// chrome-matching drifted (issue #30's shape), and a check that silently
// starts firing on every unrecognised screen would hold every wake and refuse
// every send. null is "no box to report on" and is not this predicate's
// business. Full reasoning: .claude/rules/tmux-and-panes.md.
//
// THE "unknown" EXEMPTION IS FAIL-SAFE IN DIRECTION AND SILENT IN PRACTICE,
// AND BOTH HALVES HAVE TO BE SAID (counselors on todo 317, both seats
// independently). The direction is right: classifyInputBox's dangerous
// failure is reading real typed text as a ghost (see leadingRunIsFaint,
// above, which calls it "the destructive direction"), and every
// misclassification here makes a caller MISS - i.e. behave as it did before
// any of these guards existed - rather than fire wrongly.
//
// What this comment used to claim, and what is NOT true: that the loud
// failure is `input_box` reporting "unknown" on a receipt. THERE IS NO SUCH
// CHANNEL ON THE PATHS THAT CLOBBER. A successful agent_send with no wait_ms
// returns {agent_id, name, sent} and no input_box at all; a delivered wake
// reports nothing; agent_rename's success carries no box either. `input_box`
// appears on agent_status/agent_output, which nobody polls while sends look
// fine, and on the refusals that would have STOPPED happening. So if claude
// changes its prompt glyph while INPUT_BOX_PRESENT still matches, every pane
// reads "unknown", all three call sites revert to pre-guard behaviour, and
// nothing anywhere says so. No test catches it either: test/input-box.test.mjs
// replays frozen captures that still carry the old glyph, so a real chrome
// change cannot turn this suite red.
//
// That is an argument for BUILDING the channel, not for widening this
// predicate - widening trades a fail-safe direction for a fail-loud one at
// all three call sites at once, which is the thing .claude/rules/tmux-and-
// panes.md refuses. Todo 319 built the channel: `hive doctor` (src/cli.ts)
// now reads inputBoxState() for every running, non-foreign-socket claude
// worker and warns, by name, on "unknown".
//
// SAY PRECISELY WHAT THAT CLOSES, because a broader claim here already shipped
// once and was wrong (lead triage on this lane's own PR, after counselors
// found it): this guards the PARTIAL-drift case only - INPUT_BOX_PRESENT
// still matches (a box is genuinely on screen) and the prompt row inside it
// cannot be found. A TOTAL drift, where INPUT_BOX_PRESENT itself stops
// matching, returns null here (see the check above) and is exactly as silent
// to the three callers as before this lane existed. Full reasoning and the
// reopen trigger for closing that gap: .claude/rules/tmux-and-panes.md, the
// "unknown exemption" section.
export const holdsHumanInput = (box: InputBoxState | null): boolean => box?.state === "pending";

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
//
// Issue #117. This used to embed a plain `attach -t <session>` in both
// scripts, so two auto-attaches firing at once both landed a client on
// `session` and fought over its current window - the exact shape
// resolveAttachTarget closed for the outside-tmux `hive attach` path (todo
// 279). Every attach from outside tmux, including this one, now takes its
// own view session via the shared viewSessionChain above; see its comment
// for why the chain must stay chained in one invocation.
//
// freeViewSessionName(), not the bare viewSessionName(), because
// ensureAttached (this function's only caller) runs once per agent_spawn
// inside the long-lived MCP server process, not once per attach - a SECOND
// spawn can find the FIRST spawn's own view still alive (auto_attach:"on"
// reads base alone and stays clientless while a human watches through that
// first view) and try to recreate it under the identical name. See
// freeViewSessionName's own comment. An earlier version of this paragraph
// argued the opposite - that ensureAttached's synchrony made any collision
// here unreachable - and both counselor seats on issue #117 refuted it
// independently: synchrony rules out two attaches IN FLIGHT AT ONCE, which
// was never the actual hazard. It says nothing about a later attach finding
// an earlier one's view still standing.
//
// The two scripts run in different contexts - iTerm's profile command with
// no shell, Terminal's `do script` through the user's login shell - so the
// rendering was measured on this machine rather than assumed (dead-end
// 2026-07-16 shipped exactly this bug once already by assuming; see also
// .claude/rules/tmux-and-panes.md, "No shell does not mean no quoting").
// Despite having no shell, iTerm's own command tokenizer turned out to strip
// single quotes and group quoted spans exactly like a POSIX shell would, and
// never treated a bare `;` as a separator either way; Terminal's shell does
// treat an unquoted `;` as a real command separator (measured: it splits
// into a second command) and would path-expand a bare leading `=`. So
// renderAttachCommand's shell-style quoting is harmless on the iTerm branch
// and load-bearing on the Terminal branch, for every token these two scripts
// currently emit - session names and the resolved tmux path, both drawn from
// shellQuote's safe character set. That is narrower than "one rendering
// safely serves both" in general: the equivalence is proven for inputs in
// that safe set, not for an arbitrary future token (a project name, a
// profile) that might land in these scripts later carrying characters
// outside it. The two scripts differ in whether `-CC` is present, and in
// nothing else this function controls.
//
// The iTerm branch is exercised by no automated test and cannot be from
// this suite, which does not drive GUI automation - its coverage is the
// manual tokenizer measurement above plus the shared-rendering argument,
// not a running assertion. test/attach-view-race.test.mjs's M4 executes the
// Terminal branch's actual returned string for exactly this reason, and
// says so in its own comment rather than implying parity it cannot prove.
export function attachScripts(tmuxPath: string, session: string): string[] {
  const cc = controlModeFor(true) ? ["-CC"] : [];
  const argv = viewSessionChain(session, freeViewSessionName());
  // tmuxPath is a real filesystem path (resolved by `which tmux` at the call
  // site, src/tmux.ts's ensureAttached), not a fixed literal like every other
  // token these two scripts embed, so it goes through the same shell-style
  // quoting as everything renderAttachCommand touches - a space in it (an
  // account name with one, for instance) would otherwise split the command
  // into pieces neither branch expects. shellQuote's single-quote wrapping
  // does NOT protect the enclosing AppleScript double-quoted string itself: a
  // path containing a literal '"' still breaks the AppleScript literal before
  // either branch's own quoting is ever reached. Undocumented and unfixed
  // here deliberately - narrower than "one rendering safely serves both" - a
  // real tmux install path containing a double quote is not a case this
  // function defends against.
  const quotedTmuxPath = shellQuote(tmuxPath);
  return [
    `tell application "iTerm" to create window with default profile command "${quotedTmuxPath} ${renderAttachCommand([...cc, ...argv])}"`,
    `tell application "Terminal" to do script "${quotedTmuxPath} ${renderAttachCommand(argv)}"`,
  ];
}

// WHICH clients auto-attach asks about. This is the entire behavioural
// difference between the two live modes, so it is a function rather than an
// inline ternary, and it is exported so a test can see which probe ran.
//
// "on" asks whether THIS SESSION is watched, which is what hive did before
// this preference existed, back when each project had its OWN session: with
// one tmux client moved between per-project sessions, every session the
// human was not looking at right now had zero clients, so every spawn there
// opened a native window. Under the one-session topology (todo 267-279)
// that per-session signal is mostly gone: every project shares this one
// base session, and every real attach now groups a separate, pid-named VIEW
// session with it (todo 279, "always attach through a view") rather than
// attaching to base directly - so `list-clients` scoped to base reads empty
// even while a human is actively attached through a view. "on" is left as a
// degenerate, near-always-empty probe rather than removed (T4b's own
// decision, plan-lane-3-tmux-topology pad, records the identical cost for
// doctor's stray-view report: "degrades from signal to noise", same cause).
// "auto" asks whether they are watching ANY session on this server - base or
// any view - so it still reflects real attachment; hive stays out of the way
// while they are at the keyboard and still surfaces a worker once they have
// closed their terminal.
//
// The shape matters, not just the values. The first version of this chose the
// probe with an inline ternary and then handed the single answer to a pure
// decision helper TWICE (`shouldAutoAttach(value, hasClient, hasClient)`), so
// the helper's two parameters could never disagree in production. Reverting
// "auto" to the per-session probe - the exact regression this preference
// exists to prevent - left all 1022 tests green, measured. A seam a test
// cannot reach is not a seam.
export function autoAttachProbe(value: AutoAttach, session: string): string[] {
  return value === "on" ? ["list-clients", "-t", `=${session}`] : ["list-clients"];
}

// When nobody is watching, pop open a native terminal attached in control mode
// so spawned workers appear on screen automatically. iTerm control mode (-CC)
// maps each tmux window to a native window/tab.
export function ensureAttached(session: string): void {
  if (process.platform !== "darwin") return;
  // Todo 355. A process on a PRIVATE tmux socket must not attach at all, and
  // the reason is structural rather than a preference: attachScripts emits
  // neither -L nor -S, so the tmux that AppleScript's fresh GUI shell runs
  // resolves its socket from that shell's own environment - which has none of
  // ours, since it is spawned by iTerm/Terminal rather than forked from here.
  // So hive CANNOT ENSURE that window reaches this socket - the refusal is
  // about hive's own ignorance, not about tmux's behaviour, and stating it the
  // stronger way ("it can only ever reach the default socket") is false: the
  // Terminal branch's `do script` runs through the user's LOGIN SHELL, so a
  // machine whose ~/.zprofile or `launchctl setenv` exports TMUX_TMPDIR feeds
  // that shell the same private socket by a route hive cannot see. Such a user
  // had a working auto-attach and now gets a silent refusal; known, and still
  // the right default, because hive cannot read that shell's rc and guessing
  // wrong is the leak itself. On every socket hive can actually reason about,
  // the window we are about to open cannot see the session we would name, and what
  // actually lands is a stray bare-shell session on the developer's own tmux
  // server, plus a control-mode client. That client is the damaging half:
  // killing the stray does not make it exit, it makes it SWITCH to whatever
  // session the developer is really using (measured, todo 355 comment 788), so
  // the fix has to stop the client being CREATED rather than re-point it.
  // Propagating TMUX_TMPDIR through the AppleScript string was the obvious
  // alternative and does not close that half.
  //
  // THE COST, STATED BECAUSE IT READS AS AN UNEXPLAINED BEHAVIOUR LOSS: a
  // human running hive inside `tmux -L something` no longer gets an
  // auto-attach window. That is correct rather than a regression - the window
  // would have opened onto a server that is not theirs - and it is narrower
  // than it looks, since a human inside that server is an attached client ON
  // it, so under "auto" this function already returned at the probe below.
  // Only "on", whose probe reads the base session alone, reaches here.
  // Unaffected: every ordinary spawn. An MCP server Claude Code starts has no
  // tmux env at all, and a lead or worker pane is on the default socket, so
  // privateTmuxSocket is false and the attach happens exactly as before. The
  // scratch-HIVE_DATA_DIR-on-the-default-socket method is unaffected too, and
  // deliberately: it is the only known way to exercise this function at all
  // (.claude/sessions/dead-ends/2026-08-02-ensureattached-against-the-live-session.md),
  // which is why this refusal is SOCKET-shaped and never mentions the store.
  //
  // ITS POSITION ABOVE THE PROBE IS ITS MEANING, not an optimisation. The
  // probe is what makes this function's other returns observable, so a guard
  // BELOW it still closes the leak while making no test able to tell which
  // return fired - the false green this lane exists not to ship. Hoisting the
  // probe above this line, or sinking this line below it, breaks
  // test/auto-attach-scope.test.mjs's "asks tmux nothing" assertions.
  if (privateTmuxSocket(process.env.TMUX, process.env.TMUX_TMPDIR)) return;
  const { value } = resolvedAutoAttach();
  if (value === "off") return;
  try {
    if (tmux(...autoAttachProbe(value, session)).trim() !== "") return;
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

// Issue #150. Neither branch above types a control byte the way it types
// everything else. NUL reaches execFileSync's argument array, which Node
// rejects outright. Every other C0 byte or DEL reaches tmux AS A KEYSTROKE
// rather than as literal text - verified against a real tmux for exactly
// this class of byte by agent_rename's identical guard
// (src/tools/agents.ts: send-keys -l stops tmux interpreting key NAMES but
// passes a raw control byte straight through to the TUI, so 0x03 sends
// Ctrl-C mid-task). So a caller passing `text` silently gets the `keys`
// path (.claude/rules/tmux-and-panes.md's text/keys distinction) with
// nobody choosing that. One detector here, reused by every caller that
// types free text into a pane, so two call sites cannot drift onto two
// definitions of "unsafe byte" the way CHOICE_DIALOG/INPUT_BOX_PRESENT
// above do not.
//
// Tab and newline are the only bytes this file exempts for free text. A
// wake body is written as multi-line prose by every caller in this project
// (worker-state.md), so rejecting newline would break the feature outright.
// CR is deliberately NOT exempted alongside it: CR is the byte a literal
// Enter keypress sends, so letting it through would let a pasted body press
// Enter partway through itself - the identical keys-path breach this guard
// exists to close, just spelled with a different byte. A caller that wants
// an actual keystroke has `agent_send(keys: [...])`; that path is unguarded
// by design (see the file above) because driving a TUI on purpose is the
// job it exists for.
export const TEXT_ALLOWED_CONTROL_CHARS = new Set(["\t", "\n"]);

const CONTROL_CHAR_NAMES: Record<number, string> = {
  0: "NUL",
  1: "SOH",
  2: "STX",
  3: "ETX (Ctrl-C)",
  4: "EOT (Ctrl-D)",
  5: "ENQ",
  6: "ACK",
  7: "BEL",
  8: "BS",
  11: "VT",
  12: "FF",
  13: "CR",
  14: "SO",
  15: "SI",
  16: "DLE",
  17: "DC1",
  18: "DC2",
  19: "DC3",
  20: "DC4",
  21: "NAK",
  22: "SYN",
  23: "ETB",
  24: "CAN",
  25: "EM",
  26: "SUB (Ctrl-Z)",
  27: "ESC",
  28: "FS",
  29: "GS",
  30: "RS",
  31: "US",
  127: "DEL",
};

export interface UnsafeControlChar {
  code: number;
  index: number;
  label: string;
}

// Finds the first byte unsafe to type into a pane as literal text: every C0
// control byte and DEL, except whatever `allowed` names (agent_rename passes
// none - a name has no legitimate newline; the wake/agent_send text callers
// pass TEXT_ALLOWED_CONTROL_CHARS above).
export function findUnsafeControlChar(text: string, allowed: Set<string>): UnsafeControlChar | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (allowed.has(ch)) continue;
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      const name = CONTROL_CHAR_NAMES[code];
      const hex = `0x${code.toString(16).padStart(2, "0").toUpperCase()}`;
      return { code, index: i, label: name ? `${name}, ${hex}` : hex };
    }
  }
  return null;
}

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
