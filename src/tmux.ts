import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { attachMode, AutoAttach, resolvedAutoAttach } from "./config.js";
import {
  DEFAULT_DATA_DIR,
  dataDirTag,
  isDefaultStore,
  isProductEntryPoint,
  storeDir,
  underTestRunner,
} from "./dataDir.js";

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

const TMUX_MAX_BUFFER = 16 * 1024 * 1024;

const TMUX_TIMEOUT_MS = 10_000;

function tmuxTimeoutMs(): number {
  const raw = process.env.HIVE_TMUX_TIMEOUT_MS;
  if (raw === undefined) return TMUX_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : TMUX_TIMEOUT_MS;
}

export function tmuxTimeoutOverride(): number | null {
  return process.env.HIVE_TMUX_TIMEOUT_MS === undefined ? null : tmuxTimeoutMs();
}

// A third question from untrustedTmuxServer() (private socket + default store) and ensureAttached()
// (socket alone): refuses a NON-DEFAULT store paired with the SHARED socket, the shape produced once
// TMUX_TMPDIR has gone unreachable. See .claude/rules/store-and-datadir.md.
//
// A non-default HIVE_DATA_DIR is a documented user setting (docs/configuration.md), not evidence of a test or a
// hand-rolled driver on its own - namespacing session names by data-dir tag exists precisely so a
// custom store can share the real server. So this only fires for the shapes todo 368 is actually
// about: a test runner, or a process that is not hive's own CLI/MCP/hooks entry point at all. A real
// `hive lead` (or any product entry point) with a custom store is exempt, matching storeDir()'s own
// defaultStoreRefusal() reasoning one door over.
export function scratchStoreOnSharedSocket(): boolean {
  if (privateTmuxSocket(process.env.TMUX, process.env.TMUX_TMPDIR)) return false;
  if (!underTestRunner() && isProductEntryPoint()) return false;
  try {
    return !isDefaultStore(storeDir());
  } catch {

    return false;
  }
}

// Names whichever input tmuxSocketPath() actually decided on, not just TMUX_TMPDIR: TMUX's first
// field wins whenever it is set, so a TMUX_TMPDIR that is itself fine can be entirely irrelevant to
// why the socket resolved to the shared one, and blaming it anyway leaves the advice unable to clear
// the refusal.
function decidingTmuxInput(): { because: string; remedy: string } {
  const inherited = process.env.TMUX?.split(",")[0];
  if (inherited) {
    return {
      because: `an inherited TMUX names the shared socket directly (TMUX=${process.env.TMUX})`,
      remedy: "Unset TMUX - it wins over TMUX_TMPDIR here, so changing TMUX_TMPDIR cannot clear this",
    };
  }
  if (process.env.TMUX_TMPDIR) {
    const dir = process.env.TMUX_TMPDIR;
    return realpathOr(dir, null) === null
      ? {
          because: `TMUX_TMPDIR (${dir}) is set but unreachable`,
          remedy: "Recreate that directory, or point TMUX_TMPDIR at a private one this process can reach",
        }
      : {
          because: `TMUX_TMPDIR (${dir}) is reachable but resolves to the shared socket`,
          remedy: "Point TMUX_TMPDIR at a private directory instead - it exists, so recreating it changes nothing",
        };
  }
  return {
    because: "TMUX_TMPDIR is unset",
    remedy: "Set TMUX_TMPDIR to a private directory this process can reach",
  };
}

function refuseIfSharedSocketFromScratchStore(): void {
  if (!scratchStoreOnSharedSocket()) return;
  const resolved = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
  const { because, remedy } = decidingTmuxInput();
  throw new Error(
    `Refusing to run tmux against the shared socket ${resolved}: HIVE_DATA_DIR is a scratch store ` +
      `(${storeDir()}) and the resolved socket is the shared one because ${because}. ${remedy} - ` +
      "rather than letting this call fall through to the server every other lead and worker on this " +
      "machine depends on.",
  );
}

export function tmux(...args: string[]): string {
  refuseIfSharedSocketFromScratchStore();
  return tmuxWithin(tmuxTimeoutMs(), ...args);
}

function tmuxWithin(timeoutMs: number, ...args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: TMUX_MAX_BUFFER,
      timeout: timeoutMs,

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

const NOTHING_THERE = /no server running|error connecting to|no current target|can't find (pane|window|session)/;

// "no server running" is tmux ANSWERING that the socket is empty. A missing binary is nobody
// answering at all, and the two must never read the same to anything that reports a death.
export function tmuxNotInstalled(e: unknown): boolean {
  return e instanceof TmuxError && e.notInstalled;
}

export function tmuxSaysNothingThere(e: unknown): boolean {

  if (e instanceof TmuxTimeoutError) return false;
  if (!(e instanceof TmuxError)) return false;

  if (e.notInstalled) return true;
  return NOTHING_THERE.test(e.stderr);
}

function quietTmux(...args: string[]): boolean {
  try {
    tmux(...args);
    return true;
  } catch (e) {
    if (e instanceof TmuxTimeoutError) throw e;
    return false;
  }
}

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

export type SessionStart = { created: true; pane: string; window: string } | { created: false };

export type InitialPane = { envFlags: string[]; command: string } | { bare: true };

export function envFlagKeys(envFlags: string[]): string[] {
  return envFlags.filter((_, i) => i % 2 === 1).map((pair) => pair.split("=")[0]);
}

// `new-session -e` sets the SESSION's environment, not the new pane's, and this session is shared by
// every project on the machine: see .claude/rules/tmux-and-panes.md.
function unsetAtSessionScope(name: string, envFlags: string[]): void {
  const keys = envFlagKeys(envFlags);
  if (keys.length === 0) return;
  const argv = keys.flatMap((key, i) => (i === 0 ? [] : [";"]).concat(["set-environment", "-t", `=${name}`, "-u", key]));
  try {
    tmux(...argv);
  } catch {
    // Swallowed because the session and its pane are already live: throwing here strands a running
    // worker to tidy an environment. The cost is real - a failure leaves HIVE_PROJECT_LOCK and
    // HIVE_PROJECT_PATH at session scope, silently, for that session's whole life.
  }
}

export function ensureSession(name: string, cwd: string, initial: InitialPane): SessionStart {
  if (quietTmux("has-session", "-t", `=${name}`)) return { created: false };
  if (untrustedTmuxServer()) throw crossServerRefusal("create a tmux session");
  try {
    const [pane, window] = tmux(
      "new-session", "-d", "-P", "-F", "#{pane_id}\t#{session_name}:#{window_id}", "-s", name, "-c", cwd,
      ...(initial && "command" in initial ? [...initial.envFlags, initial.command] : []),
    ).split("\t");
    if (initial && "command" in initial) unsetAtSessionScope(name, initial.envFlags);
    return { created: true, pane, window };
  } catch (e) {
    if (!isDuplicateSession(e)) throw e;
    return { created: false };
  }
}

export function isDuplicateSession(e: unknown): boolean {
  return e instanceof TmuxError && /duplicate session/.test(e.stderr);
}

export function claimInitialWindow(
  start: { pane: string; window: string },
  windowName: string,
  projectId: number | null,
): { pane: string; window: string } {
  const { pane, window } = start;
  configureHiveWindow(window, true, projectId);
  tmux("rename-window", "-t", window, windowName);
  return { pane, window };
}

export const SESSION_PREFIX = "hive-";

export const sessionName = () => `${SESSION_PREFIX}${dataDirTag()}main`;

export const viewSessionName = () => `${SESSION_PREFIX}${dataDirTag()}view-${process.pid}`;

function freeViewSessionName(): string {
  const base = viewSessionName();
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!quietTmux("has-session", "-t", `=${candidate}`)) return candidate;
  }
  throw new Error(`could not find a free view session name based on ${base} after 1000 attempts`);
}

export const isViewSessionName = (name: string): boolean => /view-\d+(-\d+)?$/.test(name);

export const windowTitle = (projectName: string, name: string) => `${projectName} - ${name}`;

export const isPaneTarget = (target: string) => target.startsWith("%");

export type Liveness = boolean | null;

const DEFAULT_TMUX_TMPDIR = "/tmp";

const realpathOr = (path: string, fallback: string | null): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return fallback;
  }
};

const canonical = (path: string): string => realpathOr(path, path) ?? path;

const socketUnder = (base: string): string =>
  join(canonical(base), `tmux-${process.getuid?.() ?? 0}`, "default");

function canonicalSocketPath(path: string): string {
  const uidDir = dirname(path);
  const base = dirname(uidDir);
  return join(canonical(base), basename(uidDir), basename(path));
}

export function tmuxSocketPath(tmux: string | undefined, tmuxTmpDir: string | undefined): string {

  const inherited = tmux?.split(",")[0];
  if (inherited) return canonicalSocketPath(inherited);

  const reachable = tmuxTmpDir ? realpathOr(tmuxTmpDir, null) : null;
  return socketUnder(reachable ?? DEFAULT_TMUX_TMPDIR);
}

export const defaultTmuxSocketPath = (): string => socketUnder(DEFAULT_TMUX_TMPDIR);

export const SCRATCH_SOCKET_PREFIX = "hive-tmux-";

export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

const ORPHAN_WARN_COUNT = 5;

export function orphansWorthWarningAbout(orphans: OrphanScratchServers): boolean {
  return orphans.wedged > 0 || orphans.live >= ORPHAN_WARN_COUNT;
}

const ORPHAN_PROBE_BUDGET_MS = 5000;

const ORPHAN_PROBE_TIMEOUT_MS = 2000;

export interface OrphanScratchServers {

  candidates: number;

  aged: number;
  probed: number;

  live: number;

  wedged: number;
  oldestMs: number | null;

  sockets: string[];

  entries: { socket: string; state: "live" | "wedged"; ageMs: number }[];
}

export function orphanScratchServers(options: { minAgeMs?: number; budgetMs?: number } = {}):
  | OrphanScratchServers
  | null {
  try {
    if (process.env.HIVE_ORPHAN_SCRATCH_JSON) {
      return JSON.parse(process.env.HIVE_ORPHAN_SCRATCH_JSON) as OrphanScratchServers;
    }
  } catch {

  }
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const budgetMs = options.budgetMs ?? ORPHAN_PROBE_BUDGET_MS;
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return null;
  }

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

  const base = canonical(tmpdir());
  const uidDir = `tmux-${process.getuid?.() ?? 0}`;
  for (const entry of entries) {
    if (!entry.startsWith(SCRATCH_SOCKET_PREFIX)) continue;
    const socket = join(base, entry, uidDir, "default");
    if (socket === liveSocket) continue;
    let mtimeMs: number;
    try {

      mtimeMs = statSync(socket).mtimeMs;
    } catch {

      continue;
    }
    result.candidates += 1;
    const ageMs = now - mtimeMs;
    if (ageMs < minAgeMs) continue;
    aged.push({ socket, ageMs });
  }
  result.aged = aged.length;

  aged.sort((a, b) => b.ageMs - a.ageMs);
  for (const candidate of aged) {
    if (Date.now() > deadline) break;
    result.probed += 1;
    let state: "live" | "wedged" | "gone";
    try {

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

export function untrustedTmuxServer(): boolean {
  if (!privateTmuxSocket(process.env.TMUX, process.env.TMUX_TMPDIR)) return false;
  try {

    return isDefaultStore(storeDir());
  } catch {

    return true;
  }
}

export function targetLive(target: string): Liveness {
  return targetLiveProbe(target).live;
}

export interface PaneProbe {
  live: Liveness;
  pid: string | null;
}

export function targetLiveProbe(target: string): PaneProbe {
  if (target === "") return { live: false, pid: null };
  if (untrustedTmuxServer()) return { live: null, pid: null };
  try {

    const rows = tmux("list-panes", "-t", target, "-F", "#{pane_id} #{pane_pid}")
      .split("\n")
      .map((line) => line.split(" "));
    const pid = isPaneTarget(target) ? (rows.find(([id]) => id === target)?.[1] ?? null) : null;
    return { live: true, pid };
  } catch (e) {
    return { live: tmuxSaysNothingThere(e) ? false : null, pid: null };
  }
}

// Distinct from targetLiveProbe: a remain-on-exit pane the caller is deliberately holding open
// still LISTS (targetLiveProbe would call it live), but its process has exited and #{pane_dead}
// says so. Same classify-rather-than-guess shape as targetLiveProbe: a genuinely unreadable probe
// (a timeout, an untrusted server) answers null, never a guessed true or false.
//
// `list-panes -t <pane-id>` lists every pane in that pane's WINDOW, not just the one named - the
// same reason targetLiveProbe below filters rows by id instead of reading the first line.
export function paneProcessExited(target: string): boolean | null {
  if (untrustedTmuxServer()) return null;
  try {
    const rows = tmux("list-panes", "-t", target, "-F", "#{pane_id} #{pane_dead}")
      .split("\n")
      .map((line) => line.split(" "));
    const match = rows.find(([id]) => id === target);
    return match ? match[1] === "1" : true;
  } catch (e) {
    return tmuxSaysNothingThere(e) ? true : null;
  }
}

export interface AliveSnapshot {
  panes: Set<string>;
  windows: Set<string>;

  pids: Map<string, string>;

  serverAnswered?: boolean;
}

export function liveTargets(): AliveSnapshot | null {

  if (untrustedTmuxServer()) return null;
  const snapshot: AliveSnapshot = { panes: new Set(), windows: new Set(), pids: new Map(), serverAnswered: true };
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
    if (!tmuxSaysNothingThere(e)) return null;
    snapshot.serverAnswered = !tmuxNotInstalled(e);
    return snapshot;
  }
  return snapshot;
}

export function targetAlive(target: string, snapshot: AliveSnapshot): boolean {
  return isPaneTarget(target) ? snapshot.panes.has(target) : snapshot.windows.has(target);
}

export function targetPid(target: string, snapshot: AliveSnapshot): string | null {
  return snapshot.pids?.get(target) ?? null;
}

export function panePid(target: string): string {
  return targetLiveProbe(target).pid ?? "";
}

const DESTROY_READINESS_BOUND_MS = 200;

function paneHasEstablishedProcess(pid: string): boolean {
  try {
    const status = execFileSync("ps", ["-o", "pgid=", "-o", "tty=", "-p", pid], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 50,
      killSignal: "SIGKILL",
    }).trim();
    const [pgid, tty] = status.split(/\s+/, 2);
    return pgid === pid && !!tty && tty !== "?";
  } catch {
    return false;
  }
}

export function waitForPaneEstablished(
  target: string,
  timeoutMs = DESTROY_READINESS_BOUND_MS,
  probe: (pid: string) => boolean = paneHasEstablishedProcess,
  pidLookup: (target: string) => string = panePid,
): void {
  let pid: string;
  try {
    pid = pidLookup(target).trim();
  } catch {
    return;
  }
  if (!/^\d+$/.test(pid)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe(pid)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, remaining));
  }
}

export function foreignSocket(recorded: string): boolean {
  return recorded !== "" && recorded !== tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
}

export function rowLive(recordedSocket: string, target: string): Liveness {
  return foreignSocket(recordedSocket) ? null : targetLive(target);
}

export function rowAlive(recordedSocket: string, target: string, snapshot: AliveSnapshot): Liveness {
  return foreignSocket(recordedSocket) ? null : targetAlive(target, snapshot);
}

export function rowLiveProbe(recordedSocket: string, target: string): PaneProbe {
  return foreignSocket(recordedSocket) ? { live: null, pid: null } : targetLiveProbe(target);
}

export function rowAliveProbe(recordedSocket: string, target: string, snapshot: AliveSnapshot): PaneProbe {
  if (foreignSocket(recordedSocket)) return { live: null, pid: null };
  const live = targetAlive(target, snapshot);
  return { live, pid: live ? targetPid(target, snapshot) : null };
}

export function paneReissued(recordedPid: string, probe: PaneProbe): boolean {
  return probe.live === true && recordedPid !== "" && probe.pid !== null && probe.pid !== recordedPid;
}

export const RAW_ATTACH_TMUX_CONFIG = [
  "set -g allow-passthrough all",
];
export const TMUX_DOC = "docs/tmux.md";

export function configureHiveWindow(window: string, created: boolean, projectId: number | null): void {
  try {
    if (!created) {

      const owned = tmux("list-panes", "-t", window, "-F", "#{@hive-owned}").split("\n")[0];
      if (owned !== "1") return;
    }

    tmux(
      ...(created ? ["set-window-option", "-t", window, "@hive-owned", "1", ";"] : []),

      ...(created && projectId != null
        ? ["set-window-option", "-t", window, "@hive-project-id", String(projectId), ";"]
        : []),
      "set-window-option", "-t", window, "allow-passthrough", "all", ";",
      "set-window-option", "-t", window, "pane-border-status", "top", ";",
      "set-window-option", "-t", window, "pane-border-format", " #{pane_index} #{pane_title} ", ";",
      "set-window-option", "-t", window, "monitor-bell", "on", ";",

      "set-window-option", "-t", window, "window-size", "smallest",
    );
  } catch {

  }
}

export interface OwnedWindow {
  window: string;
  projectId: string;
  processesOf: string;
}

// Both stamps in one list-windows: a window is found by a stamp and never by its name, and every
// caller that wants one of these wants to know about the other in the same breath.
export function listOwnedWindows(session: string): OwnedWindow[] {
  return tmux(
    "list-windows", "-t", `=${session}`,
    "-F", `#{session_name}:#{window_id}\t#{@hive-project-id}\t#{${PROCESSES_WINDOW_OPTION}}`,
  )
    .split("\n")
    .map((row) => {
      const [window, projectId = "", processesOf = ""] = row.split("\t");
      return { window, projectId, processesOf };
    });
}

const ownsProject = (w: OwnedWindow, projectId: number): boolean => Number(w.projectId) === projectId;

const holdsProcesses = (w: OwnedWindow, projectId: number): boolean =>
  w.processesOf !== "" && Number(w.processesOf) === projectId;

export function findProjectWindow(session: string, projectId: number): string | undefined {
  return listOwnedWindows(session).find((w) => ownsProject(w, projectId))?.window;
}

export function windowOwner(window: string): number | null {
  try {
    const value = tmux("show-options", "-w", "-v", "-t", window, "@hive-project-id");
    return value === "" ? null : Number(value);
  } catch {
    return null;
  }
}

// Its own stamp, never @hive-project-id: findProjectWindow takes the FIRST window carrying that one,
// so a processes window wearing it would be handed out as the project's window.
export const PROCESSES_WINDOW_OPTION = "@hive-processes-of";

export const processesWindowName = (projectName: string) => `${projectName}/processes`;

export const processesPaneTitle = (projectName: string, name: string) =>
  `${processesWindowName(projectName)} · ${name}`;

export const PROCESSES_LAYOUT: WindowLayout = "tiled";

export function findProcessesWindow(session: string, projectId: number): string | undefined {
  return listOwnedWindows(session).find((w) => holdsProcesses(w, projectId))?.window;
}

// The whole definition of a processes window, so the spawn path and hide's recreate path cannot
// drift: hive's own window options, its stamp, and the rename lock that keeps its name.
export function makeProcessesWindow(window: string, projectId: number): void {
  configureHiveWindow(window, true, null);
  try {
    tmux(
      "set-window-option", "-t", window, PROCESSES_WINDOW_OPTION, String(projectId), ";",
      "set-window-option", "-t", window, "automatic-rename", "off",
    );
  } catch {

  }
}

// GLOBAL, appended: every narrower scope dies with its window (.claude/rules/tmux-and-panes.md).
export function appendGlobalHook(hook: string, command: string): void {
  try {
    tmux("set-hook", "-ga", hook, command);
  } catch {

  }
}

// tmux can only unset a hook's whole array, so replacing one entry means writing them all back.
export function replaceGlobalHooks(hook: string, commands: string[]): void {
  try {
    tmux("set-hook", "-gu", hook);
    for (const command of commands) tmux("set-hook", "-ga", hook, command);
  } catch {

  }
}

// Hooks live in the options table and read back as `pane-exited[0] <command>`, never from show-hooks.
export function globalHooks(hook: string): string[] {
  try {
    const prefix = new RegExp(`^${hook}(\\[\\d+\\])? `);
    return tmux("show-options", "-g", hook)
      .split("\n")
      .filter((row) => prefix.test(row))
      .map((row) => row.replace(prefix, ""));
  } catch {
    return [];
  }
}

export const shownPaneTitle = (projectName: string, name: string) => `${projectName}/${name}`;

export type PaneVisibility = "shown" | "hidden" | "window";

export interface ProjectWindows {
  processes: string | undefined;
  project: string | undefined;
}

// Read once per command or dashboard tick, not once per process: the two lookups are the whole cost
// of deriving visibility, and paneVisibility below then costs one call per pane.
export function projectWindows(session: string, projectId: number): ProjectWindows | null {
  try {
    const windows = listOwnedWindows(session);
    return {
      processes: windows.find((w) => holdsProcesses(w, projectId))?.window,
      project: windows.find((w) => ownsProject(w, projectId))?.window,
    };
  } catch (e) {

    // Two different answers, and collapsing them makes a failed read look like a located pane: tmux
    // saying there is no session is "no windows", undefined per window. A timeout, a wedged server
    // or no tmux at all is nobody answering, and the caller must say it cannot tell.
    return tmuxSaysNothingThere(e) && !tmuxNotInstalled(e) ? { processes: undefined, project: undefined } : null;
  }
}

// Compared on the WINDOW ID alone: paneWindow answers with whichever grouped session tmux picks,
// so once a human is attached its session half is the view's name and never the base session's.
const sameWindow = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.split(":")[1] === b.split(":")[1];

export function paneVisibility(pane: string, windows: ProjectWindows): PaneVisibility | null {
  const current = paneWindow(pane);
  if (!current) return null;
  if (sameWindow(current, windows.processes)) return "hidden";
  if (sameWindow(current, windows.project)) return "shown";
  return "window";
}

// `#{window_panes}` off the pane itself, so the caller needs no window id: break-pane on a lone pane
// is a rename in place, not a move, and hands back the window it started in.
export function paneIsAloneInWindow(pane: string): boolean | null {
  try {
    const count = Number(tmux("display-message", "-p", "-t", pane, "#{window_panes}"));
    return Number.isFinite(count) ? count <= 1 : null;
  } catch {
    return null;
  }
}

export function setPaneTitle(target: string, title: string): void {
  try {
    tmux("select-pane", "-t", target, "-T", title);
  } catch {

  }
}

export function adoptableWindow(session: string, projectId: number, pane: string): string | null {
  const paneWin = paneWindow(pane);
  if (!paneWin) return null;
  const windowId = paneWin.split(":")[1];
  const match = listOwnedWindows(session).find((w) => w.window.split(":")[1] === windowId);
  if (!match) return null;
  const owner = match.projectId === "" ? null : Number(match.projectId);
  if (owner !== null && owner !== projectId) return null;
  return `${session}:${windowId}`;
}

// Chained into the SAME tmux invocation that creates the pane, never issued as a follow-up call:
// a command that errors and exits can be gone before a second, separate call would run, and the
// only fact this option needs to reach is the first tick of the process's own life. See
// .claude/skills/hive-internals/references/tmux-and-panes.md for the measurement.
export function retainOnExitArgs(target: string): string[] {
  return [";", "set-window-option", "-t", target, "remain-on-exit", "on"];
}

export function setRemainOnExit(target: string, on: boolean): void {
  try {
    tmux("set-window-option", "-t", target, "remain-on-exit", on ? "on" : "off");
  } catch {
    // The pane may already be gone; nothing left to toggle.
  }
}

// Captures a dead (remain-on-exit) pane's final content. capturePane's trailing-blank trim is the
// wrong shape here: a short-lived command's output sits near the top of a full-height pane, with
// tmux's own "Pane is dead" trailer as the last, non-blank line - so a plain tail-of-N reads as
// blank padding plus the trailer. Filtering ALL blank lines first, not just trailing ones, recovers
// the real content.
export function captureFinalScreen(target: string, lines: number): string {
  try {
    const rows = captureRawPane(target, Math.max(lines * 10, 200))
      .split("\n")
      .filter((row) => row.trim() !== "");
    return rows.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

export function createWindow(
  session: string,
  windowName: string,
  cwd: string,
  envFlags: string[],
  command: string,
  projectId: number | null,

  detach = false,
  retainOnExit = false,
): { pane: string; window: string } {
  const created = tmux(
    "new-window", ...(detach ? ["-d"] : []), "-P", "-F", "#{pane_id}\t#{session_name}:#{window_id}",
    "-t", `=${session}`, "-n", windowName, "-c", cwd, ...envFlags, command,
    ...(retainOnExit ? retainOnExitArgs(`=${session}:${windowName}`) : []),
  );
  const [pane, window] = created.split("\t");
  configureHiveWindow(window, true, projectId);
  return { pane, window };
}

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

export function callerSession(): string | null {
  try {
    const attached = tmux("display-message", "-p", "#{client_session}");
    if (attached) return attached;
  } catch {

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

const MAIN_PANE_OPTION: Partial<Record<WindowLayout, { option: string; dimension: string }>> = {
  "main-vertical": { option: "main-pane-width", dimension: "#{window_width}" },
  "main-horizontal": { option: "main-pane-height", dimension: "#{window_height}" },
};

function sizeMainPane(window: string, spec: { option: string; dimension: string }): void {
  try {
    tmux("set-window-option", "-t", window, spec.option, "50%");
    return;
  } catch {

  }

  const cells = Math.floor(Number(tmux("list-panes", "-t", window, "-F", spec.dimension).split("\n")[0]) / 2);
  if (Number.isFinite(cells) && cells > 0) {
    tmux("set-window-option", "-t", window, spec.option, String(cells));
  }
}

export function applyLayout(window: string, layout: WindowLayout): void {
  try {
    const main = MAIN_PANE_OPTION[layout];
    if (main) sizeMainPane(window, main);
    tmux("select-layout", "-t", window, layout);
    tmux("set-window-option", "-t", window, "@hive-layout", layout);
  } catch {

  }
}

export function windowLayout(window: string): WindowLayout | null {
  try {
    const value = tmux("list-panes", "-t", window, "-F", "#{@hive-layout}").split("\n")[0];
    return isWindowLayout(value) ? value : null;
  } catch {
    return null;
  }
}

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

export function paneTitle(target: string): string | null {
  try {
    return tmux("display-message", "-p", "-t", target, "#{pane_title}");
  } catch {
    return null;
  }
}

export function captureRawPane(target: string, lines: number): string {
  return tmux("capture-pane", "-p", "-t", target, "-S", `-${lines}`);
}

export function tailWindow(raw: string, lines: number): string {
  const rows = raw.split("\n");
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.slice(-lines).join("\n");
}

export function capturePane(target: string, lines: number): string {
  return tailWindow(captureRawPane(target, lines), lines);
}

const PROMPT_GLYPH_NBSP = "❯ ";

const SGR_ESCAPE = /\x1b\[[0-9;]*m/g;

const stripSgr = (s: string): string => s.replace(SGR_ESCAPE, "");

function leadingRunIsFaint(s: string): boolean {
  const leadingRun = /^(?:\x1b\[[0-9;]*m)*/.exec(s)?.[0] ?? "";
  let faint = false;
  for (const seq of leadingRun.match(SGR_ESCAPE) ?? []) {
    const params = seq.slice(2, -1).split(";").filter((p) => p !== "");
    if (params.length === 0) {
      faint = false;
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

export const holdsHumanInput = (box: InputBoxState | null): boolean => box?.state === "pending";

const BOX_BORDER = /^─+$/;

const BOX_TOP_BORDER = /^─{4,}/;

interface InputBoxAnchor {
  top: number;
  bottom: number;
  prompt: number | null;
}

const BOX_TAIL_ROWS = 8;

const BOX_MAX_ROWS = 24;

function findInputBox(rows: string[]): InputBoxAnchor | null {
  const text = rows.map((row) => stripControlBytes(stripSgr(row)).trim());

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

  while (bottom > 0 && BOX_BORDER.test(text[bottom - 1])) bottom -= 1;

  let top = -1;
  for (let i = bottom - 1; i >= 0 && bottom - i <= BOX_MAX_ROWS; i--) {
    if (BOX_TOP_BORDER.test(text[i])) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  let prompt: number | null = null;
  for (let i = bottom - 1; i > top; i--) {
    if (rows[i].includes(PROMPT_GLYPH_NBSP)) {
      prompt = i;
      break;
    }
  }
  return { top, bottom, prompt };
}

const inputBoxOnScreen = (screen: string): boolean => findInputBox(screen.split("\n"))?.prompt != null;

function classifyInputBox(rows: string[], promptRowIndex: number, boxBottom: number): InputBoxState {
  const promptRow = rows[promptRowIndex];
  const after = promptRow.slice(promptRow.indexOf(PROMPT_GLYPH_NBSP) + PROMPT_GLYPH_NBSP.length);
  const dim = leadingRunIsFaint(after);
  const firstLine = stripControlBytes(stripSgr(after)).trim();

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

const CHOICE_DIALOG = /Esc to cancel|ctrl\+g to edit in/;

const isAwaitingChoiceScreen = (tail: string, wide: string): boolean =>
  CHOICE_DIALOG.test(tail) && !inputBoxOnScreen(wide);

export const paneHasInputBox = (target: string): boolean | null => {
  try {
    return inputBoxOnScreen(capturePane(target, tailCaptureLines()));
  } catch {
    return null;
  }
};

export const screenAwaitingChoice = (screen: string): boolean => isAwaitingChoiceScreen(screen, screen);

// tmux clears the pane's bracketed-paste flag in copy mode, so paste-buffer -p
// sends no markers there and the Enter after it never reaches the application.
export function paneInCopyMode(target: string): boolean | null {
  try {
    return tmux("display-message", "-p", "-t", target, "#{pane_in_mode}").trim() === "1";
  } catch {
    return null;
  }
}

// `-X` must come before `-t`, never after a `--`, which would type it as a key.
export function cancelCopyMode(target: string): boolean {
  if (paneInCopyMode(target) !== true) return false;
  try {
    tmux("send-keys", "-X", "-t", target, "cancel");
    return true;
  } catch {
    return false;
  }
}

export function paneAwaitingChoice(target: string): boolean | null {
  try {
    const raw = captureRawPane(target, tailCaptureLines());
    return isAwaitingChoiceScreen(tailWindow(raw, tailCaptureLines()), raw);
  } catch {
    return null;
  }
}

const TERMINAL_CONTROL_BYTES = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

export const stripControlBytes = (s: string): string => s.replace(TERMINAL_CONTROL_BYTES, "");

const TAIL_LINES = 6;
const TAIL_LINE_CHARS = 160;

export function sanitizeTail(raw: string): string {
  return raw
    .split("\n")
    .map((line) => stripControlBytes(line).trimEnd().slice(0, TAIL_LINE_CHARS))
    .filter((line) => line !== "")
    .slice(-TAIL_LINES)
    .join("\n");
}

const EVENT_DISPLAY_CHARS = 20;
export function sanitizeEventForDisplay(event: string): string {
  const clean = stripControlBytes(event).replace(/[\r\n]+/g, " ");
  return clean.length > EVENT_DISPLAY_CHARS ? `${clean.slice(0, EVENT_DISPLAY_CHARS)}[truncated]` : clean;
}

export const tailCaptureLines = (): number => TAIL_LINES * 3;

export function paneChoiceCheck(target: string): { awaitingChoice: boolean | null; tail: string } {
  try {
    const raw = captureRawPane(target, tailCaptureLines());
    const tail = tailWindow(raw, tailCaptureLines());
    return { awaitingChoice: isAwaitingChoiceScreen(tail, raw), tail: sanitizeTail(tail) };
  } catch {
    return { awaitingChoice: null, tail: "" };
  }
}

// codex's chrome, mirroring the claude section above but never sharing its regexes (see hive-internals).
// codex has no box border to anchor on, so the box's bottom edge used to be inferred from the literal
// text of its footer status line - but that text is not stable (todo 524: two different compositions
// seen on one codex version, one with no shared substring at all). The anchor below reads structure
// instead of content: the pane's own last non-blank row IS the bottom edge, whatever it says.

// codex's own choice-menu shape (see hive-internals), not claude's CHOICE_DIALOG wording. Declared
// above findCodexPromptBox because the box search itself now needs it to reject a choice row rather
// than mistake it for a live prompt.
const CODEX_CHOICE_LINE = /^›\s*\d+\.\s/m;

// codex wraps the arrow in its own SGR reset, so its content's real styling doesn't start at offset 0;
// the arrow and its one trailing space have to be walked off before leadingRunIsFaint can read it.
function codexPromptContentStart(promptRow: string): number {
  const arrow = promptRow.indexOf("›");
  if (arrow < 0) return promptRow.length;
  let i = arrow + 1;
  let escape: RegExpExecArray | null;
  while ((escape = /^\x1b\[[0-9;]*m/.exec(promptRow.slice(i))) !== null) i += escape[0].length;
  if (promptRow[i] === " ") i += 1;
  return i;
}

function findCodexPromptBox(rows: string[]): { footer: number; prompt: number } | null {
  const text = rows.map((row) => stripControlBytes(stripSgr(row)).trim());

  let footer = text.length - 1;
  while (footer >= 0 && text[footer] === "") footer -= 1;
  if (footer < 0) return null;

  let prompt = -1;
  for (let i = footer - 1; i >= 0 && footer - i <= BOX_MAX_ROWS; i--) {
    // The arrow ALONE, against the trimmed row: capture-pane strips a trailing space, and a box with
    // nothing typed is exactly "› " with nothing after it - "› " (with the space) would never match
    // its own genuinely-empty case, only the ones with real content following the arrow.
    if (text[i].startsWith("›")) {
      prompt = i;
      break;
    }
  }
  if (prompt < 0) return null;

  // A choice row also starts with "›" - stop here rather than skip past it and keep climbing, or an
  // older, already-submitted prompt sitting further up scrollback gets mistaken for the live box
  // (measured against codex-sandbox-approval-dialog.txt: its own choice row sits 21 lines below a
  // stale submitted prompt that also starts with "›").
  if (CODEX_CHOICE_LINE.test(text[prompt])) return null;

  // Nothing but the prompt's own continuation, then one blank gap, may sit between the prompt row and
  // the footer. Real content in that gap means the "›" found above is stale scrollback, not the live
  // box - a busy/mid-turn screen can have an old prompt sitting within BOX_MAX_ROWS of whatever text
  // is currently at the bottom, and only this check tells the two apart (see hive-internals).
  let i = prompt + 1;
  while (i <= footer && text[i] !== "") i += 1;
  while (i <= footer && text[i] === "") i += 1;
  if (i !== footer) return null;

  return { footer, prompt };
}

const codexInputBoxOnScreen = (screen: string): boolean => findCodexPromptBox(screen.split("\n")) !== null;

function classifyCodexInputBox(rows: string[], promptRowIndex: number, footerRowIndex: number): InputBoxState {
  const promptRow = rows[promptRowIndex];
  const after = promptRow.slice(codexPromptContentStart(promptRow));
  const dim = leadingRunIsFaint(after);
  const firstLine = stripControlBytes(stripSgr(after)).trim();

  const continuation: string[] = [];
  for (let i = promptRowIndex + 1; i < footerRowIndex; i++) {
    continuation.push(stripControlBytes(stripSgr(rows[i])).trim());
  }

  const text = [firstLine, ...continuation]
    .filter((line) => line !== "")
    .join(" ")
    .slice(0, TAIL_LINE_CHARS);
  return { state: text === "" ? "empty" : dim ? "ghost" : "pending", text };
}

export function codexInputBoxState(target: string): InputBoxState | null {
  try {
    const raw = tmux("capture-pane", "-p", "-e", "-t", target, "-S", `-${tailCaptureLines()}`);
    const rows = raw.split("\n");
    const box = findCodexPromptBox(rows);
    return box === null ? null : classifyCodexInputBox(rows, box.prompt, box.footer);
  } catch {
    return null;
  }
}

export const codexPaneHasInputBox = (target: string): boolean | null => {
  try {
    return codexInputBoxOnScreen(capturePane(target, tailCaptureLines()));
  } catch {
    return null;
  }
};

// codexInputBoxOnScreen used to be broken (todo 524); this line still read correctly, but only because
// CODEX_CHOICE_LINE was independently false on the pane that exposed the bug - correct by coincidence,
// not by construction. See hive-internals for why that distinction matters to a later refactor.
const codexScreenAwaitingChoice = (screen: string): boolean =>
  CODEX_CHOICE_LINE.test(screen) && !codexInputBoxOnScreen(screen);

const CODEX_SPINNER = /^[⠀-⣿]/;

// The bracket marker is measured-unstable (see hive-internals) - match the substring alone.
const CODEX_ACTION_REQUIRED = "Action Required";

// A silent title (codex hasn't written one yet, e.g. a startup dialog) is not "idle" - see hive-internals.
function codexAwaitingChoiceFromTitleAndScreen(title: string | null, screenTail: string): boolean {
  if (title !== null) {
    // Untested combination, so pick the cheap-to-be-wrong direction: a false "blocked" costs a
    // delay, a false "busy, safe to type" is the thing this whole predicate exists to prevent.
    if (title.includes(CODEX_ACTION_REQUIRED)) return true;
    if (CODEX_SPINNER.test(title)) return false;
  }
  return codexScreenAwaitingChoice(screenTail);
}

export function codexPaneChoiceCheck(target: string): { awaitingChoice: boolean | null; tail: string } {
  try {
    const raw = captureRawPane(target, tailCaptureLines());
    const tail = tailWindow(raw, tailCaptureLines());
    return {
      awaitingChoice: codexAwaitingChoiceFromTitleAndScreen(paneTitle(target), tail),
      tail: sanitizeTail(tail),
    };
  } catch {
    return { awaitingChoice: null, tail: "" };
  }
}

export function describePaneChoice(awaitingChoice: boolean | null): string {
  if (awaitingChoice === true) return "awaiting a choice (dialog)";
  if (awaitingChoice === false) return "no dialog";
  return "could not be read";
}

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

export function controlModeFor(iTermDetected: boolean): boolean {
  const mode = attachMode();
  if (mode === "raw") return false;
  if (mode === "control") return true;
  return iTermDetected;
}

export function attachScripts(tmuxPath: string, session: string): string[] {
  const cc = controlModeFor(true) ? ["-CC"] : [];
  const argv = viewSessionChain(session, freeViewSessionName());

  const quotedTmuxPath = shellQuote(tmuxPath);
  return [
    `tell application "iTerm" to create window with default profile command "${quotedTmuxPath} ${renderAttachCommand([...cc, ...argv])}"`,
    `tell application "Terminal" to do script "${quotedTmuxPath} ${renderAttachCommand(argv)}"`,
  ];
}

export function autoAttachProbe(value: AutoAttach, session: string): string[] {
  return value === "on" ? ["list-clients", "-t", `=${session}`] : ["list-clients"];
}

export function ensureAttached(session: string): void {
  if (process.platform !== "darwin") return;

  if (privateTmuxSocket(process.env.TMUX, process.env.TMUX_TMPDIR)) return;
  const { value } = resolvedAutoAttach();
  if (value === "off") return;
  try {
    if (tmux(...autoAttachProbe(value, session)).trim() !== "") return;
  } catch {
    return;
  }

  let tmuxPath: string;
  try {
    tmuxPath = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  } catch {
    return;
  }

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

    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function defaultHasInputBox(target: string): boolean | null {
  try {
    return inputBoxOnScreen(capturePane(target, 30));
  } catch {
    return null;
  }
}

// Classifies WHY a pane never showed its input box, rather than collapsing every non-ready outcome
// into one boolean - the same shape as classifying tmux stderr instead of treating every probe
// failure as unknown (.claude/skills/hive-internals/references/tmux-and-panes.md). "gone" is a
// FACT (the pane's process has already exited); "timeout" means the pane is still alive and simply
// never became ready in time. Collapsing them reads a bad flag and a slow cold start identically.
export type PaneReadinessOutcome = "ready" | "timeout" | "gone";

export async function pollPaneReadiness(
  target: string,
  timeoutMs: number,
  hasInputBox: (target: string) => boolean | null = defaultHasInputBox,
): Promise<PaneReadinessOutcome> {
  const start = Date.now();
  const deadline = start + timeoutMs;

  const interval = () => (Date.now() - start < 1000 ? 200 : 500);
  while (Date.now() < deadline) {
    // paneProcessExited is the SOLE source of truth for "gone". hasInputBox's own null (its
    // contract: a genuinely unreadable probe - a timeout, an untrusted server - never a guessed
    // true or false) must never be read as "exited" on its own: a caller retaining the pane on
    // exit (remain-on-exit) keeps it LISTED, so a pane that is merely hard to read right now
    // still answers false here, not true, and falls through to another poll like any other
    // not-ready tick. A pane genuinely destroyed with no remain-on-exit in play is already caught
    // above, on this same iteration, before hasInputBox is even consulted.
    if (paneProcessExited(target) === true) return "gone";
    if (hasInputBox(target) === true) {
      await sleep(250);
      return "ready";
    }
    await sleep(interval());
  }
  return "timeout";
}

export async function waitForPaneInput(
  target: string,
  timeoutMs: number,
  hasInputBox: (target: string) => boolean | null = defaultHasInputBox,
): Promise<boolean> {
  return (await pollPaneReadiness(target, timeoutMs, hasInputBox)) === "ready";
}

let bufferSeq = 0;
const nextBufferName = () => `hive-input-${process.pid}-${++bufferSeq}`;

export const ENTER_DELAY_MS = 300;

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

export async function sendText(
  target: string,
  text: string,
  submit = true,
  onPasted?: () => void,
  onBuffered?: () => void,
): Promise<void> {
  // tmux hands a pane its input in 1022-byte writes, and only paste-buffer -p
  // brackets them, so send-keys -l loses everything before the last write.
  // An empty text skips the pair: set-buffer creates no buffer for it, so
  // paste-buffer would then fail and the Enter would never be sent.
  if (text !== "") {
    const buffer = nextBufferName();
    // set-buffer names no pane, so its failure cannot have put anything on a
    // screen. Callers tell that from a failed paste by whether onBuffered ran.
    tmux("set-buffer", "-b", buffer, "--", text);
    onBuffered?.();
    try {
      tmux("paste-buffer", "-d", "-p", "-b", buffer, "-t", target);
    } catch (err) {
      // paste-buffer's -d never ran, and nothing ever reclaims a NAMED buffer:
      // buffer-limit trims only automatic ones.
      try {
        tmux("delete-buffer", "-b", buffer);
      } catch {

      }
      throw err;
    }
  }
  try {
    onPasted?.();
  } catch {

  }
  if (submit) {
    await sleep(ENTER_DELAY_MS);
    tmux("send-keys", "-t", target, "Enter");
  }
}
