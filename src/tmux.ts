import { execFileSync } from "node:child_process";
import { dataDirTag } from "./dataDir.js";

export function tmux(...args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\n$/, "");
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer | string; message?: string };
    if (err.code === "ENOENT") {
      throw new Error("tmux is not installed. Install it (brew install tmux) to use agent tools.");
    }
    const detail = typeof err.stderr === "string" ? err.stderr.trim() : err.stderr?.toString().trim();
    throw new Error(`tmux ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
}

function quietTmux(...args: string[]): boolean {
  try {
    execFileSync("tmux", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Returns true when the session was created by this call.
export function ensureSession(name: string, cwd: string): boolean {
  if (quietTmux("has-session", "-t", `=${name}`)) return false;
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
export const sessionName = (projectId: number) => `${SESSION_PREFIX}${dataDirTag}${projectId}`;

// Window names double as iTerm tab titles (and notification labels), so they
// carry the project name: "hive - lead", "hive - worker-1".
export const windowTitle = (projectName: string, name: string) => `${projectName} - ${name}`;

// Pane targets are tmux pane ids (%N); everything else is session:window.
export const isPaneTarget = (target: string) => target.startsWith("%");

// list-panes errors on a dead target; display-message would silently fall
// back to a default target and report success.
export function windowAlive(target: string): boolean {
  return quietTmux("list-panes", "-t", target);
}

// One subprocess for the aliveness of every target at once; use this when
// checking many targets (the scheduler tick, agent_list) instead of one
// windowAlive spawn per row.
export interface AliveSnapshot {
  panes: Set<string>;
  windows: Set<string>;
}

export function liveTargets(): AliveSnapshot {
  const snapshot: AliveSnapshot = { panes: new Set(), windows: new Set() };
  try {
    for (const line of tmux("list-panes", "-a", "-F", "#{pane_id} #{session_name}:#{window_id}").split("\n")) {
      const [pane, window] = line.split(" ");
      if (pane) snapshot.panes.add(pane);
      if (window) snapshot.windows.add(window);
    }
  } catch {
    // No tmux server: everything is dead.
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
// guessing a sleep. Returns false on timeout (or a dead pane); the caller
// decides whether to type anyway.
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
    // to its version: if a redesign drops both markers, this returns false at
    // the timeout and the caller falls back to typing anyway, which is the
    // behavior that shipped before this function existed. It degrades, it
    // does not hang.
    if (/╰|for shortcuts/.test(screen)) {
      await sleep(250);
      return true;
    }
    await sleep(interval());
  }
  return false;
}

export async function sendText(target: string, text: string, submit = true): Promise<void> {
  if (text.includes("\n")) {
    tmux("set-buffer", "-b", "hive-input", "--", text);
    tmux("paste-buffer", "-d", "-p", "-b", "hive-input", "-t", target);
  } else {
    tmux("send-keys", "-t", target, "-l", "--", text);
  }
  if (submit) {
    await sleep(300);
    tmux("send-keys", "-t", target, "Enter");
  }
}
