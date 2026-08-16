import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO, isolateTmux, scratchDirs } from "./helpers.mjs";

const { hasTmux } = isolateTmux("the tmux-isolation exit-cleanup behavioural check");

describe(
  "isolateTmux()'s exit handler reaps an uncleaned session (todo 294)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("reports the session it left running, then reaps it, without the child ever calling cleanup()", () => {
      const { tmp } = scratchDirs();
      const helpersPath = JSON.stringify(join(REPO, "test", "helpers.mjs"));

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

      assert.equal(result.status, 1, `expected the child to report its own leak; got: ${result.stderr}`);
      assert.match(result.stderr, /left tmux session\(s\) behind on its own private socket: leak-me/);

      const { tmuxTmpDir, serverPid } = JSON.parse(result.stdout);
      const socket = join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 0}`, "default");

      assert.throws(
        () => process.kill(Number(serverPid), 0),
        /ESRCH/,
        `server pid ${serverPid} should no longer exist - isolateTmux()'s exit handler should have killed it ` +
          "even though the child never called cleanup() on the session it created",
      );

      assert.throws(
        () => execFileSync("tmux", ["-S", socket, "list-sessions"], { stdio: "pipe" }),
        /./,
        "the child's socket should answer nothing either, once its server is actually gone",
      );
    });
  },
);
