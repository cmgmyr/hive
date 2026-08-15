// "Could a Claude Code session starting in THAT directory actually use hive?"
// - asked per project by `hive doctor`.
//
// WHY THE QUESTION IS PER DIRECTORY AT ALL. Everything hive executes is pinned
// to an absolute interpreter except one thing: the SessionStart hook.
// ~/.claude/skills/hive/hooks/hooks.json is tracked in git and can never carry
// an absolute path (src/hooks.ts), so it registers claude-plugin/kickoff.mjs
// under a bare `node`, and a version manager resolves a bare `node` from the
// directory the session starts in. A project pinning a Node below
// better-sqlite3's Node-API floor therefore starts sessions that cannot load
// hive's addon, and the only thing standing between that and a banner is
// kickoff.mjs's re-exec into the dispatcher's pinned interpreter. That is one
// asdf prune away from returning, and nothing in hive said which project was
// doing it - a sub-floor project made the symptom look intermittent and
// project-specific for as long as it existed.
//
// HOW THE PROBE MEASURES IT, and this is the decision worth reading before
// changing anything here.
//
// It spawns `node` WITH THE PROJECT AS THE WORKING DIRECTORY AND THIS
// PROCESS'S ENVIRONMENT INHERITED VERBATIM. No shell. That is not a shortcut,
// it is the only construction that reproduces what the hook gets:
//
//   - A version manager makes `node` directory-dependent through a SHIM ON
//     PATH (asdf's ~/.asdf/shims/node execs `asdf exec node`, which reads
//     .tool-versions from $PWD upward). The per-directory part is the shim
//     consulting the working directory when it runs. The PATH that finds the
//     shim is INHERITED.
//   - A SessionStart hook sources no shell configuration. It inherits Claude
//     Code's environment, which Claude Code inherited from whatever shell
//     launched it.
//   - So `zsh -lc` is the wrong probe, not the right one, and it was the
//     lane's original plan. It RE-DERIVES an environment by sourcing
//     .zprofile/.zlogin and NOT .zshrc, which is where most asdf setups put
//     their PATH line - it would resolve a different interpreter than the hook
//     does, in either direction, and report confidently about it. `zsh -ic` is
//     wrong for the same reason with the files swapped. spawning with cwd set
//     is not an approximation of the hook's resolution; it is the same
//     mechanism.
//
// WHAT WOULD REFUTE THIS CHECK: a project whose resolved interpreter cannot
// load the addon while doctor reports that it can, or the reverse. The probe
// child runs checkAbi(), which really dlopens the addon - a passing
// `require("better-sqlite3")` proves nothing, since the binding loads lazily
// inside `new Database()`, and reading one as proof is how a broken
// interpreter once got recommended as the fix here. A test drives the failing
// side for real by putting a version-manager-shaped shim first on PATH, so
// each scratch project resolves an interpreter the test chose.
//
// THE RESIDUAL, and it cannot be closed from here: this answers for DOCTOR'S
// OWN environment. Run doctor from a stripped one - cron, or an iTerm profile
// command, which gets a minimal PATH with no version manager on it at all
// (.claude/rules/tmux-and-panes.md) - and the answer is about that
// environment. The environment a future session will inherit belongs to a
// process that does not exist yet.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeRangeForNodeApi, requiredNodeApi } from "./abi.js";
import { cliPath, dispatcherPath, readDispatcher } from "./dispatcher.js";

// A UNION, NOT A RECORD WITH NULLABLE FIELDS, because "hive could not tell"
// is a third outcome and must never be folded into "fine" or "broken". The
// flat shape carried `ok: false` for an unprobed directory, which asserts
// broken about a directory nothing was learned from, and left execPath
// nullable in the branch where the child always reports one.
export type SessionProbe =
  | { probed: false; detail: string }
  | { probed: true; ok: boolean; execPath: string; version: string; detail: string };

// What kickoff.mjs would re-exec into, read the way kickoff.mjs reads it, AND
// MEASURED RATHER THAN ASSUMED.
//
// The first version of this carried `exists: boolean` and the verdict read an
// existing pin as proof that session start survives. IT PROVES A FILE EXISTS.
// One ordinary scenario: doctor runs under Node 24, the
// project resolves Node 20, and a stale dispatcher pins an existing Node
// 22.13. The hook does re-exec, into an interpreter that is ALSO below the
// Node-API 10 floor, and the banner prints anyway while doctor reports the
// project covered.
//
// That is this lane's own thesis broken in this lane's own code: the argument
// for probing rather than reading .tool-versions was MEASURE, DO NOT INFER,
// and existsSync on the pinned path is an inference. So "loads" is now a
// measurement from the same probe the projects get, and the states that were
// never measured say so instead of passing for good news.
export type ReexecTarget =
  | null
  | { path: string; state: "gone" }
  | { path: string; state: "loads" }
  | { path: string; state: "cannot"; detail: string }
  | { path: string; state: "unverified"; detail: string };

// A hung version-manager shim must not hang doctor. Generous, because the
// first `asdf exec` in a directory can be slow, and a timeout that fires on a
// working machine would report a broken project.
//
// It is PER PROBE, and the loop is sequential, so N hung shims serialize to
// N times this. That is the one argument for making the loop concurrent, and
// it needs a hung version manager to matter. The ordinary case does not:
// measured on darwin-arm64 / v24.19.0, a probe child costs 26.8ms, of which
// checkAbi()'s real dlopen is 3.0ms - the other 89% is node startup, which is
// paid per directory no matter what, because the resolution IS the spawn. So
// do not build a scheme that dedupes projects by resolved interpreter: it can
// save at most 3ms each.
const PROBE_TIMEOUT_MS = 10_000;

const probeEntry = (): string => fileURLToPath(new URL("./abiProbe.js", import.meta.url));

// The DEFAULT dispatcher location, not whatever `hive` wins on PATH, because
// this mirrors a decision kickoff.mjs already makes: it reads
// readDispatcher(dispatcherPath()) and re-execs that interpreter. doctor's own
// dispatcher check asks a different question - what typing `hive` runs - and
// correctly prefers the PATH winner. Do not unify them; they would then both
// be wrong about one of the two questions.
// Costs one spawn, so callers resolve it LAZILY - only a project that cannot
// load the addon itself needs to know whether anything would catch it. On a
// healthy machine nothing calls this at all.
export function reexecTarget(): ReexecTarget {
  const path = readDispatcher(dispatcherPath())?.node ?? null;
  if (path === null) return null;
  if (!existsSync(path)) return { path, state: "gone" };
  // BY ABSOLUTE PATH, with no cwd of its own: the pin is absolute, so no
  // version manager gets a say in what runs here, and the answer is the same
  // from any directory. That is exactly why this is one spawn per doctor run
  // and not one per project.
  //
  // ONE RESIDUAL, stated rather than left for a reader to notice: this loads
  // THIS checkout's addon under that interpreter, while the hook would load
  // the plugin checkout's. They are the same tree for the documented install
  // (the plugin is a symlink into the checkout) and two trees when doctor runs
  // from a worktree. The interpreter is the variable that decides this, which
  // is what is being measured; the addon is the same package version either
  // way. If that stops being true, probe the pinned CLI's own tree.
  const probe = probeInterpreter(path);
  if (!probe.probed) return { path, state: "unverified", detail: probe.detail };
  return probe.ok ? { path, state: "loads" } : { path, state: "cannot", detail: probe.detail };
}

// `node` resolved from PATH with the project as the working directory - the
// SessionStart hook's own resolution, see this file's header.
export function probeSessionInterpreter(dir: string): SessionProbe {
  return runProbe("node", dir);
}

// One named interpreter, no directory in the question.
export function probeInterpreter(node: string): SessionProbe {
  return runProbe(node, undefined);
}

function runProbe(command: string, cwd: string | undefined): SessionProbe {
  const unprobed = (detail: string): SessionProbe => ({ probed: false, detail });
  const result = spawnSync(command, [probeEntry()], {
    cwd,
    // Verbatim, including PATH: see this file's header. Anything filtered out
    // here would be answering about an environment no session ever has.
    env: process.env,
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    // SIGTERM is spawnSync's default and a shim that traps or ignores it keeps
    // doctor blocked past the timeout, which makes the bound advisory. SIGKILL
    // cannot be trapped, so the timeout means what it says for the process
    // hive starts. IT IS STILL BEST EFFORT: the kill reaches that process, not
    // its process group, so a shim that has already forked a grandchild
    // holding the pipe can keep this waiting on stdout. Deliberately not
    // solved with process-group killing - that is a much larger posture for a
    // diagnostic, and a hostile version-manager shim is not the threat model.
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // spawnSync could not start it at all - most often no `node` on PATH from
  // that directory, which is itself an answer worth printing.
  if (result.error) return unprobed(`could not run \`${command}\`: ${result.error.message}`);
  // What src/abiProbe.ts prints, kept separate from SessionProbe: the child
  // reports a measurement, and `probed` is this side's word about whether the
  // measurement happened at all. Merging them would let a malformed answer
  // claim to have been probed.
  let parsed: { execPath: string; version: string; ok: boolean; detail: string };
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    // An interpreter old enough not to parse the probe, a shim that printed
    // something of its own, a crash. The first line of stderr is the most
    // useful thing available and is capped: a stack trace must not take over
    // doctor's report.
    const noise = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
    return unprobed(
      `\`${command}\` did not answer the probe (exit ${result.status ?? "killed"})` +
        (noise ? `: ${noise.slice(0, 200)}` : ""),
    );
  }
  return {
    probed: true,
    ok: parsed.ok,
    execPath: parsed.execPath,
    version: parsed.version,
    detail: parsed.detail,
  };
}

export type SessionVerdict = { level: "info" | "warn"; lines: string[] };

// Pure, so every branch can be driven from a test with a probe of the test's
// choosing. The branch this machine happens to produce is not evidence about
// the others - src/dispatcher.ts's durabilityLines() carries the same note for
// the same reason, after a suite that asserted "one of these two appeared"
// passed on a laptop and broke on a runner that was neither.
//
// ALWAYS A WARN, NEVER A FAIL, whatever it finds. A project pinning a Node
// below the addon's floor is often perfectly legitimate - it may never run a
// hive worker - and doctor must not exit 1 over another project's business.
// `hive doctor --strict` is how a caller that wants to gate on this
// opts in.
// `target` is a THUNK because resolving it costs a spawn (reexecTarget probes
// the pinned interpreter now, rather than trusting that a file exists). Only
// the branches below that actually depend on the fallback call it, so a
// machine where every project is fine never pays for it, and this function
// stays pure - the caller decides what a resolution costs.
export function sessionStartVerdict(probe: SessionProbe, target: () => ReexecTarget): SessionVerdict {
  if (!probe.probed) {
    return {
      level: "warn",
      lines: [
        "hive cannot say whether a session starting there would work.",
        probe.detail,
      ],
    };
  }
  const runs = `a session there runs ${probe.execPath} (${probe.version})`;
  if (probe.ok) return { level: "info", lines: [`${runs}, which loads hive's addon`] };
  const cannot = [`${runs}, which CANNOT load hive's addon.`, probe.detail];
  // Scoped deliberately, and appended to every branch below. The re-exec
  // covers the HOOK, and a session is more than its hook: an MCP registration
  // whose command is a bare `node` re-resolves per directory too
  // (src/mcpConfig.ts), with no re-exec anywhere, so its server would die in
  // guardAbi() here. Reported on its own line by reportMcpRegistrations rather
  // than joined in here; this sentence exists so no reader takes a covered
  // hook as cover for the whole session.
  const hookOnly = [
    "Either way that is the hook only. A bare `node` in hive's MCP registration resolves per",
    "directory as well, and nothing re-execs that; doctor reports it separately.",
  ];
  const pinned = target();
  // kickoff.mjs's own re-exec condition, in the same order: something pinned,
  // still on disk, not the interpreter already running. The difference from
  // the hook is that hive can ALSO ask whether that interpreter works, and a
  // reporter that declines to ask is inferring where this whole check exists
  // to measure.
  if (pinned !== null && pinned.state !== "gone" && pinned.path !== probe.execPath) {
    if (pinned.state === "loads") {
      return {
        level: "warn",
        lines: [
          ...cannot,
          "The SessionStart hook survives this by re-execing into the interpreter the dispatcher",
          `pins, ${pinned.path}, and hive loaded the addon under that interpreter to check.`,
          "If a version manager retires it, a session here loses hive's session-start digest and",
          "prints the addon banner instead, naming the Node rather than this project.",
          ...hookOnly,
        ],
      };
    }
    if (pinned.state === "cannot") {
      return {
        level: "warn",
        lines: [
          ...cannot,
          `The SessionStart hook re-execs into ${pinned.path}, which CANNOT load the addon either:`,
          pinned.detail,
          "So the re-exec does not rescue this: a session starting there prints the addon banner",
          "after re-execing, and nothing in that banner names this project or that pin.",
          ...hookOnly,
        ],
      };
    }
    return {
      level: "warn",
      lines: [
        ...cannot,
        `The SessionStart hook would re-exec into ${pinned.path}, but hive could not verify that`,
        `interpreter, so whether that rescues a session here is unknown: ${pinned.detail}`,
        ...hookOnly,
      ],
    };
  }
  const why =
    pinned === null
      ? ["There is no dispatcher at all, so the SessionStart hook has nothing to re-exec into."]
      : pinned.state === "gone"
        ? [`The dispatcher pins ${pinned.path}, which is not on disk, so the SessionStart hook has`, "nothing to re-exec into."]
        : ["The dispatcher pins this same interpreter, so re-execing into it would change nothing."];
  return {
    level: "warn",
    lines: [
      ...cannot,
      ...why,
      "A session starting there gets the addon banner instead of hive's session-start digest.",
      // NAMES AN INTERPRETER, never a bare `hive setup`. This is the third
      // time this repo has had to say it (.claude/rules/native-addon.md), and
      // the first two were in remediation text exactly like this one: `hive`
      // on PATH is the dispatcher, which here is missing, or runs the very
      // interpreter that cannot load the addon, so it can neither create nor
      // repair the pin the advice is asking for. Same wording as abi.ts's own
      // fix lines rather than a fourth phrasing of one instruction.
      "Give the hook something to re-exec into, naming the interpreter (setup pins whatever Node",
      "runs it, so the way out always names one):",
      `  <a Node matching ${nodeRange()}> "${cliPath()}" setup`,
      ...hookOnly,
    ],
  };
}

// Derived from better-sqlite3's own binding.gyp through abi.ts, never written
// here: a constant would keep printing 22.14.0 the day the dependency raises
// NAPI_VERSION. Fallback wording matches abiFixLines'.
function nodeRange(): string {
  const need = requiredNodeApi();
  return (need === null ? null : nodeRangeForNodeApi(need)) ?? "that Node-API level";
}
