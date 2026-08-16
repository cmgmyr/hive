import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { CLI, baseEnv, clearHiveEnv, isolateTmux, makeFakeClaude, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead registration-notice placement test");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

const NOTICE_LINE =
  /^hive: no registered project matched this session's working directory, so it created project \d+.*$/m;

writeFileSync(
  `${dirs.projectDir}/hive.yml`,
  "processes:\n  marker:\n    command: \"true\"\n    auto_start: false\n",
);
const LATE_MARKER = '- marker: defined, auto_start off (start with: hive start "marker")';

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

          const readyLine = `Session ${session} is ready for project "${project.name}" (${project.path}).`;
          const readyIndex = lines.indexOf(readyLine);
          assert.ok(readyIndex > 0, `expected to find "${readyLine}" in output; got: ${result.output}`);

          assert.match(
            lines[readyIndex - 1],
            NOTICE_LINE,
            `expected the registration notice immediately before "${readyLine}"; ` +
              `got "${lines[readyIndex - 1]}" - full output: ${result.output}`,
          );

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

        const projectDir = realpathSync(mkdtempSync(join(dirname(dirs.projectDir), "project-")));
        const result = await runLeadMerged(projectDir, { PATH: "/nonexistent-hive-test-path" });

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
