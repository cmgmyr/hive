import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, it } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import { assertScratchStore, clearHiveEnv, isolateTmux, McpClient, runCli, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
const { cleanup } = isolateTmux("todo completion gate");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { configHash } = await import("../dist/projectYml.js");
const { completionGateTrust, runTodoCompletionGate, todoCompletionGateTrusted } = await import("../dist/todoCompletionGate.js");
const { sessionName } = await import("../dist/tmux.js");

migrate();
const gateProject = addProject(dirs.projectDir, "todo-completion-gate");
const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
await mcp.start();
mcp.timeoutMs = 40_000;
after(async () => { await mcp.close(); cleanup(sessionName()); });

const gateTrustName = "hive:todo-completion-gate";
function setGate(argv) {
  writeFileSync(join(dirs.projectDir, "hive.yml"), `completion_gate: ${JSON.stringify(argv)}\n`);
  db.prepare("DELETE FROM command_trust WHERE project_id = ? AND name = ?").run(gateProject.id, gateTrustName);
  const descriptor = completionGateTrust(argv);
  db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)")
    .run(gateProject.id, descriptor.name, configHash(descriptor.name, descriptor.command, descriptor.dir, descriptor.env));
}

async function waitForFile(path, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(path), `file did not appear before the ${waitMs}ms deadline: ${path}`);
}

it("the absent project key keeps both existing completion receipts and status writes", async () => {
  const todo = await mcp.call("todo_create", { title: "legacy completion" });
  const complete = await mcp.request("tools/call", { name: "todo_complete", arguments: { todo_id: todo.todo_id } });
  assert.equal(complete.result.isError, undefined);
  assert.equal(
    complete.result.content[0].text,
    JSON.stringify({ project_id: gateProject.id, todo_id: todo.todo_id, completed: true, newly_unblocked: [] }, null, 1),
  );
  assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "completed");

  const updated = await mcp.call("todo_create", { title: "legacy update" });
  const update = await mcp.request("tools/call", {
    name: "todo_update",
    arguments: { todo_id: updated.todo_id, status: "completed" },
  });
  assert.equal(update.result.isError, undefined);
  assert.equal(update.result.content[0].text, JSON.stringify({ project_id: gateProject.id, todo_id: updated.todo_id }, null, 1));
  assert.equal((await mcp.call("todo_get", { todo_id: updated.todo_id })).status, "completed");
});

function project(name) {
  const path = join(dirs.tmp, name);
  mkdirSync(path, { recursive: true });
  return addProject(path, name);
}

async function runLeadInPty(row, fakeBin, answer) {
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
    "            os.write(fd, (sys.argv[3]+'\\n').encode())",
    "            sent = True",
    "    done, status = os.waitpid(pid, os.WNOHANG)",
    "    if done: break",
    "if os.waitpid(pid, os.WNOHANG)[0] == 0:",
    "    _, status = os.waitpid(pid, 0)",
    "sys.stdout.buffer.write(buf)",
    "sys.exit(os.waitstatus_to_exitcode(status))",
  ].join("\n");
  const child = spawn("python3", ["-c", ptyDriver, process.execPath, cli, answer], {
    cwd: row.path,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVE_DATA_DIR: dirs.dataDir, HIVE_AUTO_ATTACH: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once("close", resolve));
  return { code, output };
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

it("both completion tools wait for the trusted literal command and persist only after it passes", async () => {
  const marker = join(dirs.tmp, "gate-success.json");
  const literal = "$(echo nope) 'quoted'\nnext";
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({cwd:process.cwd(), argv:process.argv[1], id:process.env.HIVE_TODO_ID, title:process.env.HIVE_TODO_TITLE, project:process.env.HIVE_PROJECT_ID, actor:process.env.HIVE_ACTOR_ID}))`;
  const argv = [process.execPath, "-e", script, literal];
  setGate(argv);
  for (const [index, method] of ["todo_complete", "todo_update"].entries()) {
    const todo = await mcp.call("todo_create", { title: `candidate ${index}` });
    const dependent = await mcp.call("todo_create", { title: `dependent ${index}`, blocked_by: [todo.todo_id] });
    const candidateTitle = `candidate 'title'\n${index}`;
    if (method === "todo_complete") await mcp.call(method, { todo_id: todo.todo_id });
    else await mcp.call(method, { todo_id: todo.todo_id, status: "completed", title: candidateTitle });
    const output = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(output.cwd, dirs.projectDir);
    assert.equal(output.argv, literal);
    assert.equal(output.id, String(todo.todo_id));
    assert.equal(output.title, method === "todo_update" ? candidateTitle : `candidate ${index}`);
    assert.equal(output.project, String(gateProject.id));
    assert.equal(output.actor, `user:${userInfo().username}`);
    assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "completed");
    assert.equal((await mcp.call("todo_get", { todo_id: dependent.todo_id })).open_blockers, 0);
  }
});

it("a nonzero gate refuses the whole todo_update patch and preserves its dependent blocker", async () => {
  const argv = [process.execPath, "-e", "process.stdout.write('stdout clue'); process.stderr.write('stderr clue'); process.exit(7)"];
  setGate(argv);
  const todo = await mcp.call("todo_create", { title: "old title", body: "old body" });
  const dependent = await mcp.call("todo_create", { title: "still blocked", blocked_by: [todo.todo_id] });
  await assert.rejects(
    mcp.call("todo_update", { todo_id: todo.todo_id, title: "new title", body: "new body", status: "completed" }),
    /\[todo_completion_gate:failed\] todo .*exit 7.*stdout clue.*stderr clue/s,
  );
  const saved = await mcp.call("todo_get", { todo_id: todo.todo_id });
  assert.equal(saved.title, "old title");
  assert.equal(saved.body, "old body");
  assert.equal(saved.status, "open");
  assert.equal(saved.completed_at, null);
  assert.equal((await mcp.call("todo_get", { todo_id: dependent.todo_id })).open_blockers, 1);

  const completeFailure = await mcp.call("todo_create", { title: "complete still open" });
  await assert.rejects(mcp.call("todo_complete", { todo_id: completeFailure.todo_id }), /\[todo_completion_gate:failed\].*exit 7/s);
  assert.equal((await mcp.call("todo_get", { todo_id: completeFailure.todo_id })).status, "open");
});

it("reopening, ordinary updates and already-completed writes never run a failing gate", async () => {
  const marker = join(dirs.tmp, "nontransition-runs");
  rmSync(join(dirs.projectDir, "hive.yml"), { force: true });
  const todo = await mcp.call("todo_create", { title: "reopen me" });
  await mcp.call("todo_complete", { todo_id: todo.todo_id });
  const archived = await mcp.call("todo_create", { title: "archived reopen" });
  await mcp.call("todo_complete", { todo_id: archived.todo_id });
  await mcp.call("todo_archive", { todo_id: archived.todo_id });
  setGate([process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.exit(5)`]);
  const before = existsSync(marker) ? readFileSync(marker, "utf8").length : 0;
  await mcp.call("todo_complete", { todo_id: todo.todo_id, completed: true });
  await mcp.call("todo_update", { todo_id: todo.todo_id, status: "completed" });
  await mcp.call("todo_complete", { todo_id: todo.todo_id, completed: false });
  await mcp.call("todo_update", { todo_id: todo.todo_id, title: "ordinary edit" });
  assert.equal(existsSync(marker) ? readFileSync(marker, "utf8").length : 0, before);
  assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "open");

  await assert.rejects(mcp.call("todo_complete", { todo_id: archived.todo_id, completed: false }), /Cannot reopen archived todo/);
  assert.equal(existsSync(marker) ? readFileSync(marker, "utf8").length : 0, before);
});

it("a missing or changed gate trust refuses without executing the edited argv", async () => {
  const marker = join(dirs.tmp, "edited-gate-ran");
  const approved = [process.execPath, "-e", "process.exit(0)"];
  const edited = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
  setGate(approved);
  writeFileSync(join(dirs.projectDir, "hive.yml"), `completion_gate: ${JSON.stringify(edited)}\n`);
  for (const [index, method] of ["todo_complete", "todo_update"].entries()) {
    const a = await mcp.call("todo_create", { title: `untrusted argv ${index}` });
    const args = method === "todo_complete" ? { todo_id: a.todo_id } : { todo_id: a.todo_id, status: "completed" };
    await assert.rejects(mcp.call(method, args), /\[todo_completion_gate:untrusted\].*run `hive` in a terminal/s);
    assert.equal((await mcp.call("todo_get", { todo_id: a.todo_id })).status, "open");
  }
  assert.equal(existsSync(marker), false);
});

it("an invalid gate field refuses, while a malformed whole hive.yml follows the no-gate ruling", async () => {
  const invalid = await mcp.call("todo_create", { title: "invalid field" });
  writeFileSync(join(dirs.projectDir, "hive.yml"), "completion_gate: [node, 3]\n");
  await assert.rejects(mcp.call("todo_complete", { todo_id: invalid.todo_id }), /\[todo_completion_gate:invalid\]/);
  assert.equal((await mcp.call("todo_get", { todo_id: invalid.todo_id })).status, "open");

  const malformed = await mcp.call("todo_create", { title: "malformed whole file" });
  writeFileSync(join(dirs.projectDir, "hive.yml"), "completion_gate: [node\n");
  const receipt = await mcp.call("todo_complete", { todo_id: malformed.todo_id });
  assert.equal(receipt.completed, true);
  assert.equal((await mcp.call("todo_get", { todo_id: malformed.todo_id })).status, "completed");
});

it("a project-locked server cannot complete another project's todo", async () => {
  const other = project("gate-other-project");
  const todo = await mcp.call("todo_create", { title: "must stay open", project_id: other.id });
  const locked = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_PROJECT_LOCK: "1" },
  });
  await locked.start();
  try {
    await assert.rejects(locked.call("todo_complete", { todo_id: todo.todo_id, project_id: other.id }), /Cross-project access is disabled/);
    assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id, project_id: other.id })).status, "open");
  } finally {
    await locked.close();
  }
});

it("a pending gate leaves the event loop and store transaction available, then rejects a same-second row edit", async () => {
  const ready = join(dirs.tmp, "row-race-ready");
  const release = join(dirs.tmp, "row-race-release");
  const script = `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(ready)},'ready'); const end=Date.now()+8000; while(!f.existsSync(${JSON.stringify(release)})&&Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`;
  setGate([process.execPath, "-e", script]);
  const todo = await mcp.call("todo_create", { title: "before race" });
  const otherServer = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await otherServer.start();
  try {
    const pending = mcp.call("todo_complete", { todo_id: todo.todo_id });
    await waitForFile(ready);
    assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).title, "before race");
    await otherServer.call("todo_update", { todo_id: todo.todo_id, title: "changed in same second" });
    writeFileSync(release, "go");
    await assert.rejects(pending, /\[todo_completion_gate:changed\]/);
    const saved = await mcp.call("todo_get", { todo_id: todo.todo_id });
    assert.equal(saved.title, "changed in same second");
    assert.equal(saved.status, "open");
  } finally {
    rmSync(release, { force: true });
    await otherServer.close();
  }
});

it("a project config edit during the gate invalidates its result", async () => {
  const ready = join(dirs.tmp, "config-race-ready");
  const release = join(dirs.tmp, "config-race-release");
  const script = `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(ready)},'ready'); const end=Date.now()+8000; while(!f.existsSync(${JSON.stringify(release)})&&Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`;
  const original = [process.execPath, "-e", script];
  setGate(original);
  const todo = await mcp.call("todo_create", { title: "config race" });
  const pending = mcp.call("todo_complete", { todo_id: todo.todo_id });
  try {
    await waitForFile(ready);
    writeFileSync(join(dirs.projectDir, "hive.yml"), `completion_gate: ${JSON.stringify([...original, "changed"])}\n`);
    writeFileSync(release, "go");
    await assert.rejects(pending, /\[todo_completion_gate:changed\]/);
    assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "open");
  } finally {
    rmSync(release, { force: true });
  }
});

it("revoking gate trust while the child runs blocks the completion", async () => {
  const ready = join(dirs.tmp, "trust-race-ready");
  const release = join(dirs.tmp, "trust-race-release");
  const argv = [process.execPath, "-e", `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(ready)},'ready'); const end=Date.now()+8000; while(!f.existsSync(${JSON.stringify(release)})&&Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`];
  setGate(argv);
  const todo = await mcp.call("todo_create", { title: "trust race" });
  const pending = mcp.call("todo_complete", { todo_id: todo.todo_id });
  try {
    await waitForFile(ready);
    db.prepare("DELETE FROM command_trust WHERE project_id = ? AND name = ?").run(gateProject.id, gateTrustName);
    writeFileSync(release, "go");
    await assert.rejects(pending, /\[todo_completion_gate:untrusted\]/);
    assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "open");
  } finally {
    rmSync(release, { force: true });
  }
});

it("signal exits, spawn failures and output overflow refuse with bounded stream tails", async () => {
  const todo = await mcp.call("todo_create", { title: "failure modes" });
  setGate([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
  await assert.rejects(mcp.call("todo_complete", { todo_id: todo.todo_id }), /\[todo_completion_gate:signal\].*signal SIGTERM/s);
  setGate([join(dirs.tmp, "does-not-exist")]);
  await assert.rejects(mcp.call("todo_complete", { todo_id: todo.todo_id }), /\[todo_completion_gate:spawn\]/);
  setGate([process.execPath, "-e", "process.stdout.write('a'.repeat(6000)); process.stderr.write('b'.repeat(6000)); process.exit(8)"]);
  await assert.rejects(mcp.call("todo_complete", { todo_id: todo.todo_id }), (error) => {
    assert.match(error.message, /\[todo_completion_gate:failed\].*exit 8/);
    assert.match(error.message, /stdout tail:/);
    assert.match(error.message, /stderr tail:/);
    assert.ok(error.message.length < 8500, "error should carry bounded tails, not all 12 KB");
    return true;
  });
  assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "open");
});

it("a gate that ignores SIGTERM is killed and refuses at the fixed 30 second bound", async () => {
  const todo = await mcp.call("todo_create", { title: "timeout" });
  setGate([process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
  const started = Date.now();
  await assert.rejects(mcp.call("todo_complete", { todo_id: todo.todo_id }), /\[todo_completion_gate:timeout\]/);
  assert.ok(Date.now() - started >= 29_000, "the configured 30000ms timeout must be observed");
  assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "open");
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
  const { code, output } = await runLeadInPty(row, fakeBin, "y");
  assert.equal(code, 0, output);
  assert.equal(todoCompletionGateTrusted(row.id, [process.execPath, gatePath]), true, output);
  assert.equal(existsSync(marker), false, "approval records trust without executing the gate");
});

it("a declined interactive gate review records no trust", async () => {
  const row = project("gate-declined-approval");
  const gatePath = join(row.path, "gate.js");
  writeFileSync(gatePath, "process.exit(0);\n");
  const argv = [process.execPath, gatePath];
  writeFileSync(join(row.path, "hive.yml"), `completion_gate: ${JSON.stringify(argv)}\n`);
  const fakeBin = join(dirs.tmp, "declined-fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const claude = join(fakeBin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexec sleep 2\n");
  chmodSync(claude, 0o755);
  const { code, output } = await runLeadInPty(row, fakeBin, "n");
  assert.equal(code, 0, output);
  assert.match(output, /Skipped "hive:todo-completion-gate"/);
  assert.equal(todoCompletionGateTrusted(row.id, argv), false);
});

it("a noninteractive lead start does not approve or run the gate", async () => {
  const row = project("gate-noninteractive-approval");
  const marker = join(dirs.tmp, "noninteractive-gate-ran");
  const argv = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
  writeFileSync(join(row.path, "hive.yml"), `completion_gate: ${JSON.stringify(argv)}\n`);
  const fakeBin = join(dirs.tmp, "noninteractive-fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const claude = join(fakeBin, "claude");
  writeFileSync(claude, "#!/bin/sh\nexec sleep 2\n");
  chmodSync(claude, 0o755);
  const result = await runCli(["lead"], {
    cwd: row.path,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /hive:todo-completion-gate.*not trusted yet/);
  assert.equal(todoCompletionGateTrusted(row.id, argv), false);
  assert.equal(existsSync(marker), false);
});
