import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  alternateInterpreter,
  assertScratchStore,
  classicAddonFixture,
  clearHiveEnv,
  isolateTmux,
  scratchDirs,
  writeScratchAddon,
} from "./helpers.mjs";

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

const alt = alternateInterpreter();

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

// Issue #105 lane B. better-sqlite3 13's N-API prebuilds load under any Node
// major on this platform/arch, so the REAL dist/hook.js the negative control
// used to point at no longer fails under alt.path - see
// test/fixtures/native-addon-abi/README.md. The two controls below run
// against a SCRATCH dist/hook.js instead, carrying a classic (pre-13) build;
// the "fixed" command a few lines down is unaffected, since it carries an
// absolute interpreter and never touches the hostile PATH at all.
//
// THE FIXTURE MATCHES THIS INTERPRETER, not merely "differs from alt", and
// that is the whole repair (issue #105 cleanup lane, todo 297 item 1). A
// fixture chosen only to differ from alt says nothing about whether it loads
// HERE: measured on this machine, alt is ABI 147, so the old
// `{ matches: false, against: alt.modules }` handed back the ABI 127 build,
// which the suite's own ABI 137 cannot load either. The control was then
// running a tree that nothing in the file ever required to WORK, so a
// half-built scratch checkout satisfied it exactly as well as an ABI refusal
// did. `{ matches: true }` gives a build that loads under process.execPath
// and, because alternateInterpreter() only ever returns an interpreter whose
// NODE_MODULE_VERSION differs from this one, cannot load under alt.path. One
// tree, one variable: the interpreter. Same fixture choice, and same reason,
// as test/kickoff-reexec.test.mjs.
//
// classic: true because the positive control has to open a real database.
// v13's lib/ over a v12 binary loads and then throws "addon.initialize is not
// a function" on the first query, which src/hook.ts swallows into exit 0 with
// no row - a green negative control and a positive one that can never pass.
const matchingFixture = classicAddonFixture({ matches: true });
const controlHook =
  alt && matchingFixture
    ? join(
        writeScratchAddon(join(dirs.tmp, "control-addon"), { prebuild: matchingFixture, classic: true }).dist,
        "hook.js",
      )
    : null;

// guardAbi()'s headline for failure === "mismatch" (src/abi.ts). Anchored and
// multiline so it matches the line hive prints and not a substring of some
// other message. Same constant, spelled the same way, as
// test/kickoff-reexec.test.mjs.
const ABI_FAILURE = /^hive: cannot run under this Node\.$/m;

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
  {
    skip:
      alt && controlHook
        ? false
        : alt
          ? `no pre-N-API better-sqlite3 fixture for ${process.platform}-${process.arch} ABI ${process.versions.modules} - add one (see test/fixtures/native-addon-abi/README.md) or this coverage is silently gone`
          : "no second Node with a different ABI on this machine",
  },
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

      // THE TWO CONTROLS BELOW ARE ONE EXPERIMENT. Without them the
      // assertions above have zero discriminating power: the fixed command
      // carries an absolute interpreter, so `sh` never consults PATH at all,
      // and deleting binDir, the symlink and the `path` option above leaves
      // the test passing byte-identically. Both run the SAME scratch
      // dist/hook.js, through the SAME hostile PATH, with the SAME payload,
      // each on its own actor so neither can disturb the other. The only
      // thing that differs between them is which interpreter runs the file.
      //
      // They run controlHook, not the real dist/hook.js, because
      // better-sqlite3 13's real installed addon loads under alt.path too
      // (see the comment above controlHook's definition), so a bare `node`
      // against the real hook would succeed here for a reason that has
      // nothing to do with whether the fix is in place.
      //
      // POSITIVE CONTROL FIRST, and it is the half that was missing. A
      // scratch tree that is merely BROKEN - MODULE_NOT_FOUND, a dangling
      // symlink, a half-run cpSync - exits nonzero and writes no row, which
      // is precisely what the negative control below demands, so on its own
      // that control passes green while proving nothing. This one requires
      // the same file, in the same tree, to WRITE A ROW under an interpreter
      // whose ABI the fixture matches. A malformed tree cannot satisfy both.
      const scratchActorId = "agent:hook-abi-stop-scratch";
      agentRow("hook-abi-stop-scratch");
      const scratchCommand = `${shellQuote(process.execPath)} ${shellQuote(controlHook)} stop`;
      const scratchRun = await runHookCommand(scratchCommand, { actorId: scratchActorId, payload, path: binDir });

      assert.equal(scratchRun.code, 0, `the scratch hook must work under an interpreter it fits: ${scratchRun.stderr}`);
      assert.deepEqual(
        logFor(scratchActorId),
        [{ event: "stop", state: "idle" }],
        "the scratch tree must be able to write a row, or the control below proves only that it is broken",
      );

      // NEGATIVE CONTROL: the PRE-FIX shape, a bare `node`, resolved through
      // the hostile PATH to alt.path. It must fail, and it must fail for the
      // ABI: a nonzero exit alone is this project's false-green shape 2
      // (test/CLAUDE.md), so the stderr has to name hive's own refusal and
      // the log has to stay empty. If this ever starts passing, either
      // alternateInterpreter() stopped returning a second ABI on this
      // machine, or the classic fixture stopped mismatching it - either way
      // the control, not the fix, needs attention.
      const controlActorId = "agent:hook-abi-stop-control";
      agentRow("hook-abi-stop-control");
      const bareCommand = `node ${shellQuote(controlHook)} stop`;
      const control = await runHookCommand(bareCommand, { actorId: controlActorId, payload, path: binDir });

      assert.notEqual(control.code, 0, "the pre-fix bare-`node` shape should fail under a hostile PATH");
      assert.match(
        control.stderr,
        ABI_FAILURE,
        `and it must fail because the addon refused, not for some other reason: ${control.stderr}`,
      );
      assert.deepEqual(logFor(controlActorId), [], "and it must write nothing, not just exit nonzero");
    });
  },
);
