#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

try {
  const { version } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const { sha, dirty } = gitState();
  writeFileSync(join(REPO, "dist", "build-info.json"), JSON.stringify({ version, sha, dirty }));
} catch (e) {
  console.error(`gen-version: could not stamp a build version (${e.message}); hive --version will fall back to package.json alone.`);
}
