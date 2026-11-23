import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { harnessFor, resolvedCommandPrefix } from "./harnesses.js";

export function harnessExecutable(command: string): string | null {
  if (harnessFor(command).name === "unknown" || /[;|&`\n]/.test(command)) return null;
  const prefix = resolvedCommandPrefix(command);
  if (/(?:^|\s)PATH=/.test(prefix) || /["'`$\\;|&<>()[\]{}~*?]/.test(prefix)) return null;
  return prefix.split(/\s+/).at(-1) ?? null;
}

export function executableOnPath(executable: string, cwd: string, path = process.env.PATH ?? ""): string | null {
  const candidates = executable.includes("/")
    ? [resolve(cwd, executable)]
    : path.split(delimiter).map((entry) => resolve(cwd, entry, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

export function leadExecutableProblem(command: string, cwd: string): string | null {
  const executable = harnessExecutable(command);
  if (executable === null || executableOnPath(executable, cwd)) return null;
  return `lead executable "${executable}" was not found or is not executable. ` +
    `Install it or update lead: in hive.yml (for Codex: lead: codex and agents: [codex]). ` +
    `Run hive setup --harness ${harnessFor(command).name} for registration instructions.`;
}
