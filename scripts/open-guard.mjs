// Todo 419. Every `npm test` run installs a fake `open` on PATH for the
// WHOLE run, from scripts/run-tests.mjs, and this module is what builds that
// fake and interprets what it recorded.
//
// WHY THE RUNNER, NOT A SHARED TEST BOOTSTRAP - the distinction is
// load-bearing, not decoration. `.claude/sessions/decisions/2026-07-28-two-
// guards-for-test-store-isolation.md` rejected "a shared test bootstrap
// imported first by every test file" on exactly this shape: it converts
// "remember to call the helper" into "remember to import the bootstrap
// FIRST", the same failure with the same trigger, since a hoisted static
// import can land above it and nothing enforces the ordering. A PATH fake
// installed by the process that SPAWNS every test file cannot be beaten that
// way - it is on PATH before `node --test` even starts, no test file has to
// do anything to get it, and the only way past it is to actively rewrite
// PATH, which is exactly what test/dashboard-open.test.mjs and
// test/dashboard-open-lead.test.mjs already do on purpose (their own
// makeFakeOpen bin, prepended ahead of this one) to keep exercising the real
// open path under their own fake.
//
// WHAT COUNTS AS A LEAK HERE. Under normal operation NOTHING should ever
// reach this fake: a test that means to exercise the open path fakes it
// itself (ahead of this one on PATH, per the two files above) or suppresses
// it with `--no-dashboard`. So unlike scripts/tmux-leaks.mjs, which has to
// tell a real leak apart from ordinary debris, any call recorded here at all
// is the finding - there is no clean-but-present case to filter out.
//
// REPRODUCTION NEEDS TWO PRECONDITIONS TOGETHER, and both were missing from
// a fresh worktree, which is why the original instrumentation run (todo 419
// comment 1106) recorded zero calls on the very code that produced three
// real windows: a dashboard FILE has to already exist at the resolved
// project path (maybeOpenDashboard, src/cli.ts, returns early with no file),
// and the kv store backing that project must carry no live
// `hive:dashboard_opened` marker (a fresh scratch store always qualifies -
// see readOpenCalls's own header for why that makes the escape "armed by
// construction" in a scratch-store test). A worktree's `.claude/dashboard/`
// is gitignored and nothing generates it, so the first precondition was
// absent there; the main checkout's copy is kept alive by every live hive MCP
// instance ticking that project's scheduler. test/open-call-guard.test.mjs
// reproduces both preconditions directly rather than relying on either
// checkout's ambient state.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Builds the fake `open` bin and its log. Call once per `npm test` run (or
// once per test scenario that needs to reproduce the escape directly); reap()
// removes the temp directory.
export function installFakeOpen() {
  const bin = mkdtempSync(join(tmpdir(), "hive-fake-open-bin-"));
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "open"),
    "#!/bin/sh\n" +
      "{\n" +
      "  printf 'ARGS: %s\\n' \"$*\"\n" +
      "  printf 'CWD: %s\\n' \"$PWD\"\n" +
      "  printf 'HIVE_DATA_DIR: %s\\n' \"$HIVE_DATA_DIR\"\n" +
      // Walk the process ancestry rather than trusting our own immediate
      // parent alone: the direct caller of execFileSync("open", ...) is
      // often a `dist/cli.js` child the test spawned, not the test file's
      // own process, so naming the test needs a few levels up. Measured to
      // work: ANCESTOR[0] or [1] names the .test.mjs file directly, since
      // node --test's default process isolation puts the file path in that
      // child's own argv.
      "  pid=$PPID\n" +
      "  i=0\n" +
      "  while [ $i -lt 6 ] && [ -n \"$pid\" ]; do\n" +
      "    cmd=$(ps -o command= -p \"$pid\" 2>/dev/null)\n" +
      "    [ -z \"$cmd\" ] && break\n" +
      "    printf 'ANCESTOR[%s] pid=%s cmd=%s\\n' \"$i\" \"$pid\" \"$cmd\"\n" +
      "    pid=$(ps -o ppid= -p \"$pid\" 2>/dev/null | tr -d ' ')\n" +
      "    i=$((i+1))\n" +
      "  done\n" +
      "  printf -- '---\\n'\n" +
      `} >> ${JSON.stringify(log)}\n` +
      "exit 0\n",
  );
  chmodSync(join(bin, "open"), 0o755);
  return { bin, log, reap: () => rmSync(bin, { recursive: true, force: true }) };
}

// Each call is one "---"-terminated block; splitting on the terminator
// rather than counting ARGS lines keeps a call's own multi-line ancestry
// dump attached to it instead of miscounting.
export function readOpenCalls(log) {
  const raw = readFileSync(log, "utf8").trim();
  if (raw.length === 0) return [];
  return raw
    .split(/\n?---\n?/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function describeOpenCalls(calls) {
  if (calls.length === 0) return ["no `open` calls reached the suite-wide fake"];
  return [
    `${calls.length} \`open\` call(s) reached the suite-wide fake (todo 419) - either fake ` +
      "it locally ahead of this one on PATH (test/dashboard-open.test.mjs), or pass " +
      "--no-dashboard, or the escape is real and needs closing:",
    ...calls.flatMap((call) => call.split("\n").map((line) => `  ${line}`)),
  ];
}

// Any recorded call is a failure - see this module's own header for why
// there is no clean-but-present case to filter out here, unlike the tmux
// leak check.
export function openCallsFailed(calls) {
  return calls.length > 0;
}
