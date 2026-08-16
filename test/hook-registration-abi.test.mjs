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

const { cleanup: cleanupTmux } = isolateTmux("the hook registration ABI tests");
after(() => cleanupTmux());

const alt = alternateInterpreter();

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();

const matchingFixture = classicAddonFixture({ matches: true });
const controlHook =
  alt && matchingFixture
    ? join(
        writeScratchAddon(join(dirs.tmp, "control-addon"), { prebuild: matchingFixture, classic: true }).dist,
        "hook.js",
      )
    : null;

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

  it("quotes the writing interpreter, not a bare `node`, for every registered event", () => {
    const hooksPath = ensureHooksFile();
    const settings = JSON.parse(readFileSync(hooksPath, "utf8"));

    for (const event of ["Stop", "UserPromptSubmit", "Notification"]) {
      const command = settings.hooks[event][0].hooks[0].command;

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
