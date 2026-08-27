import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROBE_TIMEOUT_MS = 2000;

const SETTLE_MS = 250;

const TMUX_ANSWERED_NO_SERVER = /no server running|error connecting to/;

export function probeScratchSocket(socket, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const sessions = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    }).trim();
    return { state: "live", sessions: sessions === "" ? [] : sessions.split("\n") };
  } catch (e) {
    if (e?.code === "ETIMEDOUT") return { state: "wedged", sessions: [] };

    if (e?.code === "ENOENT") return { state: "gone", sessions: [] };
    const stderr = (typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString() ?? "").trim();
    if (TMUX_ANSWERED_NO_SERVER.test(stderr)) return { state: "gone", sessions: [] };
    return { state: "unknown", sessions: [], reason: stderr || e?.code || String(e?.message ?? e) };
  }
}

export function checkTmuxLeaks(manifestPath) {
  let lines;
  try {
    lines = readFileSync(manifestPath, "utf8").split("\n");
  } catch {

    return { checked: 0, leaks: [], manifestMissing: true };
  }
  const sockets = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  const leaks = [];
  for (const socket of sockets) {
    let probe = probeScratchSocket(socket);

    if (probe.state === "unknown") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLE_MS);
      probe = probeScratchSocket(socket);
    }
    if (probe.state !== "gone") leaks.push({ socket, ...probe });
  }
  return { checked: sockets.length, leaks, manifestMissing: false };
}

export function leakCheckFailed(result, { requireManifest = true } = {}) {
  return result.leaks.length > 0 || (result.manifestMissing && requireManifest);
}

export function describeLeaks(result, { requireManifest = true } = {}) {
  if (result.manifestMissing) {
    return requireManifest
      ? ["no tmux socket manifest was written: no test file called isolateTmux(), which cannot be right"]
      : ["nothing to check: the named target(s) never isolated a tmux server"];
  }
  if (result.leaks.length === 0) {
    return [`no leaked tmux servers: ${result.checked} scratch socket(s) checked, all gone`];
  }

  return [
    `the suite left ${result.leaks.length} tmux server(s) unaccounted for, out of ${result.checked} scratch socket(s):`,
    ...result.leaks.map(({ socket, state, sessions, reason }) => {
      const label =
        state === "wedged"
          ? "WEDGED (did not answer)"
          : state === "unknown"
            ? `UNKNOWN (the probe itself failed: ${reason}) - not proof a server is there, and not proof one is gone`
            : `live, sessions: ${sessions.join(", ") || "none"}`;
      return `  ${label}\n    ${socket}`;
    }),
    "isolateTmux()'s exit-time kill-server (test/helpers.mjs) should have reaped each of these.",
    "Reap by socket, never by pid: tmux -S <socket> kill-server",
    "A WEDGED one will not answer that either - see",
    "  .agents/sessions/dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md",
  ];
}
