import { execFileSync } from "node:child_process";

export function gitOut(cwd: string, args: string[]): string | null {
  const { GIT_DIR: _gitDir, GIT_COMMON_DIR: _gitCommonDir, GIT_WORK_TREE: _gitWorkTree, ...env } = process.env;
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      env,
    }).trim();
  } catch {
    return null;
  }
}
