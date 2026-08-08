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

// Todo 292. `hive doctor`'s exit code ignored warns, so an update script
// ending in `... && hive doctor && echo updated` reported success with an
// interpreter-mismatch warning on screen - the single condition such a script
// exists to catch.
//
// TWO SHAPES SHIPPED HERE, and the second is the one to understand. `--strict`
// first promoted EVERY warn, which made it a flag that cannot return 0 on the
// machines it exists for: doctor warns about the lead row after every normal
// session exit, and a registered project pinning a sub-floor Node warns on
// every run by design. Both counselors seats found it independently. Now each
// warn site declares whether it GATES, `--strict` promotes only those, and the
// DEFAULT IS NON-GATING so a warn added later cannot break an update chain the
// day it lands.
//
// HOW THESE TESTS CAN FAIL, which is the part that has gone wrong here before.
// Exit codes saturate at 1, and doctor already exits 1 on CI over a missing
// `claude` binary, so comparing two exit codes to prove --strict did something
// passes on exactly the box where the regression matters
// (.claude/sessions/dead-ends/2026-07-28-exit-code-comparison-as-environment-proof.md).
// Every claim below is made against the COUNTS on the summary line, which do
// not saturate. The exit-code assertions that remain are either unambiguous (a
// refused argument, where nothing else ran) or conditional on those counts.
const { cleanup } = isolateTmux("the doctor --strict tests");
after(() => cleanup());

const dirs = scratchDirs();
const configDir = join(dirs.tmp, "claude-config");
mkdirSync(configDir, { recursive: true });
// HIVE_BIN_DIR at a directory with no dispatcher, and a PATH with no `hive` on
// it, so no DISPATCHER warn can appear: every dispatcher warn gates, and one
// arriving from the developer's own ~/.local/bin would silently turn the
// non-gating cases below into mixed ones. `node` still resolves, since the
// probe and the CLI both need it.
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
    // A NON-GATING warn that is present on every machine and every CI leg, and
    // that nothing about the environment can take away: a hive.yml whose
    // layout key is misspelled parses with a warning by design.
    writeFileSync(join(dirs.projectDir, "hive.yml"), "layout: main-verticle\n");
    // No registration at all, so nothing gating can come from there either.
    writeRegistration({ mcpServers: {} });
    plain = await runCli(["doctor"], isolated);
    strict = await runCli(["doctor", "--strict"], isolated);
  });

  it("prints and counts a non-gating warn either way", () => {
    // The guard that keeps everything below from being vacuous: with no
    // warnings at all, every count matches trivially.
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
    // THE CASE THAT MATTERS MOST, and the one the first shape got wrong: the
    // promote-everything version turned this warn into a problem, so an update
    // chain ending in `hive doctor --strict` failed on a healthy machine.
    assert.equal(promotedCount(strict.stdout), 0, strict.stdout);
    assert.equal(
      failureCount(strict.stdout),
      failureCount(plain.stdout),
      `a non-gating warn must not change the problem count\nstrict:\n${strict.stdout}`,
    );
  });

  it("exits 0 under --strict when the only findings are non-gating warns", () => {
    // SAID OUT LOUD, because a green here is not the evidence it looks like:
    // this test passes against the promote-everything code too. There the
    // warn IS promoted, the problem count is 1, and both the implication and
    // the conditional below are satisfied honestly. The discriminating claim
    // is `promotedCount === 0` in the test above; this one pins the property
    // that connects it to an exit code.
    //
    // The implication rather than a constant: on a box where an unrelated
    // check FAILs (CI has no `claude`) doctor correctly exits 1, so the claim
    // that survives everywhere is that the exit code agrees with the count on
    // the summary line, not that it is any particular number.
    assert.equal(strict.code === 0, failureCount(strict.stdout) === 0, strict.stdout);
    assert.equal(plain.code === 0, failureCount(plain.stdout) === 0, plain.stdout);
    // And on a machine with nothing else wrong, the end-to-end statement.
    if (failureCount(strict.stdout) === 0) assert.equal(strict.code, 0, strict.stdout);
  });

  it("promotes a gating warn, and says how many on the summary line", async () => {
    // A registration running a bare `node` is the gating warn with the fewest
    // moving parts, and it is the exact condition todo 292 was filed about:
    // the dispatcher and the MCP server naming different Nodes.
    writeRegistration({ mcpServers: { hive: { type: "stdio", command: "node", args: [SERVER] } } });
    const gatingPlain = await runCli(["doctor"], isolated);
    const gatingStrict = await runCli(["doctor", "--strict"], isolated);
    assert.match(gatingPlain.stdout, /warn {2}mcp registration \(user scope\): runs "node"/);
    // One more warn than the non-gating run, and this time it IS promoted.
    assert.equal(warningCount(gatingStrict.stdout), warningCount(strict.stdout) + 1, gatingStrict.stdout);
    assert.equal(promotedCount(gatingStrict.stdout), 1, gatingStrict.stdout);
    assert.equal(
      failureCount(gatingStrict.stdout) - failureCount(gatingPlain.stdout),
      1,
      `strict:\n${gatingStrict.stdout}\nplain:\n${gatingPlain.stdout}`,
    );
    // Bare doctor is unchanged by any of this: the gating warn is still just a
    // warn without the flag.
    assert.equal(failureCount(gatingPlain.stdout), failureCount(plain.stdout), gatingPlain.stdout);
    writeRegistration({ mcpServers: {} });
  });

  it("leaves a bare doctor's exit code alone whatever the warns are", () => {
    if (failureCount(plain.stdout) === 0) assert.equal(plain.code, 0, plain.stdout);
    assert.doesNotMatch(summaryLine(plain.stdout), /--strict/);
  });

  it("still says All good. only when there is genuinely nothing to report", () => {
    // The other half of todo 292's report: doctor used to print "All good."
    // with warns on the screen above it.
    assert.doesNotMatch(summaryLine(plain.stdout), /All good/);
  });

  it("refuses an unknown argument rather than running a doctor that gates on nothing", async () => {
    // A typo'd flag must not produce a clean-looking run: `hive doctor
    // --stict` in an update script would otherwise report success while
    // gating on nothing at all, which is todo 298's shape one surface over.
    // Unambiguous exit code here - nothing else in doctor ran.
    const { code, stdout, stderr } = await runCli(["doctor", "--stict"], isolated);
    assert.equal(code, 1);
    assert.match(stderr, /unknown argument "--stict"/);
    assert.equal(stdout, "", "a refused run must not print a report a script could read as a result");
  });
});
