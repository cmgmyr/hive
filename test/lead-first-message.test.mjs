import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead first message tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { firstMessageDigest } = await import("../dist/firstMessage.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();
after(() => cleanup(sessionName()));

const binDir = join(dirs.tmp, "first-message-bin");
mkdirSync(binDir, { recursive: true });
const argvFile = join(dirs.tmp, "claude-argv.bin");
const argvTemp = join(dirs.tmp, "claude-argv.tmp");
const envFile = join(dirs.tmp, "claude-env.txt");
const envTemp = join(dirs.tmp, "claude-env.tmp");
writeFileSync(
  join(binDir, "claude"),
  `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(argvTemp)}\nenv > ${JSON.stringify(envTemp)}\nmv ${JSON.stringify(argvTemp)} ${JSON.stringify(argvFile)}\nmv ${JSON.stringify(envTemp)} ${JSON.stringify(envFile)}\nsleep 600\n`,
);
chmodSync(join(binDir, "claude"), 0o755);

mkdirSync(join(dirs.dataDir, "profiles", "orchestration"), { recursive: true });
writeFileSync(join(dirs.dataDir, "profiles", "orchestration", "posture.md"), "posture");

const globalYml = join(dirs.dataDir, "hive.yml");
let seq = 0;
const withProfile = (body) => `profile: orchestration\n${body}`;

async function startLead(projectYml, globalBody, existingDir) {
  for (const f of [argvFile, envFile, globalYml]) if (existsSync(f)) unlinkSync(f);
  if (globalBody != null) writeFileSync(globalYml, globalBody);
  const dir = existingDir ?? join(dirs.tmp, `first-message-${seq++}`);
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
  const stdout = result.stdout;
  const env = Object.fromEntries(
    readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { argv, env, stdout, dir };
}

const positional = (argv) => (argv.at(-2) === "--" ? argv.at(-1) : null);

describe("hive lead passes the resolved first message on claude's command line", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("passes a project first_message, which beats the global one", async () => {
    const { argv, env } = await startLead(withProfile("first_message: project says hi\n"), "first_message: global says hi\n");
    assert.equal(positional(argv), "project says hi");
    assert.equal(env.HIVE_LEAD_FIRST_MESSAGE_SHA, firstMessageDigest("project says hi"));
  });

  it("passes the global first_message when the project sets none", async () => {
    const { argv } = await startLead(withProfile("dashboard: false\n"), "first_message: global says hi\n");
    assert.equal(positional(argv), "global says hi");
  });

  it("passes no prompt and sets no marker when nothing sets first_message", async () => {
    const { argv, env } = await startLead(withProfile("dashboard: false\n"));
    assert.equal(positional(argv), null);
    assert.equal(argv.includes("--"), false);
    assert.equal(env.HIVE_LEAD_FIRST_MESSAGE_SHA ?? "", "");
  });

  it("passes no prompt and sets no marker for an empty string, even over a global message", async () => {
    const { argv, env } = await startLead(withProfile("first_message: ''\n"), "first_message: global says hi\n");
    assert.equal(positional(argv), null);
    assert.equal(argv.includes("global says hi"), false);
    assert.equal(env.HIVE_LEAD_FIRST_MESSAGE_SHA ?? "", "");
  });

  it("delivers a hostile message as exactly one argv element", async () => {
    const hostile = "-x it's \"quoted\" $(touch /tmp/pwned) `id` $HOME\nsecond line; rm -rf / #";
    const { argv } = await startLead(withProfile(`first_message: ${JSON.stringify(hostile)}\n`));
    assert.equal(positional(argv), hostile);
    assert.equal(argv.filter((a) => a === hostile).length, 1, "the message must not be delivered twice");
  });

  it("passes no prompt for a blank first_message (YAML null), even over a global message", async () => {
    const { argv } = await startLead(withProfile("first_message:\n"), "first_message: global says hi\n");
    assert.equal(positional(argv), null);
  });

  it("passes no prompt when the project has no profile, where the kickoff would not have fired", async () => {
    const { argv, env } = await startLead("first_message: project says hi\n");
    assert.equal(positional(argv), null);
    assert.equal(env.HIVE_LEAD_FIRST_MESSAGE_SHA ?? "", "");
  });

  it("passes no prompt on a branch outside lead_branches", async () => {
    const dir = join(dirs.tmp, `first-message-${seq++}`);
    mkdirSync(dir, { recursive: true });
    const git = (...a) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...a], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      });
    git("init", "-q", "-b", "feature");
    git("commit", "-q", "--allow-empty", "-m", "x");
    const { argv } = await startLead(withProfile("first_message: project says hi\n"), null, dir);
    assert.equal(positional(argv), null);
  });

  it("adopts the same way and prints no message when only first_message changed", async () => {
    const first = await startLead(withProfile("first_message: one\n"));
    const before = db.prepare("SELECT command FROM agents WHERE kind = 'lead' ORDER BY id DESC LIMIT 1").get().command;
    assert.equal(before.includes("one"), false, "the recorded command must not carry the message");
    const second = await runCli(["lead", first.dir, "--detach"], {
      cwd: first.dir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${binDir}:${process.env.PATH}` },
    });
    writeFileSync(join(first.dir, "hive.yml"), withProfile("first_message: two\n"));
    const third = await runCli(["lead", first.dir, "--detach"], {
      cwd: first.dir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${binDir}:${process.env.PATH}` },
    });
    for (const r of [second, third]) {
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /adopted the existing lead pane, which is still running/);
      assert.equal(r.stdout.includes("two"), false);
    }
    const after = db.prepare("SELECT command FROM agents WHERE kind = 'lead' ORDER BY id DESC LIMIT 1").get().command;
    assert.equal(after, before);
  });
});
