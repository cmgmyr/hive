import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

const allowedRoots = ["dist/", "claude-plugin/", "profiles/"];
const exactFiles = new Set(["README.md", "LICENSE", "package.json"]);

function packManifest() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

describe("the npm tarball contains only the runtime tree and required metadata", () => {
  it("rejects unshipped directories and retains every runtime entry point under npm 11's array and npm 12's object output", () => {
    const pkg = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(JSON.stringify(require('./package.json')))"], { cwd: REPO, encoding: "utf8" }));
    const manifest = packManifest();
    const paths = manifest.files.map(({ path }) => path);

    assert.deepEqual(
      paths.filter((path) => !allowedRoots.some((root) => path.startsWith(root)) && !exactFiles.has(path)),
      [],
      `tarball contains paths outside the runtime allowlist: ${paths.join(", ")}`,
    );

    for (const path of [
      "dist/cli.js",
      "dist/index.js",
      "dist/build-info.json",
      "claude-plugin/kickoff.mjs",
      "claude-plugin/skills/cleanup/SKILL.md",
      `profiles/simple/${readdirSync(join(REPO, "profiles/simple"))[0]}`,
    ]) {
      assert.ok(paths.includes(path), `tarball is missing required runtime file ${path}`);
    }

    assert.equal(pkg.name, "@cmgmyr/hive");
    assert.deepEqual(pkg.bin, { hive: "dist/cli.js", "hive-mcp": "dist/index.js" });
    assert.ok(existsSync(join(REPO, "dist/build-info.json")), "setup: build dist/build-info.json before packing");
  });
});
