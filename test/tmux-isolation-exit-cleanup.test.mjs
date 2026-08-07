import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO, isolateTmux, scratchDirs } from "./helpers.mjs";

// Todo 294 (counselors: nothing on the branch showed the fix could fail).
// test/CLAUDE.md's own rule - say out loud what would have to be true for a
// test to PASS while the behaviour it names is BROKEN - applies to this
// lane's own fix as much as to any product code. Every other test in this
// area is a source-text check (suite-isolation.test.mjs): it can prove a
// call is SHAPED correctly and still pass if kill-server silently did
// nothing at runtime. This is a behavioural check of the actual lifetime
// isolateTmux()'s exit handler changed: spawn a real child process that
// creates a tmux session it deliberately never cleans up, let it exit on
// its own, and assert from the parent both what the child itself reported
// and that its server PROCESS - not its socket, see the assertion's own
// comment for why that distinction is load-bearing - is actually gone.
//
// Mutation-tested both halves of the exit handler, not just written and
// trusted: replacing the list-sessions report with a no-op turns the
// exit-code/stderr assertion red; replacing the kill-server call with a
// no-op turns the process.kill(pid, 0) assertion red. Both verified by
// grepping the mutated file for the replaced line before running, so the
// mutation is known to have actually applied rather than assumed.
const { hasTmux } = isolateTmux("the tmux-isolation exit-cleanup behavioural check");

describe(
  "isolateTmux()'s exit handler reaps an uncleaned session (todo 294)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("reports the session it left running, then reaps it, without the child ever calling cleanup()", () => {
      const { tmp } = scratchDirs();
      const helpersPath = JSON.stringify(join(REPO, "test", "helpers.mjs"));
      // Deliberately does NOT call cleanup() on the session it creates - the
      // exact shape this todo's own bug took (a session nobody threaded
      // through to cleanup), reproduced on purpose rather than argued about.
      const source =
        `const { isolateTmux } = await import(${helpersPath});\n` +
        `const { execFileSync } = await import("node:child_process");\n` +
        `isolateTmux("positive control child");\n` +
        `execFileSync("tmux", ["new-session", "-d", "-s", "leak-me", "sleep", "600"], { stdio: "ignore" });\n` +
        `const serverPid = execFileSync("tmux", ["display-message", "-p", "#{pid}"], { encoding: "utf8" }).trim();\n` +
        `console.log(JSON.stringify({ tmuxTmpDir: process.env.TMUX_TMPDIR, serverPid }));\n`;
      const file = join(tmp, "positive-control-child.mjs");
      writeFileSync(file, source);

      const result = spawnSync(process.execPath, [file], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });

      // Fix 2's own signal: the exit handler's list-sessions check must have
      // seen "leak-me" still there and named it, BEFORE going on to kill it.
      // A non-zero exit with this message is what the child is SUPPOSED to
      // do here - this is the one case in the suite where that is correct.
      assert.equal(result.status, 1, `expected the child to report its own leak; got: ${result.stderr}`);
      assert.match(result.stderr, /left tmux session\(s\) behind on its own private socket: leak-me/);

      const { tmuxTmpDir, serverPid } = JSON.parse(result.stdout);
      const socket = join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 0}`, "default");

      // Todo 294, counselors mutation testing. An EARLIER version of this
      // check asserted only that `tmux -S <socket> list-sessions` throws,
      // which is a false green: it throws for TWO different reasons this
      // codebase cannot tell apart from outside - the server was actually
      // killed (what this test means to prove), or the socket FILE is gone,
      // which the exit handler's own unconditional rmSync does regardless
      // of whether the reap ran. Proved this concretely, not argued: with
      // the exit handler's kill-server call replaced by `void 0` (verified
      // applied by grepping for the mutated line), this test still PASSED
      // 1/1 - the socket-throw assertion was satisfied by cleanup this test
      // never changed, and would have passed on main before this lane
      // existed. The same shape as this project's own recorded "fixture
      // with zero discriminating power."
      //
      // The check that actually distinguishes a reaped server from a
      // deleted socket file: ask the SERVER PROCESS itself, by the pid it
      // reported before the child exited, not the socket. process.kill(pid,
      // 0) sends no signal and only probes existence; it throws ESRCH once
      // the process is gone, which is true regardless of whether the socket
      // file backing it still exists. Restored after the mutation-testing
      // above (verified applied by grepping for the reap line): re-ran this
      // exact assertion and it correctly threw ESRCH (reaped), then
      // temporarily reverted helpers.mjs to its pre-todo-294 state and
      // re-ran the whole file - process.kill(pid, 0) did NOT throw (the
      // server the mutation-testing above proves nothing else in this file
      // would have caught was still genuinely alive), so this is the
      // assertion that actually carries the claim.
      assert.throws(
        () => process.kill(Number(serverPid), 0),
        /ESRCH/,
        `server pid ${serverPid} should no longer exist - isolateTmux()'s exit handler should have killed it ` +
          "even though the child never called cleanup() on the session it created",
      );

      // Kept as a secondary signal, not the one carrying this test: still
      // true once the server is actually gone, and it also catches the
      // narrower case of the socket file surviving a killed server (which
      // should never happen, but this is one more thing that would notice).
      assert.throws(
        () => execFileSync("tmux", ["-S", socket, "list-sessions"], { stdio: "pipe" }),
        /./,
        "the child's socket should answer nothing either, once its server is actually gone",
      );
    });
  },
);
