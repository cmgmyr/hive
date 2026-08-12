// Todo 375 item 3. A leaked test tmux server is SILENT today, so it
// accumulates across runs and across days until something else falls over:
// todo 294 found 227 alive at one point, and a run eventually died with
// "fork failed: Device not configured". This turns that silence into a red
// line.
//
// WHAT IT COVERS THAT scripts/tmux-leak-guard.sh DOES NOT, since the two look
// like the same check and are not. That one greps `ps` for a tmux process
// whose ARGV carries a scratch project path, so it only ever sees a leak
// created with `-c <scratch dir>` (its own header lists four call sites that
// pass no `-c` at all), and it runs in CI only. This one asks each SOCKET the
// suite actually created whether a server is still on it, which needs no argv
// and covers every call site by construction, and it runs on every `npm test`
// including a developer's own.
//
// WHAT IT DOES NOT COVER, said plainly because the gap is the interesting
// half: a server whose SOCKET FILE is gone is invisible here - it is alive and
// unreachable, which is exactly todo 294's shape. That is why
// isolateTmux()'s exit handler (test/helpers.mjs) now KEEPS its socket
// directory when it finds a survivor instead of removing it, and why the
// ps-based guard stays as a second, coarser net.
//
// IT DOES NOT IMPORT dist/tmux.js, AND THAT IS A DECISION, not an oversight.
// src/tmux.ts classifies the same outcomes (orphanScratchServers), and
// sharing that code would make this check inherit any bug in the very
// classification it exists to catch the consequences of - a leak detector
// that goes blind in exactly the release that needs it. Standalone also means
// it still runs when dist/ is stale or unbuildable, which is a state a failed
// `npm test` can leave behind. The cost is that the probe taxonomy below is
// written twice - the other copy is isolateTmux's exit handler
// (test/helpers.mjs) - and the test above each copy is what keeps them
// honest.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Short, and it does not need the measured 10s src/tmux.ts uses: this runs
// after every test file has exited, against a server that either answers
// immediately or is wedged. What it must not do is hang the run it is
// reporting on.
const PROBE_TIMEOUT_MS = 2000;

// The pause before re-probing an `unknown`, matching isolateTmux's exit
// handler rather than inventing a second number - it is the same decision
// about the same reading, taken twice because the two nets are deliberately
// independent. Long enough for a fork that failed under momentary process or
// fd pressure to succeed on the next attempt; short enough that a run which
// hits it on every socket is still bounded.
const SETTLE_MS = 250;

// THE PROBE TAXONOMY THIS WHOLE CHECK RESTS ON, measured against tmux 3.7b on
// this machine rather than assumed, and written down here because it was
// recorded nowhere in the repo while two classifications depended on it.
// `tmux -S <socket> list-sessions`, four socket states:
//
//   live server                       exit 0, the session list
//   server dead, socket file present  exit 1, "no server running on <path>"
//   socket file absent                exit 1, "error connecting to <path>
//                                     (No such file or directory)"
//   path is not a socket              exit 1, "error connecting to <path>
//                                     (Socket operation on non-socket)"
//
// THE SECOND ROW IS LOAD-BEARING AND NOBODY WOULD GUESS IT: kill-server does
// NOT unlink the socket file, so after a normal reap the file REMAINS and
// answers "no server running". That answer is the only reason the "gone"
// branch works at all. (The fourth row is also prefixed "error connecting
// to", so two patterns cover all three non-live answers.)
//
// live: answered, so a server is genuinely still there.
// wedged: did not answer inside the bound - alive, unreachable, and the shape
//   the 2026-08-11 incident actually had.
// gone: TMUX ANSWERED that nothing is listening there. The only clean outcome.
// unknown: the probe did not run, or failed in a way that is not one of tmux's
//   answers - EAGAIN, EMFILE, a permission error. NOT PROOF OF ANYTHING, and
//   counselors round 2 (F5) is why it is a state rather than a fourth way of
//   saying "gone": under the process/fd exhaustion this detector exists to
//   catch, kill-server fails, the probe then fails to SPAWN, and reading that
//   as gone let the exit handler delete the socket directory and the run-level
//   check report clean - manufacturing the one gap this script's header
//   already admits (a server whose socket file is gone) out of an unknown
//   result.
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
    // No tmux binary at all. Kept as "gone" deliberately rather than swept
    // into unknown: a machine with no tmux started no servers this run, so
    // there is nothing to leak, and src/tmux.ts classifies the same ENOENT
    // the same way ("no tmux binary: nothing tmux manages can be alive
    // either"). isolateTmux() records its socket before it checks for tmux,
    // so without this branch every socket in the manifest would read unknown
    // on such a machine and fail an otherwise clean run.
    if (e?.code === "ENOENT") return { state: "gone", sessions: [] };
    const stderr = (typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString() ?? "").trim();
    if (TMUX_ANSWERED_NO_SERVER.test(stderr)) return { state: "gone", sessions: [] };
    return { state: "unknown", sessions: [], reason: stderr || e?.code || String(e?.message ?? e) };
  }
}

// The manifest is written by isolateTmux() at socket-creation time, one line
// per socket, by every test file in the run. Reading it here rather than
// re-deriving the list by globbing the temp dir is deliberate: a glob would
// also pick up sockets from OTHER runs (a crashed one from yesterday, a
// concurrent one), and a leak detector that goes red for someone else's
// debris gets ignored, then removed.
export function checkTmuxLeaks(manifestPath) {
  let lines;
  try {
    lines = readFileSync(manifestPath, "utf8").split("\n");
  } catch {
    // No manifest at all means no test file ever isolated tmux, which is
    // itself worth saying rather than reporting a clean run.
    return { checked: 0, leaks: [], manifestMissing: true };
  }
  const sockets = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  const leaks = [];
  for (const socket of sockets) {
    let probe = probeScratchSocket(socket);
    // SETTLE AND RE-PROBE ON `unknown` ONLY, mirroring isolateTmux's exit
    // handler (test/helpers.mjs), which got this in the same round and this
    // gate did not (PR gate, round 2 of the fix rounds). An `unknown` is a
    // probe that could not RUN, and the likeliest reason is transient: this
    // loop forks once per socket, ~120 of them in sequence, immediately after
    // a `node --test` run whose own processes are still being reaped, so one
    // EAGAIN or EMFILE in that burst turned a clean run RED. A false red, not
    // a false green - and that direction is exactly why it has to be fixed
    // rather than accepted, because this lane's own argument is that a
    // detector which cries wolf gets deleted.
    //
    // NOT `wedged`, and not `live`. A wedged server did not answer within its
    // bound, which no amount of settling explains away, and a live one
    // answered. Only the inconclusive reading is worth a second look. The
    // settle costs nothing on a clean run, since it is never reached.
    if (probe.state === "unknown") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SETTLE_MS);
      probe = probeScratchSocket(socket);
    }
    if (probe.state !== "gone") leaks.push({ socket, ...probe });
  }
  return { checked: sockets.length, leaks, manifestMissing: false };
}

// `requireManifest` is the caller saying whether IT chose the file list. Only
// then does an absent manifest mean the wiring broke rather than "the files
// you named do not touch tmux" - see the branch in scripts/run-tests.mjs.
// The run's verdict, as one exported expression rather than an inline
// condition in scripts/run-tests.mjs, so both directions of the
// requireManifest rule are testable without running a whole suite to observe
// an exit code (test/tmux-leak-check.test.mjs).
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
  // "left ... unaccounted for" rather than "left ... running": an unknown
  // probe is not proof a server is there, only proof that nothing proved it
  // gone. Saying "running" about it would be the same conflation this file
  // refuses one function up, in the reporting direction.
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
    "  .claude/sessions/dead-ends/2026-08-11-reaping-a-wedged-tmux-server-by-socket-alone.md",
  ];
}
