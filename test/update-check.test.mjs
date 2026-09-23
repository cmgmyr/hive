import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { CLI, DIST, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the update-check tests");
after(() => cleanup());
const dirs = scratchDirs();
const nodePath = dirname(process.execPath);

function fakeNpm(version, tmp, { exit = 0, marker = null } = {}) {
  const bin = join(tmp, `npm-${Math.random().toString(16).slice(2)}`);
  mkdirSync(bin);
  const npm = join(bin, "npm");
  const markerCode = marker ? `printf x >> ${JSON.stringify(marker)}\n` : "";
  writeFileSync(npm, `#!/bin/sh\n${markerCode}printf '%s\\n' ${JSON.stringify(version)}\nexit ${exit}\n`);
  chmodSync(npm, 0o755);
  return bin;
}

function isolated(dataDir, env = {}) {
  return { cwd: dirs.projectDir, dataDir, tmp: dirs.tmp, node: process.execPath, env };
}

describe("CLI npm update checks", () => {
  it("--check with a higher fake npm version prints update available and caches latest", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "higher-") );
    const bin = fakeNpm("9.9.9", dirs.tmp);
    const result = await runCli(["--version", "--check"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.match(result.stdout, /update available: hive 9\.9\.9/);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "update-check.json"))).latest, "9.9.9");
  });

  it("--check with the same fake npm version prints up to date", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "same-") );
    const bin = fakeNpm("1.1.0", dirs.tmp);
    const result = await runCli(["--version", "--check"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.match(result.stdout, /up to date: hive 1\.1\.0 is the latest on npm/);
  });

  it("--check caches npm failure as unknown offline or npm failed", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "failed-") );
    const bin = fakeNpm("ignored", dirs.tmp, { exit: 1 });
    const result = await runCli(["--version", "--check"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.match(result.stdout, /update check: unknown \(offline or npm failed\)/);
    assert.equal(JSON.parse(readFileSync(join(dataDir, "update-check.json"))).error, "offline or npm failed");
  });

  it("--check rejects prerelease output as unparseable version", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "prerelease-") );
    const bin = fakeNpm("1.2.0-beta.1", dirs.tmp);
    const result = await runCli(["--version", "--check"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.match(result.stdout, /update check: unknown \(unparseable version\)/);
  });

  it("--check reports npm not found when PATH has no npm", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "missing-") );
    const result = await runCli(["--version", "--check"], isolated(dataDir, { PATH: "" }));
    assert.match(result.stdout, /update check: unknown \(npm not found\)/);
  });

  it("plain --version reads a fresh newer cache without invoking fake npm", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "cached-") );
    const marker = join(dataDir, "npm-called");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest: "9.9.9", error: null }));
    const bin = fakeNpm("9.9.9", dirs.tmp, { marker });
    const result = await runCli(["--version"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.match(result.stdout, /! update available: hive 9\.9\.9/);
    assert.equal(existsSync(marker), false);
  });

  it("plain --version ignores a cache older than 24 hours", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "stale-") );
    writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checked_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), latest: "9.9.9", error: null }));
    const result = await runCli(["--version"], isolated(dataDir));
    assert.doesNotMatch(result.stdout, /update available/);
  });

  it("piped doctor warns from a newer cache without invoking npm, and stays silent for an up-to-date cache", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "doctor-") );
    const marker = join(dataDir, "npm-called");
    writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest: "9.9.9", error: null }));
    const bin = fakeNpm("9.9.9", dirs.tmp, { marker });
    const result = await runCli(["doctor"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.match(result.stdout, /warn  update: update available: hive 9\.9\.9/);
    assert.equal(existsSync(marker), false);
    writeFileSync(join(dataDir, "update-check.json"), JSON.stringify({ checked_at: new Date().toISOString(), latest: "1.1.0", error: null }));
    const current = await runCli(["doctor"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}` }));
    assert.doesNotMatch(current.stdout, /warn  update:/);
  });

  it("HIVE_NO_UPDATE_CHECK disables explicit checks without invoking npm", async () => {
    const dataDir = mkdtempSync(join(dirs.tmp, "disabled-") );
    const marker = join(dataDir, "npm-called");
    const bin = fakeNpm("9.9.9", dirs.tmp, { marker });
    const result = await runCli(["--version", "--check"], isolated(dataDir, { PATH: `${bin}:${process.env.PATH}`, HIVE_NO_UPDATE_CHECK: "1" }));
    assert.match(result.stdout, /update check disabled \(HIVE_NO_UPDATE_CHECK\)/);
    assert.equal(existsSync(marker), false);
  });

  it("MCP server static imports never reach dist/updateCheck.js", () => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
        const target = join(dirname(file), match[1].replace(/\.js$/, ".js"));
        if (existsSync(target)) visit(target);
      }
    };
    visit(join(DIST, "index.js"));
    assert.equal(seen.has(join(DIST, "updateCheck.js")), false);
  });
});
