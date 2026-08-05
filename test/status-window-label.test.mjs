import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

// Todo 272 / plan-lane-3-tmux-topology. Found by the lead by RUNNING the
// command, not by the suite: under one store-scoped session (3a),
// `hive status` printed the IDENTICAL `session: hive-<tag>main` for every
// project - before 3a it printed hive-1 / hive-12, which identified the
// project, so this was correct and useless. The window now identifies a
// project (@hive-project-id, findProjectWindow); this pins that `hive
// status` actually prints it.
const { hasTmux, cleanup } = isolateTmux("the status window-label tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };

clearHiveEnv();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");
migrate();

writeFileSync(join(dirs.projectDir, "hive.yml"), "profile: orchestration\n");
const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);
const project = db.prepare("SELECT id, path FROM projects WHERE path = ?").get(dirs.projectDir);

// Any open todo is enough to keep this project's line printing (cmdStatus
// skips a project with zero agents, zero todos and zero timers).
db.prepare("INSERT INTO todos (project_id, title, status) VALUES (?, 'window label test', 'open')").run(project.id);

describe(
  "hive status prints the project's window, not the shared session name",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const session = sessionName();

    it("prints the real window id this project's window is stamped with", async () => {
      ensureSession(session, dirs.projectDir);
      const { window } = createWindow(session, "status-label-test", dirs.projectDir, [], "sleep 600", project.id);

      const { code, stdout } = await runCli(["status"], opts);
      assert.equal(code, 0, stdout);
      assert.match(stdout, new RegExp(`window: ${window.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.doesNotMatch(
        stdout,
        new RegExp(`session: ${session}`),
        "must not print the old session-only line - it named every project identically",
      );

      cleanup(session);
    });

    it("degrades honestly when the project has no window yet, instead of throwing", async () => {
      // A project can carry open todos with no tmux session ever created
      // (the lead never started) - the common case for a freshly registered
      // project. findProjectWindow throws ("can't find session") against a
      // session that does not exist; this must not take `hive status` down
      // with it.
      const { code, stdout } = await runCli(["status"], opts);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /window: none yet/);
    });
  },
);

// Todo 274/275 addendum (topology-3c). sessionName() is invariant across the
// whole process (one store-scoped session), so forking `tmux list-windows`
// once PER PROJECT inside cmdStatus's loop forks the identical listing
// every time - cmdStatus now fetches it once, lazily, and matches each
// project against the shared result (the same pattern cmdDoctor's own
// hiveSessions() already uses). Proven here against the REAL binary, not a
// canned stub: a passthrough `tmux` shim on PATH logs only `list-windows`
// invocations and then execs the real tmux with the identical argv, so this
// cannot pass by coincidence of a mocked answer - the command actually runs.
describe(
  "hive status forks list-windows once, not once per project",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("two projects, each with real windows and open todos, cost exactly one list-windows fork", async () => {
      const { db, migrate } = await import("../dist/db.js");
      const { createWindow, ensureSession, sessionName } = await import("../dist/tmux.js");
      migrate();

      const session = sessionName();
      ensureSession(session, dirs.projectDir);

      const secondDir = mkdtempSync(join(dirs.tmp, "status-fork-second-"));
      writeFileSync(join(secondDir, "hive.yml"), "profile: orchestration\n");
      const secondInit = await runCli(["init"], { ...opts, cwd: secondDir });
      assert.equal(secondInit.code, 0, secondInit.stderr);
      const secondProject = db.prepare("SELECT id FROM projects WHERE path = ?").get(secondDir);
      db.prepare("INSERT INTO todos (project_id, title, status) VALUES (?, 'second project window fork test', 'open')").run(
        secondProject.id,
      );

      const { window: windowA } = createWindow(session, "fork-test-a", dirs.projectDir, [], "sleep 600", project.id);
      const { window: windowB } = createWindow(session, "fork-test-b", secondDir, [], "sleep 600", secondProject.id);

      const bin = mkdtempSync(join(dirs.tmp, "status-fork-bin-"));
      const callsLog = join(dirs.tmp, "list-windows-calls.log");
      // The REAL PATH, captured before the shim goes in front of it, so the
      // shim's own `exec tmux` resolves to the genuine binary rather than
      // recursing into itself.
      const realPath = process.env.PATH;
      writeFileSync(
        join(bin, "tmux"),
        `#!/bin/sh
if [ "$1" = "list-windows" ]; then
  printf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}
fi
PATH=${JSON.stringify(realPath)} exec tmux "$@"
`,
      );
      chmodSync(join(bin, "tmux"), 0o755);

      const { code, stdout } = await runCli(["status"], {
        ...opts,
        env: { PATH: `${bin}:${realPath}` },
      });
      assert.equal(code, 0, stdout);

      // Correctness, not just the fork count: both projects must still
      // resolve their OWN real window, proving the shared fetch was matched
      // per project rather than one project's answer leaking into the other.
      assert.match(stdout, new RegExp(`window: ${windowA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(stdout, new RegExp(`window: ${windowB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      let calls;
      try {
        calls = readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        calls = [];
      }
      assert.equal(
        calls.length,
        1,
        `expected exactly one list-windows fork for two projects sharing one session; got: ${JSON.stringify(calls)}`,
      );

      cleanup(session);
    });
  },
);

// Review gate on PR #116 (the ubuntu legs' first real pass, 10m44s, one
// finding - not the 15-second no-op this repo has seen twice before). The
// window-label comment above named "no tmux binary" as a path to the
// distinct "unknown (tmux unreachable)" label; it is not - tmuxSaysNothingThere()
// returns true for e.notInstalled by design (src/tmux.ts), so a missing
// binary takes the SAME "none yet" branch as "the lead never started". The
// comment is now corrected to say so; this pins the behaviour it claims,
// which nothing in the suite covered before this.
//
// test/CLAUDE.md's own guidance ("run the suite with a PATH that lacks
// [installed binaries]") is the precedent for simulating this - applied
// here to one subprocess rather than the whole run, by filtering tmux's
// directory out of PATH rather than replacing PATH wholesale, so `node`
// itself (runCli spawns it by bare name) and everything else `hive status`
// might touch stay resolvable.
function pathWithoutTmux() {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const withoutTmux = dirs.filter((dir) => {
    try {
      return !existsSync(join(dir, "tmux"));
    } catch {
      return true;
    }
  });
  return withoutTmux.join(":");
}

describe("hive status with no tmux binary reachable at all", () => {
  it('degrades to "none yet", the same label as no session/window yet - never the distinct "unknown" label', async () => {
    const PATH = pathWithoutTmux();
    assert.ok(PATH.length > 0, "setup bug: PATH must still resolve node and everything else hive status needs");

    const { code, stdout, stderr } = await runCli(["status"], { ...opts, env: { PATH } });
    assert.equal(code, 0, `hive status must not crash with no tmux on PATH; stderr: ${stderr}`);
    assert.match(stdout, /window: none yet/);
    assert.doesNotMatch(
      stdout,
      /unknown \(tmux unreachable\)/,
      "a missing binary must read the same as no session/window yet, never the distinct unknown label",
    );
  });
});
