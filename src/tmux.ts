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
// A non-default HIVE_DATA_DIR is a documented user setting (README.md), not evidence of a test or a
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

export type InitialPane = { envFlags: string[]; command: string };

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

export function ensureSession(name: string, cwd: string, initial?: InitialPane): SessionStart {
  if (quietTmux("has-session", "-t", `=${name}`)) return { created: false };
  if (untrustedTmuxServer()) throw crossServerRefusal("create a tmux session");
  try {
    const [pane, window] = tmux(
      "new-session", "-d", "-P", "-F", "#{pane_id}\t#{session_name}:#{window_id}", "-s", name, "-c", cwd,
      ...(initial ? [...initial.envFlags, initial.command] : []),
    ).split("\t");
    if (initial) unsetAtSessionScope(name, initial.envFlags);
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

export function windowOwner(window: string): number | null {
  try {
    const value = tmux("show-options", "-w", "-v", "-t", window, "@hive-project-id");
    return value === "" ? null : Number(value);
  } catch {
    return null;
  }
}

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

export function createWindow(
  session: string,
  windowName: string,
  cwd: string,
  envFlags: string[],
  command: string,
  projectId: number | null,

  detach = false,
): { pane: string; window: string } {
  const created = tmux(
    "new-window", ...(detach ? ["-d"] : []), "-P", "-F", "#{pane_id}\t#{session_name}:#{window_id}",
    "-t", `=${session}`, "-n", windowName, "-c", cwd, ...envFlags, command,
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

export async function waitForPaneInput(target: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  const deadline = start + timeoutMs;

  const interval = () => (Date.now() - start < 1000 ? 200 : 500);
  while (Date.now() < deadline) {
    let screen: string;
    try {

      screen = capturePane(target, 30);
    } catch {
      return false;
    }

    if (inputBoxOnScreen(screen)) {
      await sleep(250);
      return true;
    }
    await sleep(interval());
  }
  return false;
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
): Promise<void> {
  if (text.includes("\n")) {
    const buffer = nextBufferName();
    tmux("set-buffer", "-b", buffer, "--", text);
    tmux("paste-buffer", "-d", "-p", "-b", buffer, "-t", target);
  } else {
    tmux("send-keys", "-t", target, "-l", "--", text);
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
