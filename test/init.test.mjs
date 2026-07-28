import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli, scratchDirs } from "./helpers.mjs";

// runCli never has a TTY, which is also the non-interactive path hive init
// has to handle without prompting and without failing.
const optsFor = () => {
  const dirs = scratchDirs();
  return { dirs, cli: { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp } };
};

const ymlOf = (dirs) => readFileSync(join(dirs.projectDir, "hive.yml"), "utf8");

describe("hive init profile selection", () => {
  it("writes the profile and skips the runbook pad", async () => {
    const { dirs, cli } = optsFor();
    const { code, stdout } = await runCli(["init", "--profile", "orchestration"], cli);
    assert.equal(code, 0);
    assert.match(ymlOf(dirs), /^profile: orchestration$/m);
    // With a profile the process lives in `hive runbook`; a runbook pad would
    // be a second source of truth nobody updates.
    assert.match(stdout, /runbook: from profile "orchestration"/);
    assert.match(stdout, /board pad: seeded/);

    const pads = await runCli(["pads"], cli);
    assert.doesNotMatch(pads.stdout, /runbook/);
    assert.match(pads.stdout, /board/);
  });

  // The plugin is one symlink per machine, so these cases turn on what is in
  // the home directory, not on the project. HOME points at a scratch dir:
  // the real ~/.claude must not decide whether a test passes, and hive must
  // never touch it.
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
    // The second project on a machine should not be told to install what the
    // first one already installed.
    const { dirs, cli } = optsFor();
    symlinkSync(pluginDir, join(skillsDir(dirs), "hive"));

    const { code, stdout } = await runCli(["init", "--profile", "simple"], withHome(cli, join(dirs.tmp, "home")));
    assert.equal(code, 0);
    assert.match(stdout, /already installed for this machine/);
    assert.doesNotMatch(stdout, /ln -s/);
  });

  it("warns when the link points at a different checkout", async () => {
    // Two clones, one symlink: sessions run the OTHER checkout's kickoff,
    // which is invisible until you notice the wrong code ran.
    const { dirs, cli } = optsFor();
    const otherCheckout = join(dirs.tmp, "other-hive", "claude-plugin");
    mkdirSync(otherCheckout, { recursive: true });
    symlinkSync(otherCheckout, join(skillsDir(dirs), "hive"));

    const { code, stdout } = await runCli(["init", "--profile", "simple"], withHome(cli, join(dirs.tmp, "home")));
    assert.equal(code, 0);
    assert.match(stdout, /resolves to .*other-hive/);
    assert.match(stdout, /rm ~\/\.claude\/skills\/hive && ln -s/);
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

    // The project still parses, with both the old keys and the new one.
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
