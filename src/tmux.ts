import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Todo 375. THE THIRD OUTCOME. Until this existed, tmux() had exactly two:
// an answer, or a TmuxError that tmuxSaysNothingThere() classifies. A call
// the timeout below killed is neither, and the whole safety of this fix turns
// on it never being read as the second one: `false` means tmux said nothing
// is there, `null` means tmux never answered, and reading unknown as dead is
// how a live worker gets reaped (issue #14, and the file this rule is pinned
// in). A timed-out call is the `null` case, loudly.
//
// A SUBCLASS, not a `timedOut` boolean on TmuxError and not a string match on
// the message. Two properties fall out of that and both are load-bearing:
// every existing `e instanceof TmuxError` caller keeps working unchanged
// (this IS a TmuxError, carrying the same stderr contract), and
// tmuxSaysNothingThere() can refuse it by TYPE before it ever looks at text.
//
// IT CARRIES THE PARTIAL stderr RATHER THAN "" DELIBERATELY, and the reason
// is that the guard has to be able to fail. A killed child's stderr is
// whatever it had written by then, which is honest to report - and if this
// class hard-coded "" instead, the type check in tmuxSaysNothingThere() would
// be unfalsifiable decoration: no test could construct the case it exists to
// stop, since NOTHING_THERE cannot match an empty string anyway. Carrying the
// real text means a TmuxTimeoutError whose partial stderr DOES match
// NOTHING_THERE is constructible, so the guard is pinned by a test that goes
// red without it (test/tmux-timeout.test.mjs).
export class TmuxTimeoutError extends TmuxError {
  constructor(
    message: string,
    stderr: string,
    readonly timeoutMs: number,
  ) {
    super(message, stderr);
    this.name = "TmuxTimeoutError";
  }
}

// execFileSync's default maxBuffer is 1MB, which a dense capture-pane (many
// columns, heavy color/attribute use, "-e" widening every cell) can exceed.
// The failure mode without this is an uncaught ENOBUFS: tmuxSaysNothingThere
// does not match it, so it surfaces as an opaque tool error on a pane that
// was perfectly readable, rather than the TmuxError callers already know how
// to handle. 16MB comfortably covers even a wide, fully-attributed pane.
const TMUX_MAX_BUFFER = 16 * 1024 * 1024;

// Todo 375, from an incident: four tmux processes pegged at ~99% CPU, the
// oldest for 1h34m, each a client spinning against a server that had wedged.
// execFileSync with no `timeout` blocks for as long as the child runs, which
// against a wedged server is forever, so one stuck call became an hour and a
// half of a burning core.
//
// MEASURED, NOT FELT (the whole point of
// dead-ends/2026-08-07-a-90-second-settle-before-counting-leaked-processes.md:
// an unmeasured threshold becomes a constant everyone downstream pays). Every
// command shape this file issues was timed against a real tmux 3.7b on a
// private socket, 60 iterations each, on a loaded server (20 windows x 2
// panes, every pane full of wide fully-attributed output so capture-pane -e
// has the most expensive screen it will ever serialise):
//
//   idle box                 p50 ~6ms   p99 102ms   max 120ms
//   8-way fork contention    p50 ~6ms   p99  98ms   max 155ms
//   during a full npm test   p50 ~12ms  p99  51ms   max 103ms
//
// The slowest legitimate call observed anywhere was 155ms, and the slowest
// SHAPE is a cold-server `new-session` (47ms idle, 103ms under a full suite)
// because it forks the server itself. 10s is ~65x the worst observation and
// ~100x p99. The headroom is that wide on purpose: cutting a legitimate call
// short is not free (it answers `null`, so the janitor holds, agent_send
// reports a failed probe, and a healthy machine starts looking unknowable),
// while the cost of being generous is bounded and small - a wedge now burns
// ten seconds of a core per call instead of an hour and a half.
//
// Every command that reaches tmux() is non-interactive and returns as soon as
// the server answers. The one tmux call that blocks by design, `attach`, never
// comes through this function - it is spawned with stdio inherited straight
// from the CLI (src/cli.ts's attach()), because a human's terminal is supposed
// to stay in it.
//
// ONE SHAPE IS BOUNDED BY THE USER'S CONFIG RATHER THAN BY TMUX, and an
// earlier version of this comment claimed otherwise (counselors round 2, F9).
// A cold-server `new-session` starts the server, which SOURCES ~/.tmux.conf,
// and `run-shell`/`if-shell` WITHOUT -b block that startup - a tpm line doing
// first-run plugin installation is not a sub-second operation. So the numbers
// above are a property of this machine's config as much as of the command,
// and on a heavy enough conf `hive lead`'s first run after a reboot
// (ensureSession) can be cut short and told "the tmux server may be wedged",
// naming the wrong cause on a healthy machine. Recoverable - a retry finds
// the session the killed client's server actually created - and loud rather
// than silent, which is why it is a correction here and not a second bound.
// CI cannot see it either way: runners have no ~/.tmux.conf.
//
// NARROWER THAN IT READS, and worth saying so rather than leaving the numbers
// looking unmeasured: the box those measurements were taken on HAS a 6.3k
// ~/.tmux.conf carrying both an unbackgrounded `run` and an `if-shell`, and a
// cold-server new-session through it re-measured at 62ms. The finding is
// about a config heavier than that one, not about a bare one.
const TMUX_TIMEOUT_MS = 10_000;

// Read at CALL time, never at module load, for the same reason the data dir
// is (.claude/rules/store-and-datadir.md): a value frozen at import time
// cannot be exercised by a test that has already imported this module.
//
// TESTING ONLY, and `hive doctor` says so out loud when it is set, on the
// same posture as HIVE_AUTO_ATTACH's override - a knob that SHORTENS a safety
// bound must not be able to sit in an environment silently. The suite needs
// it because the alternative is a ten-second real-time wait per assertion
// about a bound that only expires in real time.
// An unparseable or non-positive value falls back to the measured default
// rather than throwing: this function is on every tmux call in the codebase,
// including the scheduler's, which must never throw (CLAUDE.md).
function tmuxTimeoutMs(): number {
  const raw = process.env.HIVE_TMUX_TIMEOUT_MS;
  if (raw === undefined) return TMUX_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TMUX_TIMEOUT_MS;
}

export function tmuxTimeoutOverride(): number | null {
  return process.env.HIVE_TMUX_TIMEOUT_MS === undefined ? null : tmuxTimeoutMs();
}

// WHAT THIS DOES NOT DO, said here rather than left to be discovered:
// execFileSync's timeout kills the CHILD, not the tmux SERVER it was talking
// to. This bounds hive's exposure and leaves the wedged server running. It
// bounds the DAMAGE and leaves the CAUSE open (todo 368, still open through
// two incidents); `hive doctor`'s orphaned-server report is what notices the
// survivor afterwards.
export function tmux(...args: string[]): string {
  return tmuxWithin(tmuxTimeoutMs(), ...args);
}

// The bound as a PARAMETER, for the one caller whose calls are not hive's own
// work: `hive doctor`'s orphan probe talks to candidate servers it expects to
// be debris, where the measured 10s protects nothing and a report has to stay
// interactive. Every other caller takes the default through tmux() above.
// Callers never widen the env override, only narrow it (see the min at that
// call site), so HIVE_TMUX_TIMEOUT_MS stays a ceiling for every tmux call.
function tmuxWithin(timeoutMs: number, ...args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: TMUX_MAX_BUFFER,
      timeout: timeoutMs,
      // SIGTERM is execFileSync's default, and a wedged tmux is exactly the
      // process least likely to act on one. SIGKILL cannot be caught or
      // ignored, so the bound above is a bound rather than a request.
      killSignal: "SIGKILL",
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
    // MEASURED against node v24.19.0 on darwin rather than assumed, because
    // the branch below is the whole safety of this bound: a timed-out
    // execFileSync throws with `code: "ETIMEDOUT"` (errno -60), `signal:
    // "SIGKILL"` from the killSignal above, and `status: null`. An ordinary
    // non-zero tmux exit carries `status: <n>` and no `code` at all, and a
    // child killed from outside carries a signal with no `code` either, so
    // ETIMEDOUT is specific to the bound this function set.
    if (err.code === "ETIMEDOUT") {
      throw new TmuxTimeoutError(
        `tmux ${args[0]} did not answer within ${timeoutMs}ms and was killed. The tmux server may be ` +
          "wedged; this says NOTHING about whether the target exists. Check for orphaned servers with " +
          "`hive doctor`.",
        detail ?? "",
        timeoutMs,
      );
    }
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
  // Todo 375, and this line is the reason that todo's timeout is safe to add
  // at all. A call hive killed for not answering has told us nothing about
  // the world, so it can never be "there is nothing there" no matter what
  // partial text the dying child had already written to stderr. Refused BY
  // TYPE, above the text match rather than inside it: a timed-out probe that
  // classified as `false` would let the janitor sweep, agent_close retire and
  // agent_send give up on workers that are alive and working, which is
  // precisely the failure the bound was added to prevent, arriving through
  // the fix for it.
  if (e instanceof TmuxTimeoutError) return false;
  if (!(e instanceof TmuxError)) return false;
  // No tmux binary: nothing tmux manages can be alive either.
  if (e.notInstalled) return true;
  return NOTHING_THERE.test(e.stderr);
}

// Stays a plain boolean, unlike targetLive: its one caller asks "does this
// session exist" and falls through to new-session on false, which throws its
// own TmuxError if tmux is genuinely unreachable. Nothing is destroyed by
// guessing wrong here.
// Todo 375: THROUGH tmux(), not a second execFileSync of its own. This used
// to reach tmux directly, so a wedged server hung it just as completely - and
// it sits on `hive lead`'s and `hive attach`'s own path (ensureSession's
// has-session probe), which made an unbounded call here a CLI that never
// returns.
//
// A TIMEOUT IS RETHROWN RATHER THAN FLATTENED INTO `false`, and that is the
// correction this function needed rather than just a bound (found by this
// lane's own /simplify altitude pass). `catch { return false }` collapses the
// third outcome straight back into "nothing there" - the exact flattening
// tmuxSaysNothingThere() is amended above to refuse - and the two callers
// read `false` differently enough that it matters:
//   ensureSession falls through to `new-session`, which is bounded too and
//     throws against the same wedged server. Survivable, and it was the only
//     caller the first version of this comment reasoned about.
//   freeViewSessionName reads `false` as "this session name is FREE" and
//     hands it to a create. A wedged server would make every candidate look
//     free, which is a fact about the probe, not about the server.
// Rethrowing means a wedge costs ONE timeout and a loud failure at both call
// sites instead of a guess that happens to be recoverable at one of them.
// Everything else about `false` is unchanged: tmux answered, the target is
// not there.
function quietTmux(...args: string[]): boolean {
  try {
    tmux(...args);
    return true;
  } catch (e) {
    if (e instanceof TmuxTimeoutError) throw e;
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
//
// THE ONE CLASSIFIER LEFT THAT A TIMEOUT CAN SATISFY BY TEXT. Counselors
// round 2, RAISED AND ACCEPTED (todo 375), recorded here because a future
// reader deserves to know it is deliberate: this tests `instanceof TmuxError`
// plus stderr, with no TmuxTimeoutError exclusion, and TmuxTimeoutError
// carries the dying child's PARTIAL stderr - so a timed-out new-session whose
// stderr happened to contain "duplicate session" would read as { created:
// false }. Accepted because the consequence is benign and nothing
// destructive was constructible: the caller falls through to bounded calls
// that throw against the same wedged server, and the killed child would have
// had to write that exact text before dying. Excluding the type here is a
// one-line reversal if that judgement is ever revisited; it buys nothing
// today.
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

// Todo 375 item 2. What `hive doctor` needs to REPORT the debris the bound
// above leaves behind: killing the child does not kill the server it was
// talking to, so a wedge that used to hang a caller forever now leaves a
// survivor nobody counts. On the night this was filed there were 200
// candidate scratch sockets under the temp dir and a server still spinning
// from 10:45 that morning, from a worktree that no longer existed.
//
// ENUMERATED BY SOCKET, NEVER BY PID
// (dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-pid.md: building the
// same pid list twice gave two different answers for one pid, because `lsof`
// lists connected and listening sockets alike and a tmux CLIENT is also named
// `tmux`). This only reports, so a wrong row would only misinform rather than
// kill the live server - and it is still built the safe way, because the
// report's own remedy text tells a human to act on it.
//
// THE PREFIX IS THE SUITE'S, deliberately narrow: `isolateTmux()`
// (test/helpers.mjs) creates `<tmpdir>/hive-tmux-XXXX/tmux-<uid>/default`, and
// nothing in production ever makes a scratch socket. So this counts hive's own
// test debris and says nothing about another tool's private server, which is
// not hive's to report on. The prefix is mirrored by hand in
// test/helpers.mjs, the same way scripts/restart-lead.sh mirrors
// isViewSessionName's suffix; test/orphan-tmux-servers.test.mjs pins that the
// two agree.
export const SCRATCH_SOCKET_PREFIX = "hive-tmux-";

// A JUDGEMENT, not a measurement, and stated as one (the habit
// dead-ends/2026-08-07-a-90-second-settle-before-counting-leaked-processes.md
// asks for: mark every threshold MEASURED or GUESSED).
//
// It exists to keep this report off LIVE test runs rather than to describe
// anything about orphans: a full `npm test` on this machine takes ~3 minutes
// (measured, 181s), and every file's socket is created and reaped inside it,
// so a scratch socket older than an hour cannot belong to a run still in
// flight. Twenty times the longest run, against an incident whose own orphan
// was nearly eight hours old. Without a floor, doctor run DURING a suite
// reports that suite's own healthy sockets as debris, and two existing tests
// diff doctor's warning count across two runs seconds apart.
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

// A JUDGEMENT again, and the reason it exists at all is that this report
// names a CHRONIC condition. Any machine that runs this suite accumulates
// aged scratch sockets - one was sitting on the developer's box, 10.4h old,
// the first time this check ran - and a warn that is on most of the time is
// one a reader learns to skip, which is the same argument `hive doctor
// --strict` already makes about warns that fire during healthy operation
// (src/cli.ts). So a handful of ANSWERING orphans is information, not a
// warning.
//
// A WEDGED one warns at the first, and that asymmetry is the finding rather
// than a tuning choice: a server that answers can be reaped by the recorded
// safe method (kill-server by socket), while one that does not answer is the
// incident's own shape and that method does not work on it at all
// (dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md).
const ORPHAN_WARN_COUNT = 5;

// Exported and tested at the boundary rather than inlined at its one call
// site, for the reason isLowHeadroom's own comment gives (src/ptys.ts):
// "exactly at the threshold" and "one either side" are fixture-testable this
// way, instead of only observable by reading doctor's stdout.
export function orphansWorthWarningAbout(orphans: OrphanScratchServers): boolean {
  return orphans.wedged > 0 || orphans.live >= ORPHAN_WARN_COUNT;
}

// Probing costs a fork per candidate (5.4ms measured), and a WEDGED candidate
// costs the whole bound - the case this report exists for. Doctor stays usable
// on a box with 200 sockets and several wedged servers by stopping at a budget
// and SAYING it stopped, never by silently sampling.
//
// WORST CASE IS BUDGET PLUS ONE PROBE, stated rather than implied: the loop
// checks what it has SPENT, so the last probe it starts can still run its full
// bound. Reserving a bound per candidate instead was tried and is worse - a
// pessimistic reservation stops after two candidates on a box where every
// probe actually costs 6ms, which is every healthy box.
const ORPHAN_PROBE_BUDGET_MS = 5000;

// A SHORTER BOUND THAN tmux()'s MEASURED 10s, and the reason is the same one
// that lets isolateTmux's teardown use 5000 (test/helpers.mjs): there is no
// legitimate slow case to protect here. The 10s default exists so a
// legitimate call on hive's OWN server is never cut short; a `list-sessions`
// against a candidate orphan either answers at once or is the wedged server
// this report is looking for. 2s keeps doctor's worst case at 7s instead of
// 15s.
const ORPHAN_PROBE_TIMEOUT_MS = 2000;

export interface OrphanScratchServers {
  // Every scratch socket found, whatever its age. Reported even when nothing
  // is old enough to probe, so "0 servers" can never be mistaken for "nothing
  // is there at all".
  candidates: number;
  // Candidates past ORPHAN_MIN_AGE_MS, i.e. the ones worth probing.
  aged: number;
  probed: number;
  // Answered: a real, reachable orphan server.
  live: number;
  // Did not answer within the bound. This is the incident's own shape, and
  // the reason it is counted separately is that the recorded safe reap
  // (kill-server by socket) does not work on one:
  // dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md.
  wedged: number;
  oldestMs: number | null;
  // Socket paths of what was counted, for a remedy a human can paste.
  sockets: string[];
  // The same population as `sockets`, carrying each one's own state rather
  // than only the aggregate counts above. Added for scripts/sweep-scratch.mjs
  // (todo 402): reaping needs to choose ITS method per candidate - a `live`
  // one answers `kill-server` directly, a `wedged` one needs the pid fallback
  // (dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md) -
  // and doctor's own report never needed that, only the counts.
  entries: { socket: string; state: "live" | "wedged"; ageMs: number }[];
}

// Never throws, and answers null when there is nothing measurable - the same
// stance ptyHeadroom() takes and for the same reason: doctor has plenty of
// other ways to be red, and this is one additive read-only report.
export function orphanScratchServers(options: { minAgeMs?: number; budgetMs?: number } = {}):
  | OrphanScratchServers
  | null {
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const budgetMs = options.budgetMs ?? ORPHAN_PROBE_BUDGET_MS;
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return null;
  }
  // THE LIVE SOCKET IS RESOLVED EXPLICITLY AND EXCLUDED, never inferred. hive
  // itself runs on a scratch socket throughout the test suite, so this is not
  // hypothetical: without the exclusion, doctor under test would report the
  // very server it is talking to.
  //
  // THE EXCLUSION IS LEXICAL, AND A SYMLINK DEFEATS IT. Counselors round 2,
  // RAISED AND ACCEPTED (todo 375), recorded here rather than fixed: only the
  // temp BASE is canonicalised below, not each entry, so an entry named
  // hive-tmux-<anything> that SYMLINKS to the live socket's directory
  // compares unequal to liveSocket, stats through to the live socket, and
  // gets probed and reported as an orphan - with a reap instruction next to
  // it. Accepted because someone has to plant that symlink under the temp
  // dir, doctor still kills nothing (it prints, and this function contains no
  // kill path at all), and the fix - realpath per entry - costs a syscall per
  // candidate on a path that already stats each one, on a box this report
  // exists for because it had 200 of them.
  const liveSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
  const result: OrphanScratchServers = {
    candidates: 0,
    aged: 0,
    probed: 0,
    live: 0,
    wedged: 0,
    oldestMs: null,
    sockets: [],
    entries: [],
  };
  const deadline = now + budgetMs;
  const aged: { socket: string; ageMs: number }[] = [];
  // Resolved ONCE for the whole scan. socketUnder() canonicalises with
  // realpathSync (13.4us, 8x the statSync below it), and every candidate
  // shares the identical temp-dir prefix, so calling it per entry walks the
  // same path 200 times on the machine this report exists for.
  const base = canonical(tmpdir());
  const uidDir = `tmux-${process.getuid?.() ?? 0}`;
  for (const entry of entries) {
    if (!entry.startsWith(SCRATCH_SOCKET_PREFIX)) continue;
    const socket = join(base, entry, uidDir, "default");
    if (socket === liveSocket) continue;
    let mtimeMs: number;
    try {
      // stat, not a probe: an age is readable without talking to a server
      // that may not answer, so every candidate is aged before any of them
      // costs a fork.
      mtimeMs = statSync(socket).mtimeMs;
    } catch {
      // The directory exists with no socket file in it: a test that never
      // started a server, or one whose server exited and unlinked it. Neither
      // is a server, so neither is a candidate.
      continue;
    }
    result.candidates += 1;
    const ageMs = now - mtimeMs;
    if (ageMs < minAgeMs) continue;
    aged.push({ socket, ageMs });
  }
  result.aged = aged.length;
  // Oldest first: with a budget, the ones most likely to be real debris are
  // the ones worth spending it on.
  aged.sort((a, b) => b.ageMs - a.ageMs);
  for (const candidate of aged) {
    if (Date.now() > deadline) break;
    result.probed += 1;
    let state: "live" | "wedged" | "gone";
    try {
      // -S names the socket FILE, so this can never fall back to the shared
      // server the way an env-selected call would (test/CLAUDE.md, and
      // decisions/2026-08-07-kill-the-servers-socket-by-S-never-through-
      // tmux-tmpdir.md). Through tmux() rather than a raw execFileSync so the
      // probe carries the bound this whole todo is about: a wedged candidate
      // does not answer, and a report that hangs while counting hangs the
      // command a human ran to find out why things are hanging.
      // min, not the constant outright: HIVE_TMUX_TIMEOUT_MS is a ceiling for
      // every tmux call in the process, so a caller may narrow it and must
      // never widen it.
      tmuxWithin(
        Math.min(ORPHAN_PROBE_TIMEOUT_MS, tmuxTimeoutMs()),
        "-S", candidate.socket, "list-sessions", "-F", "#{session_name}",
      );
      state = "live";
    } catch (e) {
      state = e instanceof TmuxTimeoutError ? "wedged" : "gone";
    }
    if (state === "gone") continue;
    if (state === "live") result.live += 1;
    else result.wedged += 1;
    result.sockets.push(candidate.socket);
    result.entries.push({ socket: candidate.socket, state, ageMs: candidate.ageMs });
    result.oldestMs = Math.max(result.oldestMs ?? 0, candidate.ageMs);
  }
  return result;
}

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

// TODO 403. ONE CAPTURE, TWO WINDOWS, AND WHICH ONE A CALLER WANTS DEPENDS
// ON WHICH WAY THAT CALLER FAILS.
//
// `capture-pane -S -N` returns the whole VISIBLE pane plus N rows of history,
// not N rows total - measured live at three pane heights on an isolated
// server (69, 49 and 39 rows returned for `-S -18` against panes 50, 30 and
// 20 rows tall), the same correction scripts/restart-lead.sh had to record
// once already, in its own now-deleted `capture_trimmed` (todo 405).
// `capturePane` then throws that surplus away: trailing blanks stripped, last
// N rows kept.
//
// Both windows are legitimate and hive needs both, which is what todo 403
// found the hard way - `inputBoxState` read the raw one and everything going
// through `capturePane` read the narrow one, so BOX_MAX_ROWS bound only on
// one of them and a tall input box read PRESENT to the reporting path and
// ABSENT to the dialog path at the same instant on the same pane. The split
// is exposed here rather than settled here, because the right window is a
// property of the QUESTION (see isAwaitingChoiceScreen), not of the capture.
export function captureRawPane(target: string, lines: number): string {
  return tmux("capture-pane", "-p", "-t", target, "-S", `-${lines}`);
}

// The narrow window: the last `lines` rows of what was actually drawn.
// Trailing blank rows are an artefact of the pane being taller than the
// content, so they are stripped before the slice or a mostly-empty screen
// yields a mostly-empty window.
export function tailWindow(raw: string, lines: number): string {
  const rows = raw.split("\n");
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.slice(-lines).join("\n");
}

export function capturePane(target: string, lines: number): string {
  return tailWindow(captureRawPane(target, lines), lines);
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
// changes its prompt glyph while the box is still recognisable, every pane
// reads "unknown", all three call sites revert to pre-guard behaviour, and
// nothing anywhere says so. No test catches it either: test/input-box.test.mjs
// replays frozen captures that still carry the old glyph, so a real chrome
// change cannot turn this suite red.
//
// That is an argument for BUILDING the channel, not for widening this
// predicate - widening trades a fail-safe direction for a fail-loud one at
// all three call sites at once, which is the thing .claude/rules/tmux-and-
// panes.md refuses. Todo 319 built the channel: `hive doctor` (src/cli.ts)
// reads inputBoxState() for every running, non-foreign-socket claude worker
// - and, since todo 399, for the lead's own pane - warning by name on
// "unknown".
//
// SAY PRECISELY WHAT THAT CLOSES, because a broader claim here already shipped
// once and was wrong (lead triage on this lane's own PR, after counselors
// found it): it guards the PARTIAL-drift case - a box is genuinely on screen
// and the prompt row inside it cannot be found.
//
// TODO 399 CLOSED THE TOTAL CASE THIS PARAGRAPH USED TO LEAVE OPEN, and the
// correction matters because the old text told a reader the gap was
// permanent. It used to say: a TOTAL drift, where INPUT_BOX_PRESENT itself
// stops matching, returns null here and is exactly as silent to the three
// callers as before todo 319 existed. That was true, and it was not
// hypothetical - it is what happened. INPUT_BOX_PRESENT's four alternatives
// all lived on ONE line of claude's UI, claude multiplexes that line, and
// while another hint occupied it the predicate was false on a pane with a
// box plainly on screen (test/fixtures/panes/footer-slot-taken.txt, measured
// live on the lead's own pane on main). Every guard that rests on this
// function was ABSENT, not weakened, for the duration of the hint.
//
// The predicate now anchors on the box itself (`findInputBox`, below), which
// is present whatever claude puts in that line, so the total case it names
// no longer has a producer of this shape. What has NOT changed: a claude
// release that redraws the box's own borders would still take this to null
// on every pane, and it would still be silent to the three callers. The
// class is narrowed to "claude redesigns the box", not closed - which is
// worth saying, because "the box" is a far more stable thing to key on than
// "the footer" and the temptation is to read that as a guarantee.
export const holdsHumanInput = (box: InputBoxState | null): boolean => box?.state === "pending";

// The horizontal rule claude draws as the input box's own top and bottom
// edge (see e.g. test/fixtures/panes/ready-idle.txt lines 45 and 47). A
// multi-line box grows DOWNWARD, pushing this rule further down the screen
// rather than adding a marker of its own, so it is the stop condition
// classifyInputBox scans for below.
const BOX_BORDER = /^─+$/;

// TODO 399. The box's TOP edge is not always a bare rule. Claude 2.1.232
// draws the terminal's own title into it as an inverse-video chip -
// test/fixtures/panes/footer-slot-taken.txt row 62 reads
// "───…─── Hive Overnight Lead 2026-08-13 ──" - so BOX_BORDER does not match
// it. Widening BOX_BORDER itself is the wrong repair twice over: it is the
// stop condition classifyInputBox scans FORWARD for, where only the bare
// closing edge is ever seen, and anything loose enough to accept a title
// would also accept the indented preview rules a dialog draws
// (tool-permission-prompt.txt row 21, plan-approval-dialog.txt row 42).
//
// Matched by its LEADING run instead: a row that STARTS with box-drawing
// horizontals is an edge, whatever claude hangs off the end of it. The
// four-character floor is there only so a stray `─` in ordinary prose is not
// an edge; nothing depends on its exact value.
const BOX_TOP_BORDER = /^─{4,}/;

// TODO 399, AND THIS IS THE WHOLE LANE: WHAT PROVES CLAUDE'S INPUT BOX IS ON
// SCREEN RIGHT NOW.
//
// It used to be INPUT_BOX_PRESENT, a regex over four substrings of the
// permission-mode footer. Every one of those four lives on ONE line of
// claude's UI, and claude multiplexes that line with other transient hints.
// Measured live on main, 2026-08-14, on the lead's own pane (claude 2.1.232,
// 105 columns, bypassPermissions), captured with the identical command
// inputBoxState issues: a real prompt row on screen carrying a ghost, and
// not one of `for shortcuts`, `shift+tab to cycle`, `mode on` or
// `permissions on` anywhere in the capture, because the line read "paste
// again to expand". Re-captured a minute later, the footer was back. Not a
// version drift (two workers on the same 2.1.232, same width, same mode,
// captured in the same minute, both matched) and not width (105 columns is
// far above the 40-column truncation todo 392 measured). The capture is
// test/fixtures/panes/footer-slot-taken.txt and it cannot be re-taken on
// demand; the fixtures README says why.
//
// A FIFTH SUBSTRING WOULD BE THE WRONG FIX and this is not the widening todo
// 392's D2/M1 argued for. Those closed TOTAL MISSES - a mode whose footer
// never carried any alternative, at any width - by adding a marker that is
// always there for that population. This slot is multi-purpose BY DESIGN, so
// a fifth alternative buys one hint and loses to the next one claude puts in
// it.
//
// SO ANCHOR ON THE BOX. The prompt row and its own border rules were present
// and correct throughout the drifted capture, and they are what "an input
// box is on screen" actually means.
//
// THE CONSTRAINT THIS HAS TO MEET, and it is the reason the footer gate
// existed at all (counselors B3 on PR #37): A GLYPH ROW CAN APPEAR IN
// SCROLLBACK. A worker that `cat`s a fixture, greps this file, or renders
// another pane's tail draws a prompt row in its own transcript, so a prompt
// row alone is not proof of a live box. Permissive here and this is todo
// 392's `╰` bug rebuilt with a different glyph - a dialog's own
// surroundings proving there is no dialog. Strict here and the guard is
// absent again, which is the bug being fixed. Hence: the prompt row has to
// be BRACKETED BY ITS OWN BORDERS, and that bracket has to sit at the BOTTOM
// of the capture, where claude pins its UI.
//
// THREE FACTS, NOT ONE, because the callers need them apart. `prompt: null`
// with borders found is the PARTIAL drift `hive doctor` reports as
// "unknown": claude has control and a box is on screen, but the glyph or the
// NBSP that finds the prompt row inside it has changed. That state used to
// be founded on the footer matching while findInputBoxRow failed; it is
// founded on the box's own borders now, which is strictly better evidence
// for the same claim. A `null` return here is "no box on screen" - mid-turn
// with the pane not yet drawn, a modal, an unreadable pane.
interface InputBoxAnchor {
  top: number;
  bottom: number;
  prompt: number | null;
}

// How far above the capture's last non-blank row the box's closing border
// may sit. THIS IS THE SCROLLBACK DISCRIMINATOR: claude pins its UI to the
// bottom of the pane, so a live box's closing border is always within the
// status block of the end, while a copy of a box sitting in scrollback has
// the whole rest of the screen underneath it.
//
// MEASURED, both sides. Below the closing border every real capture in
// test/fixtures/panes/ carries three rows (status line, hive's status line,
// mode footer) and footer-slot-taken.txt carries four (a trailing row
// holding only an OSC-8 link). Above it, the smallest dialog block this
// project has captured is nine rows (plan-approval-dialog.txt) and the
// largest fifteen (folder-trust-dialog.txt), so a scrollback COPY of a box
// sitting above a real dialog never lands inside eight.
//
// SAY WHAT THAT DOES NOT COVER, because it is not the same claim and the
// mutation run found the difference. A dialog's OWN rules are inside the
// window: plan-approval-dialog.txt's top rule sits exactly eight rows above
// its last line, and tool-permission-prompt.txt's preview box closes six
// rows above its last line. Neither is rejected by this bound - the first is
// rejected because nothing box-shaped sits above it inside the box, the
// second because BOX_BORDER does not accept a `╰…╯`. Proven by mutation:
// dropping the top-border requirement flips t392plan, and widening
// BOX_BORDER to accept the preview box's corners flips t392prompt. This
// bound is the SCROLLBACK discriminator and only that; it is not, on its
// own, what keeps a dialog from proving there is no dialog.
//
// THE COST OF THE BOUND, stated rather than left to be discovered: a
// `statusLine` command is user-configurable and emits as many lines as it
// likes. Past roughly five status rows the box's border falls outside this
// window, the box reads absent, and todo 399's own bug returns for that
// user - the destructive direction. Chosen anyway, because the alternative
// is no bound, and no bound is the `╰` bug. If someone turns up with a tall
// status line, raise this number; do not remove it.
const BOX_TAIL_ROWS = 8;

// How far above the closing border the top border may sit - i.e. how tall
// the box itself may be. A pending message grows the box DOWNWARD (see
// BOX_BORDER above and multiline-pending.txt), so this is a cap on how much
// unsubmitted text a human can have typed and still be protected. Twenty-four
// rows is far past anything observed and still far short of a capture window
// (~68 rows), which is what keeps a dialog's own rules from pairing up
// across half a screen. A genuinely taller box reads absent, which is the
// destructive direction, so the number is generous on purpose.
const BOX_MAX_ROWS = 24;

// COUNSELORS ROUND 1, ALL THREE SEATS INDEPENDENTLY: THE UPWARD SCAN USED TO
// STOP AT A BLANK ROW AND THAT RE-ARMED THE VERY CLOBBER THIS LANE EXISTS TO
// CLOSE. The justification was "the box claude draws has no blank rows inside
// it". That is measured only for an empty FIRST logical line
// (multiline-empty-first-line.txt), where the prompt row still carries `❯`
// and is non-blank after trim. An empty INTERIOR line is a different screen:
// continuation rows carry no side chrome (measured, multiline-pending.txt),
// so a human typing "paragraph one, blank line, paragraph two" renders a
// genuinely blank row INSIDE the box. Reproduced against the real predicate
// on an isolated tmux server: box `null`, `holdsHumanInput` false, so the
// wake pastes onto the half-typed message and submits it.
//
// AND IT IS THE INCIDENT'S OWN SHAPE, not a constructed one. Pad 142 records
// the message todo 389 destroyed as "92 characters over three logical lines,
// including a deliberate blank line". The first version of this function
// would not have held it.
//
// The stop is gone. What it was actually doing for the dialog path - keeping
// the upward scan from pairing a dialog's own rule with something far above
// it - is done properly by `inputBoxOnScreen` requiring a prompt row (see
// its own comment), because a dialog has no prompt row at all. A blank row
// is not evidence either way and must not be treated as any.
function findInputBox(rows: string[]): InputBoxAnchor | null {
  const text = rows.map((row) => stripControlBytes(stripSgr(row)).trim());

  // Trailing blank rows are an artefact of the pane being taller than what
  // claude drew, not part of the screen. capturePane already strips them for
  // its own callers; inputBoxState reads raw and does not, so the trim
  // happens here and both windows measure "the bottom" the same way.
  let end = text.length - 1;
  while (end >= 0 && text[end] === "") end -= 1;
  if (end < 0) return null;

  let bottom = -1;
  for (let i = end; i >= 0 && end - i <= BOX_TAIL_ROWS; i--) {
    if (BOX_BORDER.test(text[i])) {
      bottom = i;
      break;
    }
  }
  if (bottom < 0) return null;

  // A RULE WIDER THAN THE PANE WRAPS INTO SEVERAL CONSECUTIVE ROWS, AND THEY
  // ARE ONE EDGE. Found by running this lane's own scripts half, not by
  // review: `test/restart-lead.test.mjs` replays the 220-column
  // ready-idle.txt into an 80-column pane, where each 220-character border
  // renders as three rows. The first version took the lowest of those three
  // as `bottom` and then found the SECOND one immediately above it as the
  // top border, so the bracket closed on two rows of the same edge with the
  // prompt row outside it - box absent, hold gone, on a screen that plainly
  // has one. Measured: `paneHasInputBox` false at 80x24 and true at 220x50
  // for the identical fixture.
  //
  // Walking to the TOP of the run rather than just skipping it is the half
  // that matters for `classifyInputBox`, which reads every row between the
  // prompt and this index as message content: leaving `bottom` at the lowest
  // row would splice two rows of `───────` into the text a receipt reports
  // as the human's unsubmitted message.
  //
  // A real claude pane draws to its own width and does not wrap its borders,
  // so this is reachable through a replayed capture, a pane resized under a
  // process that has not redrawn, and any scrollback copy of a wider screen -
  // which is exactly the population the tail bound below is about.
  while (bottom > 0 && BOX_BORDER.test(text[bottom - 1])) bottom -= 1;

  let top = -1;
  for (let i = bottom - 1; i >= 0 && bottom - i <= BOX_MAX_ROWS; i--) {
    if (BOX_TOP_BORDER.test(text[i])) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  // Bottom-up between the two borders: a box holding a multi-line message
  // has one prompt row and plain continuation rows under it, so the LAST
  // glyph row inside the bracket is still the prompt row, and scanning this
  // way keeps the old findInputBoxRow's reasoning ("only the last matching
  // row reflects the pane's current state") without its scrollback exposure.
  let prompt: number | null = null;
  for (let i = bottom - 1; i > top; i--) {
    if (rows[i].includes(PROMPT_GLYPH_NBSP)) {
      prompt = i;
      break;
    }
  }
  return { top, bottom, prompt };
}

// The shared predicate the readiness probe and the dialog discriminator ask,
// and the replacement for INPUT_BOX_PRESENT at both. One definition, for the
// reason CHOICE_DIALOG's own comment gives for the sibling pair: two callers
// deciding "is claude's input box on screen" must not drift onto two
// answers.
//
// IT REQUIRES THE PROMPT ROW, AND THE FIRST VERSION DID NOT. That version
// asked only `findInputBox(...) !== null`, which is TRUE for a prompt-less
// anchor - two rules with nothing recognisable between them. Counselors round
// 1 found it from all three seats independently, and it is this lane
// rebuilding todo 392's `╰` bug with a different glyph, which is the one
// thing the brief said not to do. Reproduced against the real
// paneAwaitingChoice on an isolated tmux server:
//
//     ────────────────────
//      tool preview line
//     ────────────────────
//      Do you want to continue?
//      ❯ 1. Yes
//        2. No
//      Esc to cancel · Tab to amend
//
// awaitingChoice FALSE. A real dialog reading as no dialog, on a screen the
// RETIRED regex classified correctly, because it carries no footer string.
// Delivery would then paste and press Enter, and the Enter picks "1. Yes".
//
// The population is also much wider than the residual first recorded: a
// non-claude pane does not have to PRINT claude's chrome, it only has to emit
// two horizontal rules near the bottom of its output, which pytest, rich, and
// most TUIs do routinely.
//
// SO THE THREE CONSUMERS SPLIT HERE, DELIBERATELY, AND THAT IS THE POINT.
// `inputBoxState` keeps the prompt-less anchor and reports it as "unknown" -
// borders on screen, prompt row not findable, which is the PARTIAL drift
// `hive doctor` warns on and the reason that state still exists. The
// PRESENCE predicate cannot afford the same generosity, because for the
// dialog guard and the readiness probe a false present is the destructive
// direction. One function, two questions, and the answer differs by design:
// "is something box-shaped on screen" is not "is there an input box here to
// type into".
//
// WHAT IT COSTS, stated rather than discovered later: on a pane whose prompt
// GLYPH has drifted, readiness now reads not-ready where the footer regex
// read ready. That is the conservative direction and it is bounded - todo 387
// records that nothing is typed on a false readiness either way, so the cost
// is a spawn that reports `ready: false` and a brief that still lands. The
// alternative is a spawn typing into a pane hive cannot locate the input of.
const inputBoxOnScreen = (screen: string): boolean => findInputBox(screen.split("\n"))?.prompt != null;

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
function classifyInputBox(rows: string[], promptRowIndex: number, boxBottom: number): InputBoxState {
  const promptRow = rows[promptRowIndex];
  const after = promptRow.slice(promptRow.indexOf(PROMPT_GLYPH_NBSP) + PROMPT_GLYPH_NBSP.length);
  const dim = leadingRunIsFaint(after);
  const firstLine = stripControlBytes(stripSgr(after)).trim();

  // THE SCAN STOPS AT THE BOX'S OWN CLOSING BORDER, WHICH THE CALLER NOW
  // KNOWS, AND NO LONGER AT THE FIRST BLANK ROW. Counselors round 1 (the same
  // finding that removed findInputBox's blank-row stop, see its comment)
  // established that an empty INTERIOR logical line renders as a genuinely
  // blank row inside the box - the shape todo 389's own destroyed message
  // had. Stopping there truncated a multi-paragraph pending message at its
  // first paragraph and reported that as its whole content.
  // NOT A HOLD BUG - `state` was already `pending` either way, because the
  // first line carries text - so this never let a wake through. It is a
  // RECEIPT bug: agent_status/agent_output would show a reader one paragraph
  // of a message that has three, and a lead deciding whether it is safe to
  // interrupt someone reads exactly that field. Blank rows still contribute
  // nothing, since the join below filters empty lines out.
  const continuation: string[] = [];
  for (let i = promptRowIndex + 1; i < boxBottom; i++) {
    continuation.push(stripControlBytes(stripSgr(rows[i])).trim());
  }

  const text = [firstLine, ...continuation]
    .filter((line) => line !== "")
    .join(" ")
    .slice(0, TAIL_LINE_CHARS);
  return { state: text === "" ? "empty" : dim ? "ghost" : "pending", text };
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
// cannot be read, or when findInputBox finds no live box on it -- a pane
// whose TUI has not come up, or a modal dialog -- there is legitimately no
// box to report on.
//
// state: "unknown" (should-fix, counselors PR #37 S1) is a DIFFERENT
// failure from null, and collapsing them was itself a bug: a box found by
// its own borders at the bottom of the capture means claude has control and
// is not showing a modal, i.e. an input box IS on screen, so failing to find
// its prompt row (PROMPT_GLYPH_NBSP) bracketed inside those borders means
// the chrome drifted -- claude changed how it draws the glyph or the NBSP --
// not that there is nothing to report. Issue #30 is this exact
// failure shape for a different marker: a chrome change made every spawn's
// readiness check silently return false forever, indistinguishable from a
// slow pane, until someone went looking. Returning plain null here would
// repeat it: a caller cannot tell "box confirmed empty, nothing pending"
// from "the detector stopped working", and both currently read as absent
// from the receipt (inputBoxField omits a null the same as it would omit
// nothing at all). "unknown" is truthy and gets included, so drift is loud.
//
// BRACKETED, NOT MERELY PRESENT (counselors review on PR #37, B3, and todo
// 399's anchor is the second answer to the same finding): this used to trust
// the LAST row anywhere in the window containing the prompt pair, with no
// check that an input box is actually showing right now. That is
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
// TODO 399 REPLACED WHAT "PRESENT" MEANS AND THE WEDGE ABOVE IS WHY THE
// REPLACEMENT COULD NOT BE LOOSE. `cat test/fixtures/panes/real-input.txt`
// renders a whole box - both borders and a real prompt row - not just a
// footer string, so a box anchor that asked only "is a prompt row bracketed
// by rules anywhere in the window" would have re-opened this exact wedge on
// the day it closed the footer one. findInputBox requires the bracket to sit
// at the BOTTOM of the capture, where claude pins its UI, which is what
// tells a live box from a copy of one in scrollback.
// test/fixtures/panes/scrollback-box-above-dialog.txt is that case built
// deliberately, and the mutation it dies against is removing that bound.
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
    const rows = raw.split("\n");
    const box = findInputBox(rows);
    if (box === null) return null;
    return box.prompt === null ? { state: "unknown", text: "" } : classifyInputBox(rows, box.prompt, box.bottom);
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
// informative: `inputBoxOnScreen` (below) is what waitForPaneInput polls for
// as "claude has control and is not showing a modal", and CHOICE_DIALOG on
// its own only means "this text is somewhere on screen". A dialog is
// therefore CHOICE_DIALOG present AND the input box absent -- see
// paneAwaitingChoice and paneChoiceCheck. Fixture-verified both ways: no
// input box in folder-trust-dialog.txt or model-picker-dialog.txt, one in
// ready-idle.txt and busy-mid-turn.txt.
//
// EVERY MENTION OF `INPUT_BOX_PRESENT` FROM HERE TO THE END OF THIS COMMENT
// IS HISTORY, KEPT DELIBERATELY. Todo 399 retired that regex and replaced it
// with the box anchor; the paragraphs below are the record of what the
// footer-matching version got wrong and how, which is the reasoning a future
// widening has to engage with. `inputBoxOnScreen`'s own comment says which
// of those conclusions survived the replacement and which stopped applying.
//
// Both ways of being wrong were weighed and they are not symmetric. A false
// positive holds a wake (or refuses a tool call) for another tick/retry; a
// lead can see it pending. A false negative answers a dialog nobody read. So
// CHOICE_DIALOG stays the loose half of the pair on purpose -- narrowing IT
// would risk missing a real dialog whose wording drifts. INPUT_BOX_PRESENT is
// what carries the precision now, since a modal's defining property is what
// it replaces, not what footer text it happens to render.
//
// Todo 392 found "fixture-verified both ways" above had never checked the
// dialog shape a worker actually stops on first. An ordinary tool-permission
// prompt renders a bordered PREVIEW of the pending change, and that box's own
// closing border is `╰` -- the exact glyph this pair trusted as proof an
// input box, not a dialog, was on screen. `╰` never appears on a genuine idle
// or busy screen; it appears on the dialog's OWN chrome, so the AND collapsed
// and hive answered permission prompts nobody read (test/fixtures/panes/
// tool-permission-prompt.txt). Dropped from INPUT_BOX_PRESENT rather than
// replaced, on the same asymmetry argued two paragraphs up: removing an
// alternative can only move screens from "no dialog" toward "dialog", the
// safe direction. Manual (`default`) permission mode's footer -- "manual
// mode on", with no "(shift+tab to cycle)", the only mode that drops it --
// gained its own alternative in exchange, so a manual-mode worker is not left
// with no INPUT_BOX_PRESENT marker at all (test/fixtures/panes/manual-mode-
// idle.txt). And the plan-approval dialog ("Claude has written up a plan and
// is ready to execute. Would you like to proceed?") renders no "Esc to
// cancel" anywhere on it, so CHOICE_DIALOG missed it outright -- widened to
// match, keeping it the loose half on purpose
// (test/fixtures/panes/plan-approval-dialog.txt).
//
// Todo 392 round 2 review measured two things round 1 assumed rather than
// checked.
//
// M1: every fixture above was captured at 220 columns, and hive splits
// panes by default, so a narrow terminal is the ordinary case, not the
// exotic one. Measured live against claude 2.1.231 at 220/80/60/40 columns:
// "(shift+tab to cycle)" truncates below its own closing paren at 40
// columns, for BOTH auto and plan mode ("auto mode on (shift+tab to
// <blank> ·" -- "cycle)" gone entirely). That is the identical total miss
// D2 argued was serious enough to overturn this file's own "do not widen
// it" rule, reopened for an ordinary auto-mode worker in a narrow split,
// because the only alternative protecting it happened to be measured at
// 220 columns and nowhere narrower. "manual mode on" was never the actual
// fix; a marker that survives truncation is. "mode on" is a substring of
// every mode's footer measured here ("auto mode on", "manual mode on",
// "plan mode on") and matched at every width tested, 40 through 220 --
// replaces "manual mode on" below rather than sitting beside it, since it
// subsumes that alternative entirely. "shift+tab to cycle" stays: it is
// harmless at the widths where it still matches, and dropping it would buy
// nothing now that "mode on" covers the width it used to lose.
//
// M2: "Would you like to proceed", kept in round 1 on the wrap-risk
// argument that used to follow this paragraph, turned out to be exactly
// the ordinary-prose shape that is dangerous for a pane running something
// OTHER than claude (agent_spawn(command: "bash"), say). Claude's chrome
// can never appear on a non-claude pane of its own accord, so the pair
// degenerates to bare CHOICE_DIALOG for that pane, permanently -- the same
// degeneration D2 fixed for manual-mode claude, but with no fix available,
// since there is no claude chrome to add a marker for. Todo 399 does not
// change that, and it does add one narrow case in the other direction (a
// shell that PRINTS claude's chrome - `cat` of a captured fixture - now
// reads box-present where a footer substring would only sometimes have);
// isAwaitingChoiceScreen's own comment states that residual in full. "Esc to cancel" was
// already accepted as low-risk in ordinary shell output; "Would you like to
// proceed? [Y/n]" is installer/CLI output almost verbatim (this project's
// own restart-lead.sh test calls it exactly that). Measured whether the
// plan-approval dialog's own CHROME offers a safer alternative than its
// prose: "ctrl+g to edit in <editor>" appears on every capture taken (Zed
// configured, and EDITOR/VISUAL unset, which falls back to Vim) -- only the
// editor name varies, never the prefix. Replaces "Would you like to
// proceed" below for three reasons at once: it is chrome, not prose, so it
// reads as implausible in ordinary installer/CLI output the same way "Esc
// to cancel" always has; at 18 characters it is short enough not to wrap
// the way the dialog's fuller sentence would on a narrow pane (the
// wrap-risk argument this paragraph used to make for keeping the prose
// short); and it closes the specific new risk this lane's own D3 opened.
//
// "Esc to cancel" is UNCHANGED, and the non-claude-pane degeneration above
// is a residual for it too, not a new one introduced here -- it predates
// this lane and stays accepted at the same low probability it always was.
// Recorded next to the paragraph below that already covers the sibling
// case (the human-input hold failing OPEN on a non-claude pane): this pair
// failing CLOSED forever on one had no equivalent record until now. See
// .claude/rules/tmux-and-panes.md's "THIS PROTECTION IS CLAUDE-CHROME-
// SHAPED" paragraph.
//
// EVERY consumer of this pair goes through isAwaitingChoiceScreen below
// (paneAwaitingChoice, paneChoiceCheck, and everything built on them --
// agent_send, agent_rename, deliver()/deliverable(), noteBlockedWatched,
// agent_list/agent_status) except ONE: maskChoiceMarker (further down this
// file) masks a BARE CHOICE_DIALOG match with no INPUT_BOX_PRESENT pairing
// at all, by design -- it scrubs the string from a wake body regardless of
// whether the pane it was read from was ever really a dialog, so hive
// cannot retype the trigger into the lead's own pane later. An earlier
// version of this comment named deliverable() as a bare-match consumer;
// that was wrong -- deliverable() reads paneAwaitingChoice's PAIRED
// result like everything else, and maskChoiceMarker is the only exception.
const CHOICE_DIALOG = /Esc to cancel|ctrl\+g to edit in/;

// TODO 399 RETIRED `INPUT_BOX_PRESENT`, the regex that used to live here:
// `/for shortcuts|shift\+tab to cycle|mode on|permissions on/`. All four
// alternatives were substrings of the permission-mode footer, all four live
// on ONE line of claude's UI, and claude multiplexes that line with other
// hints, so the predicate went FALSE on a pane that plainly had a box on
// screen. `inputBoxOnScreen` (declared next to the InputBoxState block
// above) replaces it at all three call sites and carries the full argument,
// including why a fifth substring was the wrong repair and why that is not a
// reversal of todo 392's D2/M1 widenings.
//
// The reasoning those widenings established is NOT lost with the regex, and
// it is what the anchor had to satisfy rather than something it made moot:
// D1's "a dialog's own chrome must never prove there is no dialog" is the
// bottom-of-capture bound, and D2/M1's "a total miss on this predicate is
// not the safe failure it looks like" is why the anchor keys on the box,
// which every mode at every width draws identically, instead of on a footer
// whose wording differs per mode and truncates per width. The 40-column and
// manual-mode fixtures those rounds captured still pin exactly what they
// pinned; they now discriminate the box rather than the footer.

// D5: a screen is awaiting a choice when the dialog footer is present AND the
// input box is not -- see the comment above CHOICE_DIALOG for why the pair,
// not the footer alone, is the answer. One function so paneAwaitingChoice and
// paneChoiceCheck cannot drift onto two different definitions of "dialog".
//
// TODO 399 CHANGED THE SECOND HALF, AND THIS IS THE CONSUMER THAT IS HURT BY
// OVER-MATCHING, so say what moved in its direction. The pair used to
// degenerate to bare CHOICE_DIALOG on a REAL claude pane whenever the footer
// slot was taken - .claude/rules/tmux-and-panes.md documented that
// degeneration for NON-claude panes only, where it is at least fail-closed.
// That is closed: the box is still found while the slot holds another hint,
// so the second half stays falsifiable.
//
// In the other direction the anchor is strictly TIGHTER than the regex it
// replaces. A worker whose transcript contains the string "mode on" - this
// lane's own diff, a captured fixture, `hive doctor`'s output - used to
// suppress dialog detection for that pane; it no longer does, because a
// substring is no longer evidence of anything. What can still suppress it is
// a COMPLETE box chrome (top border, prompt row, closing border) rendered
// within BOX_TAIL_ROWS of the bottom of the capture, which is a far narrower
// accident than a substring anywhere in ~68 rows, and which no dialog this
// project has captured produces.
//
// THE RESIDUAL, NARROWED BUT NOT CLOSED. A NON-claude pane still has no
// claude chrome, so the pair still degenerates to bare CHOICE_DIALOG there,
// exactly as before. What is new for that population is the opposite case: a
// shell that `cat`s a captured pane leaves a complete box chrome at the
// bottom of its own screen, so the box now reads PRESENT on a bash pane and
// a CHOICE_DIALOG match there reads as "no dialog". That is a change from
// fail-closed to fail-open for one narrow shape - but only for a box drawn
// with none of the four old footer strings in it, since any fixture carrying
// one already read box-present under the old regex and behaved identically.
// Unchanged for every capture in test/fixtures/panes/ except this lane's own.
//
// TODO 403 GAVE THE TWO HALVES TWO WINDOWS, AND THAT IS THE WHOLE FIX. Every
// caller used to hand ONE screen to both halves - `capturePane`'s narrow
// trim-then-slice window - while `inputBoxState` asked the box the same
// question over the RAW window (see captureRawPane). So BOX_MAX_ROWS (24)
// bound only on the reporting path; here the real cap was the window itself,
// about 13 rows of message. A lead pane holding a taller pending message read
// box-ABSENT, this pair degenerated to bare CHOICE_DIALOG, and if that message
// contained "Esc to cancel" - which a human writing to the lead ABOUT the
// dialog predicate does - agent_send's text path refused forever and
// deliverable() held every wake aimed at that pane. Measured before the fix on
// a real tmux at three pane heights: awaitingChoice `true` and
// inputBoxState `pending` on the same pane at the same instant, two readers of
// one fact disagreeing (test/fixtures/panes/tall-pending-esc-to-cancel.txt).
//
// WHY THE WINDOW IS A PROPERTY OF THE HALF, NOT OF THE CALLER. These two
// halves fail in OPPOSITE directions, which this file has said in words since
// D5 and had never said in code:
//   - CHOICE_DIALOG is the LOOSE half, hurt by OVER-matching. Its false
//     direction is a permanent unclearable dialog on a pane with no box to
//     ever falsify it. It keeps the NARROW window. Unchanged by todo 403,
//     deliberately: widening it is what both of that todo's own candidate
//     fixes did, and a wider window is strictly more worker-controlled
//     transcript for a stray "Esc to cancel" to hide in.
//   - the box is the FALSIFIER, hurt by UNDER-matching. Its false direction
//     deletes the falsifier and degenerates the pair, which is the bug above.
//     It gets the RAW window, the one inputBoxState has always read.
//
// AND THE SAME RULE DECIDES THE OTHER BOX READERS, WHICH ROUND 2 IS WHY THIS
// PARAGRAPH SAYS SO. The first version of this lane finished with "so
// BOX_MAX_ROWS is the only cap on box height anywhere" and moved every box
// read onto the raw window for that uniformity. That is the same mistake one
// level down: the window belongs to the DIRECTION A READER FAILS IN, and box
// readers split too.
//   RAW, because a MISS is what destroys them: inputBoxState (a missed box
//     lets a wake paste over a human's unsubmitted message) and this
//     predicate's falsifier half.
//   NARROW, because being FOOLED is what destroys them: paneHasInputBox
//     (restart-lead.sh's identity check, whose other side is kill-pane) and
//     waitForPaneInput (types as soon as it says yes). Each carries the
//     argument at its own definition.
// So there is deliberately no single answer to "which window does the box
// search read", and the footnote is load-bearing rather than untidy.
//
// THE BLAST RADIUS IS BOUNDED BY BOX_MAX_ROWS, and that is why this is not
// just "a bigger window with better manners". findInputBox anchors BOTTOM-UP:
// the closing border must sit within BOX_TAIL_ROWS of the last non-blank row,
// and that row is the SAME row in both windows (capturePane strips trailing
// blanks before slicing, findInputBox strips them again itself). The upward
// scan is then capped at BOX_MAX_ROWS. So the raw window changes exactly one
// thing - whether a top border that was above the narrow window's own top
// edge is reachable - and cannot admit a box from scrollback, because the
// bottom bound carries that and the bottom bound does not move. Verified
// against scrollback-box-above-dialog.txt, which still reads `true`: its
// `╰…╯` is rejected by BOX_BORDER, not by the window.
//
// THE BAND, WITH THE ARITHMETIC CORRECTED (counselors round 2, opus seat).
// This comment first said "15 to 24 rows up", which is the number for a box
// with exactly 3 rows below its closing border. The general form is
// `(17 - (end - bottom)) + 1` up to BOX_MAX_ROWS, and `end - bottom` runs to
// BOX_TAIL_ROWS (8), so the FLOOR IS 10, not 15. footer-slot-taken.txt
// carries 4 rows below its border and so already sits at 14. Raising
// BOX_TAIL_ROWS - which its own comment invites a future reader to do for a
// tall statusLine - widens this band further, and that is now the second
// thing that number decides rather than the first.
//
// WHAT IT SELLS, AND THE POPULATION IS NOT THE ONE THIS COMMENT FIRST NAMED.
// A screen carrying a COMPLETE box chrome - top border, `❯`+NBSP prompt row,
// closing border within BOX_TAIL_ROWS of the bottom - spanning that band can
// now suppress dialog detection where the truncated window could not see its
// top border. The first version answered that with "no dialog this project
// has captured has a `❯`+NBSP prompt row", which is true and is about the
// WRONG POPULATION: on a claude pane the live box is what suppresses, and
// that is the fix. The screens that are hurt are NON-CLAUDE panes, where this
// pair degenerates to the bare footer match and the box half exists only to
// be spoofed - `cat` of a captured pane, a replayed tail, a nested claude's
// own chrome. That residual predates this lane (todo 399, "ONE NEW RESIDUAL"
// in .claude/rules/tmux-and-panes.md) and this lane WIDENS ITS BAND from
// about 13 rows to 24, and then ships a producer at the new band in its own
// test corpus (tall-pending-esc-to-cancel.txt is a 16-row complete box). The
// structural close is the same one recorded twice already - gate this check
// on isClaudeCommand before it is ever consulted - and it is still a separate
// lane. Said here rather than left to be discovered, because "we widened a
// residual and added a file that reaches it" is the sentence a future reader
// needs.
const isAwaitingChoiceScreen = (tail: string, wide: string): boolean =>
  CHOICE_DIALOG.test(tail) && !inputBoxOnScreen(wide);

// TODO 399, COUNSELORS ROUND 1 (fable, sole seat). THESE TWO EXPORTS EXIST TO
// DELETE TWO HAND-SYNCED COPIES OF THIS PREDICATE, NOT TO WIDEN THE SURFACE.
//
// `scripts/part-c-assert.mjs` and `scripts/restart-lead.sh` each carried
// their OWN transcription of `INPUT_BOX_PRESENT` and the D5 pairing, kept
// honest by sync tests that compared the regex SOURCE TEXT. That structure
// works exactly as long as the predicate is a regex literal, and it broke the
// moment this predicate stopped being one - which is how todo 399's own
// branch went red. Worse than red: `restart-lead.sh` REPAINTS THE LEAD'S PANE,
// and its dialog gate carried the todo 399 defect in full, on the one pane a
// human types into. A lane that fixed the defect in `src/` and left that copy
// alone would have shipped it live.
//
// Three copies with sync tests is a structure that guarantees this lane
// happens again the next time claude's chrome moves. So the copies are gone
// and both scripts call in here instead. `restart-lead.sh` reaches these
// through `node -e` against this repo's own `dist/`, which is the SAME
// pattern and the same fail-closed handling that file already uses for
// `dist/projectYml.js` - see its own comment there, which rejects a bash
// reimplementation for the identical reason: the point is to run what hive
// runs, not a second approximation of it.
//
// PANE-TAKING, NOT SCREEN-TAKING, and that is the half that mattered most for
// the shell copy. `restart-lead.sh` had to reproduce this file's capture
// WINDOW as well as its regex - its `capture_trimmed 18` existed only to
// match `tailCaptureLines()`, and its own comments recorded getting that
// mismatch wrong once already. Handing it a pane id moved the window back
// inside this file, where it cannot drift; `capture_trimmed` itself was dead
// code from that point on and todo 405 deleted it.
//
// TODO 403, ROUND 2: THE NARROW WINDOW, AND THIS FUNCTION IS WHY THE BOX
// SEARCH DOES NOT GET ONE ANSWER EVERYWHERE. The first version of this lane
// moved it to the raw window "for uniformity" and that reversed a decision
// recorded at its own call site, in scripts/restart-lead.sh's F3 paragraph
// (todo 392 round 2): refusal 1's input-box read was deliberately put on the
// narrow window because "a wider raw window only makes the residual worse
// without buying anything back". Both counselors seats found it independently.
//
// THE RULE THIS LANE FOUND APPLIES TO THIS LANE. The window belongs to the
// direction a reader fails in, and the two readers of THIS function both fail
// destructively on a false PRESENT, not on a false absent:
//   - restart-lead.sh refusal 1 uses it as proof the pane is claude, and the
//     thing on the other side of that refusal is `tmux kill-pane`. A bash
//     pane that has merely `cat`-ed a captured fixture - the tall one this
//     lane ADDED to the repo is exactly such a file - reads box-present over
//     the raw window, passes as claude, and gets killed with whatever was
//     running in it.
//   - the post-respawn readiness wait in the same script types as soon as
//     this says yes, so a false present there loses the text it types.
// A false ABSENT costs neither of them anything: refusal 1 is an OR with
// CLAUDE_PANE_CMD, which a real claude satisfies for the pane's whole life
// (its pane_current_command is its own version string), and the readiness
// wait is polling a pane that has just been respawned, where no tall pending
// message can exist yet.
//
// So the tall-lead-message case this lane exists for does not need the raw
// window HERE, and buying it here costs the destructive direction at a caller
// that kills processes. inputBoxState and the dialog half keep the raw window
// for the opposite reason: they are destroyed by a MISS.
export const paneHasInputBox = (target: string): boolean | null => {
  try {
    return inputBoxOnScreen(capturePane(target, tailCaptureLines()));
  } catch {
    return null;
  }
};

// The string-taking form, for a caller that already HAS a screen and must not
// fork a capture for it: `part-c-assert.mjs` reads its tail back through the
// real `agent_output` MCP tool, which has already applied this file's own
// `capturePane` trimming. Same predicate, same file, no second window.
//
// TODO 403: ONE SCREEN IS ALL THIS CALLER HAS, so it is passed to both halves
// and the narrower answer is the one it gets. `part-c-assert.mjs` reads its
// tail back through the real `agent_output` tool, which has already applied
// sanitizeTail - there is no wider window to hand the box half, and inventing
// one would mean forking a capture against a pane this caller does not hold.
// The consequence is the todo 403 defect surviving here: a screen whose box
// is taller than what it was handed reads box-absent and so reads as a
// dialog. Accepted rather than closed, because this caller's screens come
// from a script's own assertion pass over panes it just drove, not from a
// human's half-typed message, and because the direction is the safe one.
export const screenAwaitingChoice = (screen: string): boolean => isAwaitingChoiceScreen(screen, screen);

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
//
// TODO 403. ONE capture-pane fork still, exactly as before: `-S -18` already
// returned the raw rows and `capturePane` discarded them, so reading both
// windows off one raw string costs nothing and adds no tmux call. The footer
// half gets the same narrow window it has always had; the box half gets the
// raw one. See isAwaitingChoiceScreen for why the window belongs to the half.
export function paneAwaitingChoice(target: string): boolean | null {
  try {
    const raw = captureRawPane(target, tailCaptureLines());
    return isAwaitingChoiceScreen(tailWindow(raw, tailCaptureLines()), raw);
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
//
// TODO 403: THREE USES OF ONE CAPTURE NOW, not two - the footer half and the
// receipt tail read the narrow window, the box half reads the raw one. Still
// one fork. This function is agent_send's and agent_rename's refusal path, so
// leaving it on the old single window would have fixed the scheduler's view
// of a pane while the tool a human calls about that same pane kept refusing.
export function paneChoiceCheck(target: string): { awaitingChoice: boolean | null; tail: string } {
  try {
    const raw = captureRawPane(target, tailCaptureLines());
    const tail = tailWindow(raw, tailCaptureLines());
    return { awaitingChoice: isAwaitingChoiceScreen(tail, raw), tail: sanitizeTail(tail) };
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
//
// Todo 392 round 1 review (F5). CHOICE_DIALOG carries two alternatives now
// (D3), so a tail carrying BOTH -- plausible once it is a real alternation
// rather than one fixed phrase, e.g. a worker's transcript that happens to
// quote both dialog shapes -- used to have only the FIRST one masked:
// String.replace with a non-global regex stops after one match. A NEW regex
// is built here rather than adding the `g` flag to the shared CHOICE_DIALOG
// constant: that constant is also driven through `.test()` in
// isAwaitingChoiceScreen, and a global regex's `.test()` is STATEFUL --
// it advances the shared object's own `lastIndex` on every call and resumes
// from there next time, which would make repeated dialog checks against
// different panes silently start missing matches.
//
// Todo 392 round 2 review (F4). The first version built the new regex from
// CHOICE_DIALOG.source alone and claimed that meant "this cannot drift" --
// true for the PATTERN TEXT, false for FLAGS: source carries no flags, so
// an `i` added to CHOICE_DIALOG later (a plausible chrome-drift response,
// since this whole pair stays loose on purpose) would make dialog
// DETECTION case-insensitive while this mask silently stayed
// case-sensitive, restoring the exact self-trigger this function exists to
// prevent through the one path that was supposed to be safe from it.
// CHOICE_DIALOG.flags is read too now, so both halves of the shared
// constant -- pattern and flags -- are derived, and neither can drift from
// it independently of the other. `g` is added only when not already
// present, since CHOICE_DIALOG carrying `g` itself would otherwise produce
// "gg", which V8 accepts but is not the intent.
// Exported on its own so the flag-preservation logic is testable directly:
// CHOICE_DIALOG is module-private, so a test cannot swap in a flagged
// regex to prove this handles one correctly.
export function withGlobalFlag(re: RegExp): RegExp {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

export function maskChoiceMarker(text: string): string {
  return text.replace(withGlobalFlag(CHOICE_DIALOG), "[dialog marker masked]");
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
  // Todo 375, counselors round 2 (F7). attachScripts -> freeViewSessionName ->
  // quietTmux("has-session") reaches tmux, and quietTmux RETHROWS a timeout
  // now, so this line could throw out of ensureAttached where nothing above
  // it can: the probe and the `which` lookup above both degrade to a bare
  // return. agent_spawn and agent_resume call this AFTER committing the pane
  // and the agents row, so a server wedging inside that window made the tool
  // report failure over a worker that is already live and running - and the
  // obvious retry then collides with the row and the name it just created.
  //
  // Auto-attach is BEST-EFFORT everywhere else in this function, so a timeout
  // degrades the way its neighbours already do rather than by a new rule. It
  // catches everything, not only TmuxTimeoutError, for the same reason those
  // neighbours do: no failure to open a convenience window is worth failing a
  // spawn that already succeeded. The wedge itself is not silent - the caller
  // that spawned this worker is about to hit the same server through bounded
  // calls of its own, and `hive doctor` names it.
  let scripts: string[];
  try {
    scripts = attachScripts(tmuxPath, session);
  } catch {
    return;
  }
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
      // TODO 403, ROUND 2: STAYS ON THE NARROW WINDOW, AND THE FOOTNOTE IS
      // THE POINT RATHER THAN AN UNTIDINESS TO REMOVE. This lane moved it to
      // the raw window arguing it was "nearly a no-op" - 30 trimmed rows
      // already hold a box up to about 22 against a 24-row cap - and that
      // both the mutation table and a counselors seat then read as widening
      // the one probe in this file whose false direction loses a human's
      // text silently.
      //
      // The case, which is not the arithmetic: a wrapper named `claude` (a
      // supported launch shape - `mise exec --`, `npx`, an absolute-path
      // shim) prints copied box chrome and then blocks in a bootstrap `read`
      // before exec'ing the real thing. With a 24-row box and eight rows
      // under its closing border the top border sits 32 rows up - outside
      // the 30-row trimmed window, INSIDE the raw one. So the raw window
      // reports ready on a pane claude has not taken, agent_spawn returns
      // ready:true, and the brief that follows is eaten by the wrapper's
      // `read`. That is the exact failure this poll exists to prevent (see
      // its own contract above), reached by widening it.
      //
      // Over-matching is this consumer's destructive direction, the same as
      // paneHasInputBox's; under-matching costs a false ready:false and
      // nothing typed (todo 387). It is not that 30 is the RIGHT number - it
      // is that a box a fresh pane cannot have yet is not worth reaching for
      // at a caller that types on a yes.
      screen = capturePane(target, 30);
    } catch {
      return false;
    }
    // The prompt box border and the shortcuts hint both only appear once the
    // TUI has taken over the pane. This is claude's chrome, so it is coupled
    // to its version: if a redesign drops every marker, every spawn returns
    // false at the timeout and agent_spawn reports ready: false with a note
    // every time. Nothing is typed regardless of this result (todo 387), so
    // the failure mode is a wait that always burns its full ceiling rather
    // than a worker that never gets a line - degraded, not hung, and the
    // system-prompt brief still lands either way. If you are here because
    // ready is always false, check this regex against a current claude
    // before changing the caller.
    //
    // Issue #30. claude 2.1.220 dropped both original markers: the input box
    // is now drawn with a straight rule rather than rounded corners, and the
    // hint line reads "... shift+tab to cycle ... for agents" rather than
    // "for shortcuts". Neither appears anywhere in a captured 2.1.220 ready
    // screen (test/fixtures/panes/ready-idle.txt), which is why every spawn
    // was timing out.
    //
    // TODO 399. What that regex was replaced BY is `inputBoxOnScreen`,
    // shared with the dialog discriminator for the same reason the regex was
    // - one detector, so the pair the discriminator forms cannot drift out
    // of sync with what readiness believes.
    //
    // THIS CONSUMER IS HURT BY OVER-MATCHING (a false ready types a brief
    // into a pane that has not taken the terminal and loses it silently),
    // and the anchor is better for it in both directions. Under-matching:
    // the footer regex reported ready:false on a pane that had been ready
    // the whole time whenever the mode line was showing another hint - issue
    // #30's own failure shape reached by a transient hint rather than a
    // version change, and the reason test/fixtures/panes/footer-slot-taken
    // .txt is in the readiness CASES. Over-matching: a fresh pane's
    // scrollback used to only need the substring "mode on" in it, where it
    // now needs a whole box drawn at the bottom of the capture - and the box
    // IS what "claude has taken the terminal" means, which the footer only
    // ever correlated with.
    if (inputBoxOnScreen(screen)) {
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

// A TIMED-OUT PASTE THE SERVER ALREADY EXECUTED LEAVES HIVE'S OWN TEXT IN THE
// BOX. Counselors round 2, RAISED AND ACCEPTED (todo 375), and recorded HERE
// so whoever next debugs a wake that is held forever has somewhere to start.
// This is four separate bounded children (set-buffer, paste-buffer, sleep,
// send-keys Enter), and execFileSync's timeout kills the CLIENT, not the
// command the server may already have run. So a paste-buffer killed at 10s
// after the server processed it puts the wake body on screen with no Enter
// behind it - and the classifier cannot tell that from a human's unsubmitted
// text (.claude/rules/tmux-and-panes.md: send-keys -l text carries no faint
// attribute), so holdsHumanInput is true and that pane's wakes hold
// indefinitely, past max_wait_at. Nobody typed it; hive did.
//
// Accepted because no seat could construct the state it needs - a server slow
// enough to exceed 10s yet alive enough to execute the command; a fully
// wedged one executes nothing - and because it is strictly better than the
// pre-bound behaviour, which was this call never returning at all. Same
// mechanism, milder: a timed-out set-buffer leaks a named tmux buffer, since
// -d never runs.
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
