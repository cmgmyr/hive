import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { nodeRangeForNodeApi, requiredNodeApi } from "./abi.js";
import { cliPath, dispatcherPath, readDispatcher } from "./dispatcher.js";

export type SessionProbe =
  | { probed: false; detail: string }
  | { probed: true; ok: boolean; execPath: string; version: string; detail: string };

export type ReexecTarget =
  | null
  | { path: string; state: "gone" }
  | { path: string; state: "loads" }
  | { path: string; state: "cannot"; detail: string }
  | { path: string; state: "unverified"; detail: string };

const PROBE_TIMEOUT_MS = 10_000;

const probeEntry = (): string => fileURLToPath(new URL("./abiProbe.js", import.meta.url));

export function reexecTarget(): ReexecTarget {
  const path = readDispatcher(dispatcherPath())?.node ?? null;
  if (path === null) return null;
  if (!existsSync(path)) return { path, state: "gone" };

  const probe = probeInterpreter(path);
  if (!probe.probed) return { path, state: "unverified", detail: probe.detail };
  return probe.ok ? { path, state: "loads" } : { path, state: "cannot", detail: probe.detail };
}

export function probeSessionInterpreter(dir: string): SessionProbe {
  return runProbe("node", dir);
}

export function probeInterpreter(node: string): SessionProbe {
  return runProbe(node, undefined);
}

function runProbe(command: string, cwd: string | undefined): SessionProbe {
  const unprobed = (detail: string): SessionProbe => ({ probed: false, detail });
  const result = spawnSync(command, [probeEntry()], {
    cwd,

    env: process.env,
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,

    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) return unprobed(`could not run \`${command}\`: ${result.error.message}`);

  let parsed: { execPath: string; version: string; ok: boolean; detail: string };
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {

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

  const hookOnly = [
    "Either way that is the hook only. A bare `node` in hive's MCP registration resolves per",
    "directory as well, and nothing re-execs that; doctor reports it separately.",
  ];
  const pinned = target();

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

      "Give the hook something to re-exec into, naming the interpreter (setup pins whatever Node",
      "runs it, so the way out always names one):",
      `  <a Node matching ${nodeRange()}> "${cliPath()}" setup`,
      ...hookOnly,
    ],
  };
}

function nodeRange(): string {
  const need = requiredNodeApi();
  return (need === null ? null : nodeRangeForNodeApi(need)) ?? "that Node-API level";
}
