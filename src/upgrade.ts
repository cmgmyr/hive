import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { cliPath } from "./dispatcher.js";

export type InstallShape =
  | { kind: "checkout"; packageRoot: string }
  | { kind: "global"; packageRoot: string; npmRoot: string; npmCommand: string }
  | { kind: "unknown"; packageRoot: string; cli: string; gitState: string; npmRoot: string | null; reason: string };

export type UpgradeStep = { label: string; command: string; args: string[]; cwd?: string };

export function detectInstallShape(cli = cliPath(), npmCommand = "npm"): InstallShape {
  const packageRoot = dirname(dirname(cli));
  let gitState = "absent";
  try {
    const git = statSync(join(packageRoot, ".git"));
    if (git.isDirectory() || git.isFile()) return { kind: "checkout", packageRoot };
    gitState = "neither file nor directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") gitState = String(error);
  }
  let npmRoot: string | null = null;
  let reason: string;
  try {
    npmRoot = execFileSync(npmCommand, ["root", "-g"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    }).trim();
    if (!isAbsolute(npmRoot)) throw new Error("npm root -g did not return an absolute path");
    if (realpathSync(packageRoot) === realpathSync(join(npmRoot, "@cmgmyr/hive"))) {
      return { kind: "global", packageRoot, npmRoot, npmCommand };
    }
    reason = "npm root -g does not own the running package";
  } catch (error) {
    reason = `could not confirm npm root ownership: ${String(error)}`;
  }
  return { kind: "unknown", packageRoot, cli, gitState, npmRoot, reason };
}

export function checkoutUpgradeSteps(packageRoot: string, node = process.execPath): UpgradeStep[] {
  return [
    { label: "pull", command: "git", args: ["pull", "--ff-only"], cwd: packageRoot },
    { label: "install", command: "npm", args: ["install"], cwd: packageRoot },
    { label: "build", command: "npm", args: ["run", "build"], cwd: packageRoot },
    { label: "setup", command: node, args: [join(packageRoot, "dist/cli.js"), "setup"], cwd: packageRoot },
  ];
}

export function globalUpgradeSteps(shape: Extract<InstallShape, { kind: "global" }>, node = process.execPath): UpgradeStep[] {
  return [
    { label: "install", command: shape.npmCommand, args: ["install", "-g", "@cmgmyr/hive@latest"] },
    { label: "setup", command: node, args: [join(shape.npmRoot, "@cmgmyr/hive/dist/cli.js"), "setup"] },
  ];
}
