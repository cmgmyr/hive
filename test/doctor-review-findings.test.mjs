import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, after } from "node:test";

import {
  McpClient,
  failureCount,
  isolateTmux,
  makeFakeClaude,
  runCli,
  scratchDirs,
  warningCount,
} from "./helpers.mjs";

// Todo 349 (pad 104, phase B2-ENCODE): "a wave must not close with untriaged
// review findings outstanding", made mechanically checkable. Pad 130's D1-D4.
//
// THE HEADLINE ASSERTION, stated so it can be checked rather than assumed:
// a store with tagged findings and no triage must produce the untriaged
// report, and a store with NO tagged findings at all must say so distinctly
// rather than reading as clean - the exact false-green
// .claude/sessions/dead-ends/2026-08-03-negative-control-that-disabled-its-own-check.md
// describes. Red-proved by hand against a build with the check's body
// commented out: every test below failed, including the zero-tagged one
// (the info line disappeared entirely rather than reading "0 tracked").
const { cleanup: cleanupTmux } = isolateTmux("the doctor review-findings tests");
after(() => cleanupTmux());

async function seed(dirs, fn) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

// Resolved once, from THIS process's own real PATH, not hardcoded - tmux
// lives at /opt/homebrew/bin on a Mac dev machine and /usr/bin on CI's
// Ubuntu runner (apt-get install tmux, .github/workflows/ci.yml). A fixed
// guess picks one and silently FAILs "tmux" on the other, which would have
// blocked "All good." below for a reason that has nothing to do with this
// check - measured while writing this test: /usr/bin:/bin alone left tmux
// unresolved on this Mac.
const TMUX_DIR = dirname(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());

// Lead's fix-round correction: a bare `runCli` picks up whatever this
// developer's own machine happens to have - a dispatcher pinned to a
// different build (a GATING warn), a real registration, a `claude` binary
// that CI never installs at all (doctor-strict.test.mjs's own comment: "CI
// already exits 1 over a missing claude binary"). Any of those makes "All
// good." unreachable for a reason that has nothing to do with this check,
// which is exactly the saturated-comparison shape test/CLAUDE.md warns
// about - an assertion that can't fail proves nothing.
//
// So this builds a genuinely clean baseline, not just a non-gating one:
// CLAUDE_CONFIG_DIR/HIVE_BIN_DIR isolate away the real registration and
// dispatcher (same as doctor-strict.test.mjs), and PATH carries only what
// this specific run needs to resolve - node itself, tmux, and a fake
// `claude` stub (makeFakeClaude, the project's own existing fixture for
// exactly this) - rather than the real PATH, which would also carry
// whatever `hive` dispatcher this developer has pinned.
function isolatedDoctorEnv(dirs) {
  const configDir = join(dirs.tmp, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const claudeBin = makeFakeClaude(dirs.tmp)();
  return {
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    // TMPDIR too (todo 375): doctor now reports orphaned scratch tmux
    // servers, which it finds by reading os.tmpdir(). Without this, the
    // "All good." control below asserts a fact about the DEVELOPER'S temp
    // directory - one aged scratch socket left by any earlier run makes it
    // unreachable, which is the same saturated-baseline shape this helper
    // already exists to close for the dispatcher, the registration and the
    // claude binary.
    tmp: dirs.tmp,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      HIVE_BIN_DIR: join(dirs.tmp, "no-dispatcher-here"),
      // dirname(process.execPath) so `runCli` can still spawn `node` itself
      // (it resolves the bare command name via this PATH, not
      // process.execPath directly) - dropping it reproduces exactly the
      // ENOENT test/CLAUDE.md warns a hostile-PATH fixture must not hide.
      // /usr/bin:/bin stays on the end for `which` itself (doctor's own
      // "claude" check shells out to it) - universal on both a Mac and CI's
      // Ubuntu runner, unlike tmux, which is the one binary that actually
      // moves between them (hence TMUX_DIR, resolved above rather than
      // guessed).
      PATH: `${dirname(process.execPath)}:${TMUX_DIR}:${dirname(claudeBin)}:/usr/bin:/bin`,
    },
  };
}

describe("hive doctor: review findings (todo 349)", () => {
  it("reads 0 tracked, not silence, when nothing is tagged - D1's own weakness made visible", async () => {
    const dirs = scratchDirs();
    await seed(dirs, async (mcp) => {
      // An ordinary, untagged todo: present in the store, invisible to this
      // check by design (D1's stated weakness), and must not be counted.
      await mcp.call("todo_create", { title: "untagged todo" });
    });

    // Never assert doctor's global exit code (test/CLAUDE.md) - an unrelated
    // check (no `claude` binary on a bare CI runner, say) can fail it
    // regardless of anything this test seeded.
    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: 0 tracked \(tagged from-counselors, .*\): 0 triaged, 0 untriaged\./);
    assert.doesNotMatch(stdout, /warn {2}review findings/);
  });

  it("counts a comment, completed, or archived finding as triaged, and an untagged one not at all", async () => {
    const dirs = scratchDirs();
    const ids = await seed(dirs, async (mcp) => {
      const commented = await mcp.call("todo_create", { title: "triaged by comment", tags: ["from-counselors"] });
      await mcp.call("todo_comment", { todo_id: commented.todo_id, body: "read and dispatched" });

      const completed = await mcp.call("todo_create", { title: "triaged by completion", tags: ["from-gate"] });
      await mcp.call("todo_update", { todo_id: completed.todo_id, status: "completed" });

      const archived = await mcp.call("todo_create", { title: "triaged by archive", tags: ["from-simplify"] });
      await mcp.call("todo_archive", { todo_id: archived.todo_id });

      await mcp.call("todo_create", { title: "irrelevant untagged todo" });

      return { commented, completed, archived };
    });

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: 3 tracked \(tagged from-counselors, .*\): 3 triaged, 0 untriaged\./);
    assert.doesNotMatch(stdout, /warn {2}review findings/);
    for (const id of Object.values(ids).map((t) => t.todo_id)) {
      assert.doesNotMatch(stdout, new RegExp(`todo ${id}\\b`));
    }
  });

  it("names an untriaged finding by id and does not fold it into 'All good.'", async () => {
    const dirs = scratchDirs();
    const isolated = isolatedDoctorEnv(dirs);

    // Positive control, proven FIRST: in this isolated env, with nothing
    // seeded yet, doctor genuinely prints "All good." - establishing that
    // the negative assertion below actually discriminates, rather than
    // failing to match for a reason that has nothing to do with this check
    // (an ambient dispatcher warn on a bare runCli, or a missing `claude`
    // binary - test/CLAUDE.md's "saturated comparison" shape, one level up
    // from an exit code).
    const clean = await runCli(["doctor"], isolated);
    assert.match(clean.stdout, /All good\./, clean.stdout);

    const untriaged = await seed(dirs, async (mcp) => {
      const triaged = await mcp.call("todo_create", { title: "already handled", tags: ["from-code-review"] });
      await mcp.call("todo_comment", { todo_id: triaged.todo_id, body: "rejected: not a bug" });
      return await mcp.call("todo_create", { title: "left rotting", tags: ["from-smoke-test"] });
    });

    const { stdout } = await runCli(["doctor"], isolated);
    assert.match(stdout, /info {2}review findings: 2 tracked \(tagged from-counselors, .*\): 1 triaged, 1 untriaged\./);
    assert.match(stdout, new RegExp(`warn {2}review findings: 1 untriaged: todo ${untriaged.todo_id}\\.`));
    assert.doesNotMatch(stdout, /All good\./, stdout);
  });

  // The lead's own correction on this lane: D1 originally listed five reader
  // tags and omitted from-sideproj, which is a real gap - a live
  // from-sideproj finding in this project (todo 339) had zero comments and
  // was invisible to the check as first shipped. This pins the fix rather
  // than only widening REVIEW_FINDING_TAGS and hoping the wildcard regexes
  // above happen to still match.
  it("tracks a from-sideproj finding - the tag D1 first omitted", async () => {
    const dirs = scratchDirs();
    const untriaged = await seed(dirs, (mcp) => mcp.call("todo_create", { title: "external report", tags: ["from-sideproj"] }));

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: 1 tracked \(tagged .*from-sideproj.*\): 0 triaged, 1 untriaged\./);
    assert.match(stdout, new RegExp(`warn {2}review findings: 1 untriaged: todo ${untriaged.todo_id}\\.`));
  });

  // Counselors, all three seats independently, on this lane's own diff:
  // matchesAnyTag matches whole tags, so a finding filed as a per-run-
  // numbered variant (from-counselors-23, say) reads as UNTAGGED to this
  // check even though it was deliberately tagged - and the live store
  // proves the shape is real, not hypothetical (todo 298 carries
  // from-counselors-22, no bare from-counselors tag). Worse than D1's own
  // stated weakness: an untagged finding at least makes the total read
  // zero; a suffixed one keeps the total honest-looking while dropping the
  // one finding that matters, silently. Red-proved: reverting
  // isReviewFindingTag to matchesAnyTag(t.tags, REVIEW_FINDING_TAGS) makes
  // this fail, reporting "0 tracked" instead of "1 tracked ... 1
  // untriaged".
  it("tracks a from-counselors-23 finding as untriaged, not as untagged (counselors round 1)", async () => {
    const dirs = scratchDirs();
    const untriaged = await seed(dirs, (mcp) =>
      mcp.call("todo_create", { title: "counselors run 23 finding", tags: ["from-counselors-23"] }),
    );

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: 1 tracked \(tagged from-counselors, .*\): 0 triaged, 1 untriaged\./);
    assert.match(stdout, new RegExp(`warn {2}review findings: 1 untriaged: todo ${untriaged.todo_id}\\.`));
  });

  // The companion negative control: a tag that merely CONTAINS a reader
  // name must not match. `from-gatekeeper` is not `from-gate`, and prefix
  // matching without the `-` separator would wrongly conflate them.
  it("does not match a tag that only shares a prefix with no separator", async () => {
    const dirs = scratchDirs();
    await seed(dirs, (mcp) => mcp.call("todo_create", { title: "unrelated todo", tags: ["from-gatekeeper"] }));

    const { stdout } = await runCli(["doctor"], { cwd: dirs.projectDir, dataDir: dirs.dataDir });
    assert.match(stdout, /info {2}review findings: 0 tracked \(tagged from-counselors, .*\): 0 triaged, 0 untriaged\./);
  });

  it("is non-gating: --strict does not turn it into a problem", async () => {
    const dirs = scratchDirs();
    await seed(dirs, async (mcp) => {
      await mcp.call("todo_create", { title: "left rotting", tags: ["from-counselors"] });
    });

    const isolated = isolatedDoctorEnv(dirs);
    const plain = await runCli(["doctor"], isolated);
    const strict = await runCli(["doctor", "--strict"], isolated);
    assert.match(plain.stdout, /warn {2}review findings: 1 untriaged/);
    // --strict changes what a warn counts for, not what prints: same warn
    // count either way.
    assert.equal(warningCount(strict.stdout), warningCount(plain.stdout), strict.stdout);
    // THE CASE THAT MATTERS: if this warn gated, --strict's problem count
    // would be one higher than plain's. It is not - matching doctor-strict.
    // test.mjs's own pattern for the identical claim on a different warn.
    assert.equal(
      failureCount(strict.stdout),
      failureCount(plain.stdout),
      "a non-gating warn must not change the problem count under --strict",
    );
  });
});
