import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { DIST, alternateInterpreter, assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

// This file imports shellQuote from dist/tmux.js, which is enough to trip
// suite-isolation.test.mjs's blanket rule for any dist/tmux.js import, even
// though nothing here spawns tmux or a hive command that could reach it.
const { cleanup: cleanupTmux } = isolateTmux("the hook registration ABI tests");
after(() => cleanupTmux());

// Issue #58. ensureHooksFile() used to register the worker-state hooks under a
// bare `node`, which a version manager resolves from the working directory
// the hook fires in, not the interpreter hive was built and is running under.
// This pins the fix: the generated command must carry an absolute interpreter,
// so it runs correctly even in a shell whose PATH resolves a bare `node` to an
// ABI that cannot load the addon at all.
//
// Assert a ROW, never an exit code: src/hook.ts's whole body is inside a
// try/catch that always process.exit(0)s, so a hook that silently did nothing
// looks identical, on exit code alone, to one that worked.

const HOOK = join(DIST, "hook.js");
const alt = alternateInterpreter();

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { ensureHooksFile } = await import("../dist/hooks.js");
const { shellQuote } = await import("../dist/tmux.js");
migrate();

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("hook-abi-test", dirs.dataDir).id;

function agentRow(name) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, agent_state)
       VALUES (?, ?, ?, '%9600', 'claude', '/tmp', 'running', 'unknown') RETURNING id`,
    )
    .get(project, `agent:${name}`, name).id;
}

function logFor(actorId) {
  return db.prepare("SELECT event, state FROM agent_state_log WHERE actor_id = ? ORDER BY id").all(actorId);
}

// Runs a hooks.json command string exactly the way Claude Code's shell form
// does: `sh -c`, the payload on stdin. `path` prepends a directory to PATH,
// which only matters to a command that resolves `node` through it; the fixed
// command carries an absolute interpreter and never consults PATH at all.
function runHookCommand(command, { actorId, payload, path }) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      env: {
        PATH: path ? `${path}:${process.env.PATH}` : process.env.PATH,
        HOME: process.env.HOME,
        HIVE_DATA_DIR: dirs.dataDir,
        HIVE_AGENT_ID: actorId,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(payload ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the generated hook commands carry an absolute interpreter", () => {
  // Pure string checks against ensureHooksFile()'s own output, no second Node
  // involved, so this always runs. The execution test below needs a second
  // ABI and skips without one; a revert to a bare `node` must still be
  // visible on a single-Node box, or this whole file would report 0 failed
  // the day someone reverts src/hooks.ts on such a machine.
  it("quotes the writing interpreter, not a bare `node`, for every registered event", () => {
    const hooksPath = ensureHooksFile();
    const settings = JSON.parse(readFileSync(hooksPath, "utf8"));

    for (const event of ["Stop", "UserPromptSubmit", "Notification"]) {
      const command = settings.hooks[event][0].hooks[0].command;
      // Pin the shape of the fix against shellQuote's own output, not a
      // literal quote character: shellQuote (src/tmux.ts:778) only quotes a
      // string that actually needs it, and leaves a safe one bare. This dev
      // machine's process.execPath has a space in it (Herd's nvm path), so it
      // gets single-quoted here, but an ordinary path like
      // /opt/homebrew/bin/node or the CI runner's
      // /Users/runner/hostedtoolcache/node/.../bin/node is safe and comes back
      // BARE. Asserting a literal `"` or `'` prefix would pass on this
      // machine and fail on CI and on most real installs, the false-green
      // shape test/CLAUDE.md warns about, running in the direction that
      // breaks CI instead of the direction that hides a bug.
      assert.ok(
        command.startsWith(`${shellQuote(process.execPath)} `),
        `${event}: command should start with this interpreter, correctly quoted for sh: ${command}`,
      );
      assert.ok(!command.startsWith("node "), `${event}: command must not start with a bare "node ": ${command}`);
    }
  });
});

describe(
  "the generated hook command survives a PATH whose bare `node` cannot load the addon",
  { skip: alt ? false : "no second Node with a different ABI on this machine" },
  () => {
    it("still writes agent_state and an agent_state_log row, unlike the pre-fix bare-`node` shape", async () => {
      const hooksPath = ensureHooksFile();
      const settings = JSON.parse(readFileSync(hooksPath, "utf8"));
      const command = settings.hooks.Stop[0].hooks[0].command;

      const binDir = join(dirs.tmp, "hostile-bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(alt.path, join(binDir, "node"));

      const payload = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, background_tasks: [] });

      const actorId = "agent:hook-abi-stop";
      agentRow("hook-abi-stop");
      const { code, stderr } = await runHookCommand(command, { actorId, payload, path: binDir });

      assert.equal(code, 0, stderr);
      const state = db.prepare("SELECT agent_state FROM agents WHERE actor_id = ?").get(actorId);
      assert.equal(state?.agent_state, "idle");
      assert.deepEqual(logFor(actorId), [{ event: "stop", state: "idle" }]);

      // NEGATIVE CONTROL. Without this, the assertions above have zero
      // discriminating power: the fixed command carries an absolute
      // interpreter, so `sh` never consults PATH at all, and deleting binDir,
      // the symlink and the `path` option above leaves the test passing
      // byte-identically. This runs the PRE-FIX shape, a bare `node`, through
      // the exact same hostile PATH and payload, on a separate actor so it
      // cannot disturb the assertions above, and requires it to fail: a
      // nonzero exit AND an empty log, not just the exit code. Two exit codes
      // compared for an unrelated reason is this project's own false-green
      // shape 2 (test/CLAUDE.md), so the log has to be checked too. If this
      // ever starts passing, alternateInterpreter() has stopped returning an
      // ABI-hostile interpreter on this machine and the control, not the fix,
      // needs attention.
      const controlActorId = "agent:hook-abi-stop-control";
      agentRow("hook-abi-stop-control");
      const bareCommand = `node ${shellQuote(HOOK)} stop`;
      const control = await runHookCommand(bareCommand, { actorId: controlActorId, payload, path: binDir });

      assert.notEqual(control.code, 0, "the pre-fix bare-`node` shape should fail under a hostile PATH");
      assert.deepEqual(logFor(controlActorId), [], "and it must write nothing, not just exit nonzero");
    });
  },
);
