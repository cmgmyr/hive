import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// hive doctor runs the janitor, which probes tmux; isolate before any test
// in this file runs, even the ones that only call setup. Nothing here creates
// a session, so there is nothing to name and kill; only the socket dir needs
// removing on exit.
const { cleanup: cleanupTmux } = isolateTmux("setup --attach tests");
after(() => cleanupTmux());

describe("hive setup --attach", () => {
  it("leaves the stored value alone and echoes the default when the flag is absent", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const result = await runCli(["setup", "--dir", join(dirs.tmp, "bin")], opts);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /attach mode {2}auto/);
    assert.throws(() => readFileSync(join(dirs.dataDir, "config.json"), "utf8"));
  });

  it("writes and echoes the requested mode", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const result = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--attach", "raw"], opts);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /attach mode {2}raw/);
    const block = [
      "set -g allow-passthrough all",
    ];
    for (const line of block) {
      assert.equal(result.stdout.split(line).length - 1, 1, `${line} should be printed once`);
    }
    const config = JSON.parse(readFileSync(join(dirs.dataDir, "config.json"), "utf8"));
    assert.equal(config.attach, "raw");
  });

  it("rejects an unknown value before writing anything", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const result = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--attach", "bogus"], opts);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /--attach must be one of: auto, raw, control/);
    assert.throws(() => readFileSync(join(dirs.dataDir, "config.json"), "utf8"));
  });

  it("a later bare setup preserves an earlier --attach", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const bin = join(dirs.tmp, "bin");
    await runCli(["setup", "--dir", bin, "--attach", "control"], opts);
    const bare = await runCli(["setup", "--dir", bin], opts);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /attach mode {2}control/);
    const config = JSON.parse(readFileSync(join(dirs.dataDir, "config.json"), "utf8"));
    assert.equal(config.attach, "control");
  });
});

describe("hive setup --auto-attach", () => {
  it("writes the requested value and a later bare setup preserves it", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const bin = join(dirs.tmp, "bin");
    const setup = await runCli(["setup", "--dir", bin, "--auto-attach", "off"], opts);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /auto-attach {2}off/);
    const bare = await runCli(["setup", "--dir", bin], opts);
    assert.match(bare.stdout, /auto-attach {2}off/);
    assert.equal(JSON.parse(readFileSync(join(dirs.dataDir, "config.json"), "utf8")).autoAttach, "off");
  });

  it("rejects a missing or unknown value before writing", async () => {
    for (const value of [undefined, "bogus"]) {
      const dirs = scratchDirs();
      const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
      const args = ["setup", "--dir", join(dirs.tmp, "bin"), "--auto-attach"];
      if (value) args.push(value);
      const result = await runCli(args, opts);
      assert.notEqual(result.code, 0);
      assert.match(result.stdout, /--auto-attach must be one of: auto, on, off/);
      assert.throws(() => readFileSync(join(dirs.dataDir, "config.json"), "utf8"));
    }
  });
});

describe("hive doctor's attach mode line", () => {
  it("reports auto-attach's config and env sources", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    await runCli(["init"], opts);
    await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--auto-attach", "on"], opts);
    // helpers default this legacy override to 0 to prevent native windows;
    // an unknown value is deliberately absent and lets config discriminate.
    const configured = await runCli(["doctor"], { ...opts, env: { HIVE_AUTO_ATTACH: "not-a-mode" } });
    assert.match(configured.stdout, /auto-attach: on \(set with `hive setup --auto-attach`\)/);
    const overridden = await runCli(["doctor"], { ...opts, env: { HIVE_AUTO_ATTACH: "0" } });
    assert.match(overridden.stdout, /auto-attach: off \(HIVE_AUTO_ATTACH override; testing only\)/);
  });

  it("reports the default and says it came from detection", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const doctor = await runCli(["doctor"], opts);
    assert.match(doctor.stdout, /attach mode: auto \(default; set with `hive setup --attach`\)/);
    // IMMUNE to generated data: doctor.stdout also carries this run's scratch
    // dataDir/projectDir path, but mkdtemp's random suffix is alnum-only, so
    // it can never spell a hyphenated, multi-word literal like
    // "allow-passthrough" or "pane-border-status" by accident. Those two
    // strings are only ever printed by doctor's raw-attach-options report
    // (src/cli.ts, inside `if (mode === "raw")`), which this case never
    // reaches because no tmux server is up. Same reasoning applies to the two
    // doesNotMatch calls below in this describe block.
    assert.doesNotMatch(doctor.stdout, /allow-passthrough|pane-border-status/);
  });

  it("reports a stored value and says it came from config", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const setup = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--attach", "control"], opts);
    assert.equal(setup.code, 0, setup.stderr);
    const doctor = await runCli(["doctor"], opts);
    assert.match(doctor.stdout, /attach mode: control \(set with `hive setup --attach`\)/);
    // IMMUNE, same reasoning as above.
    assert.doesNotMatch(doctor.stdout, /allow-passthrough|pane-border-status/);
  });

  it("reports hive-owned window options instead of global options", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const setup = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--attach", "raw"], opts);
    assert.equal(setup.code, 0, setup.stderr);
    execFileSync("tmux", ["new-session", "-d", "-s", "hive-doctor-raw-options", "sleep 600"], { stdio: "ignore" });
    execFileSync("tmux", ["set-option", "-g", "allow-passthrough", "off"]);
    execFileSync("tmux", ["set-option", "-g", "pane-border-status", "off"]);
    assert.equal(execFileSync("tmux", ["show-options", "-g", "-v", "allow-passthrough"], { encoding: "utf8" }).trim(), "off");
    assert.equal(execFileSync("tmux", ["show-options", "-g", "-v", "pane-border-status"], { encoding: "utf8" }).trim(), "off");
    execFileSync("tmux", ["set-window-option", "-t", "=hive-doctor-raw-options:0", "@hive-owned", "1"]);
    execFileSync("tmux", ["set-window-option", "-t", "=hive-doctor-raw-options:0", "allow-passthrough", "all"]);
    execFileSync("tmux", ["set-window-option", "-t", "=hive-doctor-raw-options:0", "pane-border-status", "top"]);
    execFileSync("tmux", ["set-window-option", "-t", "=hive-doctor-raw-options:0", "pane-border-format", " #{pane_index} #{pane_title} "]);
    execFileSync("tmux", ["set-window-option", "-t", "=hive-doctor-raw-options:0", "monitor-bell", "on"]);

    const doctor = await runCli(["doctor"], opts);
    execFileSync("tmux", ["kill-session", "-t", "=hive-doctor-raw-options"]);
    assert.match(doctor.stdout, /tmux window hive-doctor-raw-options:@\d+: allow-passthrough all; pane-border-status top/);
  });

  it("keeps raw attach tmux options unknown when no server is reachable", async () => {
    const dirs = scratchDirs();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init"], opts);
    assert.equal(init.code, 0, init.stderr);
    const setup = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--attach", "raw"], opts);
    assert.equal(setup.code, 0, setup.stderr);

    const doctor = await runCli(["doctor"], opts);
    assert.match(doctor.stdout, /attach mode: raw/);
    // IMMUNE, same reasoning as the first case in this describe block above.
    assert.doesNotMatch(doctor.stdout, /allow-passthrough|pane-border-status/);
  });
});
