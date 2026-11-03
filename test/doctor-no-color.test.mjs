import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fakeFailingTmux, isolateTmux, runCli, scratchDirs, tmux } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the doctor NO_COLOR tests");
const skipWithoutTmux = hasTmux ? false : "tmux is not installed";
if (hasTmux) tmux("new-session", "-d", "-s", "doctor-no-color", "sleep", "3600");
after(() => {
  if (hasTmux) tmux("kill-session", "-t", "=doctor-no-color");
  cleanup();
});

const doctorOpts = () => {
  const dirs = scratchDirs();
  const home = join(dirs.tmp, "home");
  mkdirSync(home, { recursive: true });
  return { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp, env: { HOME: home } };
};

describe("hive doctor warns when NO_COLOR reaches Claude workers", () => {
  it("warns when the tmux server global environment carries NO_COLOR", { skip: skipWithoutTmux }, async () => {
    tmux("set-environment", "-g", "NO_COLOR", "1");
    const out = await runCli(["doctor"], doctorOpts());

    const warning = out.stdout.split("\n").filter((line) => line.includes("warn  tmux NO_COLOR"));
    assert.equal(warning.length, 1, out.stdout);
    assert.match(out.stdout, /Claude Code.*placeholder.*suggestion.*typed input/i);
    assert.match(out.stdout, /agent_send refuses.*wakes hold/i);
    assert.match(out.stdout, /tmux set-environment -g -u NO_COLOR/);
    assert.match(out.stdout, /restart affected workers/i);
  });

  it("stays quiet when the tmux server does not carry NO_COLOR", { skip: skipWithoutTmux }, async () => {
    const opts = doctorOpts();

    tmux("set-environment", "-g", "-u", "NO_COLOR");
    const absent = await runCli(["doctor"], opts);
    assert.doesNotMatch(absent.stdout, /warn  tmux NO_COLOR/);

    tmux("set-environment", "-g", "-r", "NO_COLOR");
    const removed = await runCli(["doctor"], opts);
    assert.doesNotMatch(removed.stdout, /warn  tmux NO_COLOR/);
  });

  it("warns that a server started from a NO_COLOR shell would pass it to workers", { skip: skipWithoutTmux }, async () => {
    const opts = doctorOpts();
    const noServer = mkdtempSync(join("/tmp", "hive-no-color-"));
    mkdirSync(join(noServer, `tmux-${process.getuid()}`), { recursive: true, mode: 0o700 });
    const out = await runCli(["doctor"], {
      ...opts,
      env: { ...opts.env, TMUX: "", TMUX_TMPDIR: noServer, NO_COLOR: "1" },
    });

    assert.match(out.stdout, /warn  tmux NO_COLOR: NO_COLOR is set in this shell/i);
    assert.match(out.stdout, /server started here would pass it to every worker/i);
    assert.match(out.stdout, /tmux set-environment -g -u NO_COLOR/);
  });

  it("does not warn or throw when the NO_COLOR tmux probe fails", { skip: skipWithoutTmux }, async () => {
    const opts = doctorOpts();
    const failingTmux = fakeFailingTmux({ failOn: "show-environment" });
    const out = await runCli(["doctor"], {
      ...opts,
      env: { ...opts.env, PATH: `${failingTmux}:${process.env.PATH}` },
    });

    assert.equal(out.stderr, "", out.stderr);
    assert.doesNotMatch(out.stdout, /warn  tmux NO_COLOR/);
    assert.match(out.stdout, /hive doctor/);
  });
});
