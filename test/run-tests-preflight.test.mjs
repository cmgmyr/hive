import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, it } from "node:test";

import { REPO } from "./helpers.mjs";

const scratchRoots = [];
const runnerModules = ["open-guard.mjs", "suite-lock.mjs", "tmux-leaks.mjs", "wedged-shells.mjs", "sweep-scratch.mjs"];
const explicitNodeModuleFiles = ["better-sqlite3/lib/index.js", "yaml/dist/index.js", "zod/index.js"];

after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

function sourceFilesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return entry.isFile() && path.endsWith(".mjs") ? [path] : [];
  });
}

function copyRunnerFixture({ incompletePackage } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hive-run-tests-preflight-"));
  scratchRoots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const file of ["run-tests.mjs", ...runnerModules]) {
    cpSync(join(REPO, "scripts", file), join(root, "scripts", file));
  }
  cpSync(join(REPO, "dist", "etime.js"), join(root, "dist", "etime.js"));
  writeFileSync(join(root, "package.json"), readFileSync(join(REPO, "package.json"), "utf8"));

  const marker = join(root, "test-ran");
  writeFileSync(
    join(root, "test", "preflight-noop.test.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );

  if (incompletePackage) {
    const packageJson = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    for (const name of Object.keys(packageJson.dependencies).filter((dep) => dep !== incompletePackage)) {
      const packageRoot = join(root, "node_modules", ...name.split("/"));
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ main: "index.js" }));
      writeFileSync(join(packageRoot, "index.js"), "");
    }
    for (const path of ["better-sqlite3/lib/index.js", "zod/index.js"]) {
      if (path.startsWith(`${incompletePackage}/`)) continue;
      const file = join(root, "node_modules", ...path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
  }
  return { root, marker };
}

function runPreflight({ incompletePackage } = {}) {
  const fixture = copyRunnerFixture({ incompletePackage });
  const env = { ...process.env, HIVE_TEST_NO_REAP: "1" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const result = spawnSync(
    process.execPath,
    [join(fixture.root, "scripts", "run-tests.mjs"), "test/preflight-noop.test.mjs"],
    { cwd: fixture.root, encoding: "utf8", env, timeout: 10_000 },
  );
  return { ...fixture, result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

it("scripts/run-tests fails before executing a test when this checkout has no node_modules and names npm install", () => {
  const { marker, result, output } = runPreflight();
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, output);
  assert.match(output, /node_modules/);
  assert.match(output, /npm install/);
  assert.equal(existsSync(marker), false, "the named test must not start before preflight rejects the checkout");
});

it("scripts/run-tests names a missing local package before executing tests", () => {
  const { marker, result, output } = runPreflight({ incompletePackage: "yaml" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, output);
  assert.match(output, /yaml/);
  assert.match(output, /npm install/);
  assert.equal(existsSync(marker), false, "the named test must not start when a required package is absent");
});

it("scripts/run-tests preflights every explicit package file referenced by test and scripts", () => {
  const files = [...sourceFilesUnder(join(REPO, "test")), ...sourceFilesUnder(join(REPO, "scripts"))];
  const references = new Set();
  for (const file of files) {
    if (file.endsWith("run-tests-preflight.test.mjs")) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/join\(REPO,\s*["']node_modules["']\s*,([^)]*)\)/g)) {
      const parts = [...match[1].matchAll(/["']([^"']+)["']/g)].map((part) => part[1]);
      if (parts.length > 1) references.add(`${parts[0]}/${parts.slice(1).join("/")}`);
    }
  }
  const runner = readFileSync(join(REPO, "scripts", "run-tests.mjs"), "utf8");
  const block = runner.match(/const EXPLICIT_NODE_MODULE_FILES = \[([\s\S]*?)\];/)?.[1];
  assert.ok(block, "run-tests.mjs must declare the exact local files that explicit test imports need");
  const guarded = [...block.matchAll(/["']([^"']+)["']/g)].map((part) => part[1]);
  assert.deepEqual([...references].sort(), ["better-sqlite3/lib/index.js", "zod/index.js"]);
  for (const path of references) assert.ok(guarded.includes(path), `${path} must be checked by the preflight`);
  assert.ok(guarded.includes("yaml/dist/index.js"), "the global-install fixture exposes yaml through its node_modules link");
});
