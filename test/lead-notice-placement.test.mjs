import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { CLI, baseEnv, clearHiveEnv, isolateTmux, makeFakeClaude, scratchDirs } from "./helpers.mjs";

// Lane A step 4 (plan-lane-a-cmdlead-characterisation, pad 73, HALF 2). The
// registration notice used to print at resolve time - the very first line of
// cmdLead, a second-plus and a dozen console.log lines before the attach
// that takes over the terminal and scrolls it away, invisible in practice.
// Now printed LAST, immediately before that attach (decisions/2026-08-05-
// cli-notices-go-to-stderr.md's sibling problem, not what that decision
// itself fixes). test/cli-registration-notice.test.mjs already pins the
// notice's TEXT and its stderr routing for the general case (`hive init`);
// this file pins WHEN `hive lead` specifically prints it.
//
// Review round 1 (F2/F3/F4) found the first version of this file measured
// nothing: it timestamped stdout/stderr `data` events in the PARENT process,
// but those are two independent OS pipes, and a parent-side timestamp
// records which pipe libuv happened to service first, not which console.*
// call the CHILD made first. Under the print-at-resolve-time mutation the
// child's own write order is still notice-then-marker, sub-millisecond
// apart; whichever pipe's callback fired first in the parent could go
// either way, and it measured to "notice after marker" with a 0.4ms margin
// - noise, not a measurement, and the mutation "passed" by luck rather than
// having been fixed. Rebuilt around a MERGED stream instead: the child's
// own shell redirects fd 2 into fd 1 before either byte leaves the process,
// so kernel write order in the one resulting stream really is program print
// order, and ordering is now a string-offset comparison, not a clock
// sample. The exactly-once check is also fixed: NOTICE_LINE is a non-global
// regexp, so `String.match` returned a single result whether the text
// occurred once or five times - `assert.equal(count, 1)` was asserting
// nothing beyond the existence check already above it.

const { hasTmux, cleanup } = isolateTmux("the lead registration-notice placement test");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

const NOTICE_LINE =
  /^hive: no registered project matched this session's working directory, so it created project \d+.*$/m;

// A hive.yml with one auto_start:false process, and no `lead:` override, so
// this test's own fixture has a marker that fires LATE in cmdLead - right
// before the deferred print, after ensureLeadRow/the CAS/tmux setup - not
// only an early one. Load-bearing for what F3 actually needs: with no
// hive.yml at all, cmdLead prints exactly ONE line ("No hive.yml here...")
// before the notice and nothing else before attach's own ready line, so
// "the notice is the line immediately before ready" would hold true even
// under the F3 mutation (move the print right after that one early line) -
// nothing else prints in between either way, so that placement would be
// indistinguishable from the correct one. A process line that fires right
// before the true print position closes that: moving the print anywhere
// earlier than its correct spot leaves this line sitting between the
// notice and the ready line, and the immediately-before assertion catches
// it. auto_start:false means the loop logs this line and continues; it
// never calls ensureTrusted, so no trust prompt is needed.
writeFileSync(
  `${dirs.projectDir}/hive.yml`,
  "processes:\n  marker:\n    command: \"true\"\n    auto_start: false\n",
);
const LATE_MARKER = '- marker: defined, auto_start off (start with: hive start "marker")';

// A single merged stream, not two independent pipes: `2>&1` inside the
// child's OWN shell merges stdout and stderr at the kernel level before
// either reaches this process, so string position in the resulting buffer
// really is print order - unlike timestamping two separate `data` callbacks
// in the parent (see the file comment above).
function runLeadMerged(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(
      "/bin/sh",
      ["-c", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} lead 2>&1`],
      {
        cwd,
        env: {
          ...baseEnv(),
          HIVE_DATA_DIR: dirs.dataDir,
          HIVE_AUTO_ATTACH: "0",
          ...env,
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    // close, not exit: node's own docs say a child's stdio streams may
    // still be open when `exit` fires, so resolving there can drop a
    // buffered chunk this test then asserts against.
    child.on("close", (code) => resolve({ code, output }));
  });
}

describe(
  "the hive lead registration notice prints LAST, not at resolve time",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "is the line immediately before attach's own ready line, and appears exactly once",
      async () => {
        const fakeClaude = makeFakeClaude(dirs.tmp);
        const claudePath = fakeClaude("sleep 600");
        // dirs.projectDir is NEVER registered before this call - that is
        // what triggers effectiveProjectId's silent-registration fallback
        // and its notice, the same trigger test/cli-registration-notice
        // .test.mjs uses for `hive init`.
        const projectDir = dirs.projectDir;
        let session;
        try {
          const result = await runLeadMerged(projectDir, {
            PATH: `${dirname(claudePath)}:${process.env.PATH}`,
          });
          assert.equal(result.code, 0, result.output);

          const project = db.prepare("SELECT id, name, path FROM projects WHERE path = ?").get(projectDir);
          assert.ok(project, "hive lead must have registered this project");
          session = sessionName();

          const lines = result.output.split("\n");
          assert.ok(
            lines.includes(LATE_MARKER),
            `expected the auto_start-off marker line in output; got: ${result.output}`,
          );

          // attach()'s own first line, printed the instant it takes over -
          // this harness's child has no TTY, so this is attach()'s
          // unconditional no-TTY branch, not a guess about which one runs.
          const readyLine = `Session ${session} is ready for project "${project.name}" (${project.path}).`;
          const readyIndex = lines.indexOf(readyLine);
          assert.ok(readyIndex > 0, `expected to find "${readyLine}" in output; got: ${result.output}`);

          // THE ASSERTION THIS BEHAVIOUR IS: not "somewhere before attach",
          // but the line immediately preceding it - "last" is the whole
          // decision (pad 73, HALF 2). THE MUTATION THIS FAILS AGAINST,
          // THREE WAYS: (a) print at resolve time - the notice becomes the
          // very first line, nowhere near readyIndex - 1; (b) delete the
          // print entirely - readyIndex - 1 is LATE_MARKER, which does not
          // match NOTICE_LINE; (c) move the print to immediately after the
          // early "No hive.yml here" log (F3's required mutation) - this
          // fixture has no such line (config exists), but the equivalent
          // early placement leaves LATE_MARKER between the notice and
          // readyLine, and lines[readyIndex - 1] is LATE_MARKER, not the
          // notice, exactly as it would for any placement earlier than the
          // true last-line position.
          assert.match(
            lines[readyIndex - 1],
            NOTICE_LINE,
            `expected the registration notice immediately before "${readyLine}"; ` +
              `got "${lines[readyIndex - 1]}" - full output: ${result.output}`,
          );

          // Exactly once. A global regexp, not NOTICE_LINE's own /m: F4
          // found `String.match` with a non-global pattern returns a single
          // result whether the text occurs once or five times, so the old
          // count here asserted nothing the match above did not already.
          const notices = result.output.match(new RegExp(NOTICE_LINE.source, "gm")) || [];
          assert.equal(notices.length, 1, `expected exactly one notice line, got ${notices.length}: ${result.output}`);
        } finally {
          if (session) cleanup(session);
        }
      },
    );
  },
);

describe(
  "the notice survives a throw between capture and the deferred print (F5)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it(
      "still prints on stderr, and still exits nonzero, when tmux is unreachable before ensureSession",
      async () => {
        // A fresh, still-unregistered project dir - dirs.projectDir was
        // already registered by the test above, in the same module-scoped
        // store. PATH excludes tmux entirely, the cheap way to make
        // ensureSession throw without needing a real absent-tmux machine:
        // execFileSync("tmux", ...) fails ENOENT regardless of whether this
        // developer's machine has tmux installed, and tmux.ts's own
        // wrapper turns that into a TmuxError, thrown before any tmux
        // command in cmdLead's body can succeed - the plainest reachable
        // case named in src/cli.ts's own catch-block comment.
        const projectDir = realpathSync(mkdtempSync(join(dirname(dirs.projectDir), "project-")));
        const result = await runLeadMerged(projectDir, { PATH: "/nonexistent-hive-test-path" });

        // Before this fix, a throw here dropped the notice permanently: the
        // project registers regardless of what happens next, and the
        // notice is a consume-once in-process fact with no later chance to
        // print. THE MUTATION THIS FAILS AGAINST: removing the catch
        // block's own `if (registrationNotice) console.error(...)` (keeping
        // the `throw e` after it) - the process still exits nonzero, but
        // the notice never appears anywhere.
        assert.equal(result.code, 1, `expected hive lead to exit 1 when tmux is unreachable; got: ${result.output}`);
        assert.match(
          result.output,
          NOTICE_LINE,
          `expected the registration notice despite the throw; got: ${result.output}`,
        );

        const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir);
        assert.ok(project, "the project must still be registered even though the lead never started");
      },
    );
  },
);
