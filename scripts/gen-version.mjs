#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(import.meta.url), "..", "..");

function gitState() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: null, dirty: false };
  }
}

function buildId(dist, version) {
  const files = readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dist, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => path !== "build-info.json" && !/^build-info\..+\.tmp$/.test(path))
    .sort();
  const hash = createHash("sha256");
  hash.update(`${version}\0`);
  for (const path of files) {
    hash.update(`${path}\0`);
    hash.update(readFileSync(join(dist, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

const temporary = join(REPO, "dist", `build-info.${randomUUID()}.tmp`);
try {
  const { version } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const { sha, dirty } = gitState();
  const build_id = buildId(join(REPO, "dist"), version);
  writeFileSync(temporary, JSON.stringify({ version, sha, dirty, build_id }));
  renameSync(temporary, join(REPO, "dist", "build-info.json"));
} catch (e) {
  console.error(`gen-version: could not stamp a build version (${e.message}); hive --version will fall back to package.json alone.`);
}

finally {
  rmSync(temporary, { force: true });
}
