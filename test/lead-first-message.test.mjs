import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead first message tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { TRIAGE_MESSAGE } = await import("../dist/kickoff.js");
const { firstMessageDigest } = await import("../dist/triageMessage.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();
after(() => cleanup(sessionName()));

const binDir = join(dirs.tmp, "first-message-bin");
mkdirSync(binDir, { recursive: true });
const argvFile = join(dirs.tmp, "claude-argv.bin");
const envFile = join(dirs.tmp, "claude-env.txt");
writeFileSync(
  join(binDir, "claude"),
  `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(argvFile)}\nenv > ${JSON.stringify(envFile)}\nsleep 600\n`,
);
chmodSync(join(binDir, "claude"), 0o755);

const globalYml = join(dirs.dataDir, "hive.yml");
let seq = 0;

async function startLead(projectYml, globalBody) {
  for (const f of [argvFile, envFile, globalYml]) if (existsSync(f)) unlinkSync(f);
  if (globalBody != null) writeFileSync(globalYml, globalBody);
  const dir = join(dirs.tmp, `first-message-${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hive.yml"), projectYml);
  const result = await runCli(["lead", dir, "--detach"], {
    cwd: dir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(result.code, 0, result.stderr);
  for (let i = 0; i < 100 && !existsSync(envFile); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(envFile), "the fake claude never ran");
  const argv = readFileSync(argvFile, "utf8").split("\0").slice(0, -1);
  const env = Object.fromEntries(
    readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { argv, env };
}

const positional = (argv) => (argv.at(-2) === "--" ? argv.at(-1) : null);

describe("hive lead passes the resolved first message on claude's command line", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("passes a project first_message, which beats the global one", async () => {
    const { argv, env } = await startLead("first_message: project says hi\n", "first_message: global says hi\n");
    assert.equal(positional(argv), "project says hi");
    assert.equal(env.HIVE_LEAD_FIRST_MESSAGE_SHA, firstMessageDigest("project says hi"));
  });

  it("passes the global first_message when the project sets none", async () => {
    const { argv } = await startLead("dashboard: false\n", "first_message: global says hi\n");
    assert.equal(positional(argv), "global says hi");
  });

  it("passes the shipped triage message when nothing sets one", async () => {
    const { argv } = await startLead("dashboard: false\n");
    assert.equal(positional(argv), TRIAGE_MESSAGE);
  });

  it("passes no prompt and sets no marker for an empty string, even over a global message", async () => {
    const { argv, env } = await startLead("first_message: ''\n", "first_message: global says hi\n");
    assert.equal(positional(argv), null);
    assert.equal(argv.includes("global says hi"), false);
    assert.equal(env.HIVE_LEAD_FIRST_MESSAGE_SHA ?? "", "");
  });

  it("delivers a hostile message as exactly one argv element", async () => {
    const hostile = "-x it's \"quoted\" $(touch /tmp/pwned) `id` $HOME\nsecond line; rm -rf / #";
    const { argv } = await startLead(`first_message: ${JSON.stringify(hostile)}\n`);
    assert.equal(positional(argv), hostile);
    assert.equal(argv.filter((a) => a === hostile).length, 1, "the message must not be delivered twice");
  });
});
