import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
const { cleanup } = isolateTmux("todo completion gate");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { configHash } = await import("../dist/projectYml.js");
const { completionGateTrust, runTodoCompletionGate, todoCompletionGateTrusted } = await import("../dist/todoCompletionGate.js");

migrate();
after(() => cleanup());

function project(name) {
  const path = join(dirs.tmp, name);
  mkdirSync(path, { recursive: true });
  return addProject(path, name);
}

it("hashes literal completion argv with the existing per-project command trust descriptor", () => {
  const argv = [process.execPath, "a file.js", "quoted ' argument"];
  const descriptor = completionGateTrust(argv);
  assert.deepEqual(descriptor, {
    name: "hive:todo-completion-gate",
    command: JSON.stringify(argv),
    dir: null,
    env: {},
  });
  const row = project("gate-trust-descriptor");
  assert.equal(todoCompletionGateTrusted(row.id, argv), false);
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)")
    .run(row.id, descriptor.name, configHash(descriptor.name, descriptor.command, descriptor.dir, descriptor.env));
  assert.equal(todoCompletionGateTrusted(row.id, argv), true);
  assert.equal(todoCompletionGateTrusted(row.id, [...argv, "changed"]), false);
});

it("an untrusted gate refuses with an approval instruction and never spawns", async () => {
  const row = project("gate-untrusted");
  const marker = join(dirs.tmp, "untrusted-gate-ran");
  await assert.rejects(
    runTodoCompletionGate({
      projectId: row.id,
      projectPath: row.path,
      todoId: 481,
      title: "literal title",
      actorId: "agent:test",
      argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    }),
    /\[todo_completion_gate:untrusted\].*completion gate in hive\.yml is not approved yet/s,
  );
  assert.equal(existsSync(marker), false);
});

it("hive lead interactively approves the gate descriptor without running it", async () => {
  const row = project("gate-interactive-approval");
  const marker = join(dirs.tmp, "approval-must-not-run-gate");
  const gatePath = join(row.path, "gate.js");
  writeFileSync(gatePath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  writeFileSync(join(row.path, "hive.yml"), `completion_gate: [${JSON.stringify(process.execPath)}, ${JSON.stringify(gatePath)}]\n`);
  const fakeBin = join(dirs.tmp, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const claude = join(fakeBin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexec sleep 2\n");
  chmodSync(claude, 0o755);
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const ptyDriver = [
    "import errno, os, pty, select, sys",
    "pid, fd = pty.fork()",
    "if pid == 0:",
    "    os.execve(sys.argv[1], [sys.argv[1], sys.argv[2], 'lead'], os.environ)",
    "buf = b''",
    "sent = False",
    "while True:",
    "    ready, _, _ = select.select([fd], [], [], 0.1)",
    "    if ready:",
    "        try: chunk = os.read(fd, 4096)",
    "        except OSError as error:",
    "            if error.errno == errno.EIO: break",
    "            raise",
    "        if not chunk: break",
    "        buf += chunk",
    "        if not sent and b'Trust and run this command from now on?' in buf:",
    "            os.write(fd, b'y\\n')",
    "            sent = True",
    "    done, status = os.waitpid(pid, os.WNOHANG)",
    "    if done: break",
    "if os.waitpid(pid, os.WNOHANG)[0] == 0:",
    "    _, status = os.waitpid(pid, 0)",
    "sys.stdout.buffer.write(buf)",
    "sys.exit(os.waitstatus_to_exitcode(status))",
  ].join("\n");
  const child = spawn("python3", ["-c", ptyDriver, process.execPath, cli], {
    cwd: row.path,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVE_DATA_DIR: dirs.dataDir, HIVE_AUTO_ATTACH: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0, output);
  assert.equal(todoCompletionGateTrusted(row.id, [process.execPath, gatePath]), true, output);
  assert.equal(existsSync(marker), false, "approval records trust without executing the gate");
});
