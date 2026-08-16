import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  failureCount,
  isolateTmux,
  promotedCount,
  runCli,
  scratchDirs,
  SERVER,
  summaryLine,
  warningCount,
} from "./helpers.mjs";

const { cleanup } = isolateTmux("the doctor --strict tests");
after(() => cleanup());

const dirs = scratchDirs();
const configDir = join(dirs.tmp, "claude-config");
mkdirSync(configDir, { recursive: true });

const isolated = {
  cwd: dirs.projectDir,
  dataDir: dirs.dataDir,
  tmp: dirs.tmp,
  env: {
    CLAUDE_CONFIG_DIR: configDir,
    HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-here"),
    PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`,
  },
};
const writeRegistration = (config) =>
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify(config, null, 1));

describe("hive doctor --strict promotes only the warns that mean this install is wrong", () => {
  let plain;
  let strict;

  before(async () => {
    const init = await runCli(["init"], isolated);
    assert.equal(init.code, 0, init.stderr);

    writeFileSync(join(dirs.projectDir, "hive.yml"), "layout: main-verticle\n");

    writeRegistration({ mcpServers: {} });
    plain = await runCli(["doctor"], isolated);
    strict = await runCli(["doctor", "--strict"], isolated);
  });

  it("prints and counts a non-gating warn either way", () => {

    assert.ok(
      warningCount(plain.stdout) >= 1,
      `this file needs a warning to reason about; got:\n${plain.stdout}`,
    );
    assert.match(plain.stdout, /warn {2}hive\.yml: layout must be one of/);
    assert.equal(
      warningCount(strict.stdout),
      warningCount(plain.stdout),
      "--strict changes what warns COUNT for, not what warns or what prints",
    );
  });

  it("does NOT promote it, so a run of only non-gating warns is not a problem", () => {

    assert.equal(promotedCount(strict.stdout), 0, strict.stdout);
    assert.equal(
      failureCount(strict.stdout),
      failureCount(plain.stdout),
      `a non-gating warn must not change the problem count\nstrict:\n${strict.stdout}`,
    );
  });

  it("exits 0 under --strict when the only findings are non-gating warns", () => {

    assert.equal(strict.code === 0, failureCount(strict.stdout) === 0, strict.stdout);
    assert.equal(plain.code === 0, failureCount(plain.stdout) === 0, plain.stdout);

    if (failureCount(strict.stdout) === 0) assert.equal(strict.code, 0, strict.stdout);
  });

  it("promotes a gating warn, and says how many on the summary line", async () => {

    writeRegistration({ mcpServers: { hive: { type: "stdio", command: "node", args: [SERVER] } } });
    const gatingPlain = await runCli(["doctor"], isolated);
    const gatingStrict = await runCli(["doctor", "--strict"], isolated);
    assert.match(gatingPlain.stdout, /warn {2}mcp registration \(user scope\): runs "node"/);

    assert.equal(warningCount(gatingStrict.stdout), warningCount(strict.stdout) + 1, gatingStrict.stdout);
    assert.equal(promotedCount(gatingStrict.stdout), 1, gatingStrict.stdout);
    assert.equal(
      failureCount(gatingStrict.stdout) - failureCount(gatingPlain.stdout),
      1,
      `strict:\n${gatingStrict.stdout}\nplain:\n${gatingPlain.stdout}`,
    );

    assert.equal(failureCount(gatingPlain.stdout), failureCount(plain.stdout), gatingPlain.stdout);
    writeRegistration({ mcpServers: {} });
  });

  it("leaves a bare doctor's exit code alone whatever the warns are", () => {
    if (failureCount(plain.stdout) === 0) assert.equal(plain.code, 0, plain.stdout);
    assert.doesNotMatch(summaryLine(plain.stdout), /--strict/);
  });

  it("still says All good. only when there is genuinely nothing to report", () => {

    assert.doesNotMatch(summaryLine(plain.stdout), /All good/);
  });

  it("refuses an unknown argument rather than running a doctor that gates on nothing", async () => {

    const { code, stdout, stderr } = await runCli(["doctor", "--stict"], isolated);
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--stict"/);
    assert.equal(stdout, "", "a refused run must not print a report a script could read as a result");
  });
});
