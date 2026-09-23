import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the upgrade tests");
after(() => cleanup());
const dirs = scratchDirs();

function npmRootCommand(root) {
  const bin = mkdtempSync(join(dirs.tmp, "npm-"));
  const file = join(bin, "npm");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${root.replaceAll("'", "'\\''")}'\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("upgrade install identity and steps", () => {
  it("accepts ordinary and linked checkouts before querying npm, even beneath node_modules", async () => {
    const { detectInstallShape } = await import("../dist/upgrade.js");
    for (const kind of ["directory", "file"]) {
      const root = join(mkdtempSync(join(dirs.tmp, "checkout-")), "node_modules/@cmgmyr/hive");
      mkdirSync(root, { recursive: true });
      if (kind === "file") writeFileSync(join(root, ".git"), "gitdir: /not-consulted");
      else mkdirSync(join(root, ".git"));
      assert.deepEqual(detectInstallShape(join(root, "dist/cli.js"), "/missing-npm"), { kind: "checkout", packageRoot: root });
    }
  });

  it("requires canonical global ownership and accepts a symlinked prefix", async () => {
    const { detectInstallShape } = await import("../dist/upgrade.js");
    const root = mkdtempSync(join(dirs.tmp, "prefix-"));
    const npmRoot = join(root, "lib/node_modules");
    const packageRoot = join(npmRoot, "@cmgmyr/hive");
    mkdirSync(packageRoot, { recursive: true });
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    const npm = npmRootCommand(join(alias, "lib/node_modules"));
    assert.equal(detectInstallShape(join(packageRoot, "dist/cli.js"), npm).kind, "global");
    for (const suffix of ["_npx/123/node_modules/@cmgmyr/hive", "copy"]) {
      const copied = join(root, suffix);
      mkdirSync(copied, { recursive: true });
      assert.deepEqual(detectInstallShape(join(copied, "dist/cli.js"), npm), {
        kind: "unknown", cli: join(copied, "dist/cli.js"), packageRoot: copied,
        gitState: "absent", npmRoot: join(alias, "lib/node_modules"),
        reason: "npm root -g does not own the running package",
      });
    }
  });

  it("retains npm failure and observed paths for unknown installs", async () => {
    const { detectInstallShape } = await import("../dist/upgrade.js");
    const result = detectInstallShape(join(dirs.tmp, "copy/dist/cli.js"), "/missing-npm");
    assert.equal(result.kind, "unknown");
    assert.equal(result.npmRoot, null);
    assert.match(result.reason, /ENOENT/);
    assert.equal(result.gitState, "absent");
  });

  it("describes exact ordered argv and pins the new CLI with the explicit interpreter", async () => {
    const { checkoutUpgradeSteps, globalUpgradeSteps } = await import("../dist/upgrade.js");
    const root = "/scratch/package with spaces";
    const node = "/scratch/node";
    assert.deepEqual(checkoutUpgradeSteps(root, node), [
      { label: "pull", command: "git", args: ["pull", "--ff-only"], cwd: root },
      { label: "install", command: "npm", args: ["install"], cwd: root },
      { label: "build", command: "npm", args: ["run", "build"], cwd: root },
      { label: "setup", command: node, args: [join(root, "dist/cli.js"), "setup"], cwd: root },
    ]);
    assert.deepEqual(globalUpgradeSteps({ kind: "global", packageRoot: "/old/canonical", npmRoot: root, npmCommand: "npm" }, node), [
      { label: "install", command: "npm", args: ["install", "-g", "@cmgmyr/hive@latest"] },
      { label: "setup", command: node, args: [join(root, "@cmgmyr/hive/dist/cli.js"), "setup"] },
    ]);
  });
});
