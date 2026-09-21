import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { CLI, isolateTmux, panesIn, resolvedTmuxSocket, runCli, scratchDirs, tmux } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the init tests");
after(() => cleanupTmux());

const optsFor = () => {
  const dirs = scratchDirs();
  return { dirs, cli: { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp } };
};

const ymlOf = (dirs) => readFileSync(join(dirs.projectDir, "hive.yml"), "utf8");

async function initWithGitignoreAnswer(answer) {
  const { dirs } = optsFor();
  writeFileSync(join(dirs.projectDir, ".gitignore"), "node_modules/");
  const session = `init-prompt-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(resolvedTmuxSocket()), { recursive: true });
  const command = `env -u HIVE_AGENT_ID -u HIVE_PROJECT_LOCK -u HIVE_PROJECT_PATH HIVE_DATA_DIR=${JSON.stringify(dirs.dataDir)} ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} init --no-profile ${JSON.stringify(dirs.projectDir)}`;
  tmux("new-session", "-d", "-s", session, "sleep", "600");
  const pane = panesIn(`=${session}`)[0];
  tmux("respawn-pane", "-k", "-t", pane, "sh", "-c", `${command}; sleep 600`);
  for (let i = 0; i < 50 && !tmux("capture-pane", "-p", "-t", pane).includes("Append `.hive/` to .gitignore?"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  tmux("send-keys", "-t", pane, answer, "Enter");
  for (let i = 0; i < 50 && !tmux("capture-pane", "-p", "-t", pane).includes("- .gitignore:"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const gitignore = readFileSync(join(dirs.projectDir, ".gitignore"), "utf8");
  tmux("kill-session", "-t", `=${session}`);
  return { dirs, gitignore };
}

describe("hive init profile selection", () => {
  it("writes the profile and skips the runbook pad", async () => {
    const { dirs, cli } = optsFor();
    const { code, stdout } = await runCli(["init", "--profile", "orchestration"], cli);
    assert.equal(code, 0);
    assert.match(ymlOf(dirs), /^profile: orchestration$/m);

    assert.match(stdout, /runbook: from profile "orchestration"/);
    assert.match(stdout, /board pad: seeded/);

    const pads = await runCli(["pads"], cli);
    assert.doesNotMatch(pads.stdout, /runbook/);
    assert.match(pads.stdout, /board/);
  });

  const withHome = (cli, home) => ({ ...cli, env: { ...(cli.env ?? {}), HOME: home } });
  const pluginDir = new URL("../claude-plugin", import.meta.url).pathname.replace(/\/$/, "");

  function skillsDir(dirs) {
    const dir = join(dirs.tmp, "home", ".claude", "skills");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("prints the plugin install command when it is not installed", async () => {
    const { dirs, cli } = optsFor();
    skillsDir(dirs);
    const { stdout } = await runCli(["init", "--profile", "simple"], withHome(cli, join(dirs.tmp, "home")));
    assert.match(stdout, /ln -s .*\/claude-plugin ~\/\.claude\/skills\/hive/);
    assert.match(stdout, /once per machine \(not per project\)/);
    const link = /ln -s (\S+) /.exec(stdout)[1];
    assert.equal(existsSync(join(link, ".claude-plugin", "plugin.json")), true);
  });

  it("says nothing to do when this checkout is already linked", async () => {

    const { dirs, cli } = optsFor();
    symlinkSync(pluginDir, join(skillsDir(dirs), "hive"));

    const { code, stdout } = await runCli(["init", "--profile", "simple"], withHome(cli, join(dirs.tmp, "home")));
    assert.equal(code, 0);
    assert.match(stdout, /already installed for this machine/);
    assert.doesNotMatch(stdout, /ln -s/);
  });

  it("warns when the link points at a different checkout", async () => {

    const { dirs, cli } = optsFor();
    const otherCheckout = join(dirs.tmp, "other-hive", "claude-plugin");
    mkdirSync(otherCheckout, { recursive: true });
    symlinkSync(otherCheckout, join(skillsDir(dirs), "hive"));

    const { code, stdout } = await runCli(["init", "--profile", "simple"], withHome(cli, join(dirs.tmp, "home")));
    assert.equal(code, 0);
    assert.match(stdout, /resolves to .*other-hive/);
    assert.match(stdout, /rm ~\/\.claude\/skills\/hive && ln -s/);
  });

  it("follows CLAUDE_CONFIG_DIR when claude's state lives outside ~/.claude", async () => {

    const { dirs, cli } = optsFor();
    const configDir = join(dirs.tmp, "elsewhere-config");
    mkdirSync(join(configDir, "skills"), { recursive: true });
    symlinkSync(pluginDir, join(configDir, "skills", "hive"));

    skillsDir(dirs);

    const env = { ...withHome(cli, join(dirs.tmp, "home")).env, CLAUDE_CONFIG_DIR: configDir };
    const { code, stdout } = await runCli(["init", "--profile", "simple"], { ...cli, env });
    assert.equal(code, 0);
    assert.match(stdout, /already installed for this machine/);
    assert.doesNotMatch(stdout, /ln -s/);
  });

  it("prints the real path, not ~, when the config dir is relocated", async () => {

    const { dirs, cli } = optsFor();
    const configDir = join(dirs.tmp, "elsewhere-config-2");
    mkdirSync(join(configDir, "skills"), { recursive: true });
    skillsDir(dirs);

    const env = { ...withHome(cli, join(dirs.tmp, "home")).env, CLAUDE_CONFIG_DIR: configDir };
    const { stdout } = await runCli(["init", "--profile", "simple"], { ...cli, env });
    assert.match(stdout, new RegExp(`ln -s \\S+/claude-plugin ${configDir}/skills/hive`));
    assert.doesNotMatch(stdout, /~\/\.claude\/skills\/hive/);
  });

  it("records a decision against profiles and seeds the runbook pad", async () => {
    const { dirs, cli } = optsFor();
    const { code, stdout } = await runCli(["init", "--no-profile"], cli);
    assert.equal(code, 0);
    assert.match(ymlOf(dirs), /^profile: none$/m);
    assert.match(stdout, /runbook pad: seeded/);
    assert.doesNotMatch(stdout, /ln -s/, "a project without a profile gets no kickoff");
  });

  it("asks nothing without a TTY, and says how to decide later", async () => {
    const { dirs, cli } = optsFor();
    const { code, stdout } = await runCli(["init"], cli);
    assert.equal(code, 0, "no TTY must not be a failure");
    assert.doesNotMatch(ymlOf(dirs), /^profile:/m, "an absent key means never asked");
    assert.match(stdout, /hive init --profile <name>/);
    assert.match(stdout, /runbook pad: seeded/);
  });

  it("prints the generated .hive/ note without a TTY and never changes an existing gitignore", async () => {
    const { dirs, cli } = optsFor();
    const original = "node_modules/\n";
    writeFileSync(join(dirs.projectDir, ".gitignore"), original);
    const { code, stdout } = await runCli(["init", "--no-profile"], cli);
    assert.equal(code, 0);
    assert.match(stdout, /\.hive\/: hive writes generated output here/);
    assert.doesNotMatch(stdout, /Append `\.hive\//, "non-TTY init must not ask for input");
    assert.equal(readFileSync(join(dirs.projectDir, ".gitignore"), "utf8"), original);
  });

  it("appends exactly one .hive/ line after an explicit TTY y, preserving a missing trailing newline", async () => {
    const { gitignore } = await initWithGitignoreAnswer("y");
    assert.equal(gitignore, "node_modules/\n.hive/\n");
  });

  it("leaves the gitignore byte-identical after an explicit TTY n", async () => {
    const { gitignore } = await initWithGitignoreAnswer("n");
    assert.equal(gitignore, "node_modules/");
  });

  it("writes a commented check: example into the vars block (todo 792)", async () => {
    const { dirs, cli } = optsFor();
    const { code } = await runCli(["init"], cli);
    assert.equal(code, 0);
    assert.match(ymlOf(dirs), /^#\s+check: .+$/m, "the template shows a project how to set check");
  });

  it("shows a second stack's check: example, not just one (todo 792)", async () => {
    const { dirs, cli } = optsFor();
    const { code } = await runCli(["init"], cli);
    assert.equal(code, 0);
    const checkLines = ymlOf(dirs).match(/^#\s+check: .+$/gm) ?? [];
    assert.equal(checkLines.length, 2, "one example per stack, so a PHP project isn't left inferring the syntax from a JS one");
    assert.match(checkLines.join("\n"), /vendor\/bin\/(pint|phpstan)/, "the second example is a PHP stack, not a second JS/TS one");
  });

  it("adds the key to an existing hive.yml without touching the rest", async () => {
    const { dirs, cli } = optsFor();
    const original = "placement: window\n\nprocesses:\n  dev: npm run dev   # keep me\n";
    writeFileSync(join(dirs.projectDir, "hive.yml"), original);

    const { code, stdout } = await runCli(["init", "--profile", "orchestration"], cli);
    assert.equal(code, 0);
    assert.match(stdout, /added profile: orchestration/);
    const updated = ymlOf(dirs);
    assert.ok(updated.startsWith(original), "the human's file must survive verbatim");
    assert.match(updated, /^profile: orchestration$/m);

    const status = await runCli(["profile", "list"], cli);
    assert.match(status.stdout, /\* orchestration/);
  });

  it("never rewrites a profile that is already set", async () => {
    const { dirs, cli } = optsFor();
    await runCli(["init", "--profile", "simple"], cli);
    const { stdout } = await runCli(["init", "--profile", "orchestration"], cli);
    assert.match(stdout, /already set to "profile: simple"/);
    assert.equal(ymlOf(dirs).match(/^profile:/gm).length, 1, "exactly one profile key");
    assert.match(ymlOf(dirs), /^profile: simple$/m);
  });

  it("rejects a profile that does not exist", async () => {
    const { dirs, cli } = optsFor();
    const { code, stdout } = await runCli(["init", "--profile", "ghost"], cli);
    assert.equal(code, 1);
    assert.match(stdout, /No profile named "ghost"/);
    assert.match(stdout, /orchestration/);
    assert.equal(existsSync(join(dirs.projectDir, "hive.yml")), false, "a rejected run writes nothing");
  });

  it("rejects --profile with no value", async () => {
    const { cli } = optsFor();
    const { code, stdout } = await runCli(["init", "--profile"], cli);
    assert.equal(code, 1);
    assert.match(stdout, /Usage: hive init/);
  });
});
