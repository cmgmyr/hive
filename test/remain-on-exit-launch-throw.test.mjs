import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs, scratchGit } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the remain-on-exit launch-throw tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

scratchGit(dirs.projectDir, "init", "-q");
scratchGit(dirs.projectDir, "commit", "-q", "--allow-empty", "-m", "root");
writeFileSync(join(dirs.projectDir, "hive.yml"), "agents: [claude, codex]\n");

const fakeHome = join(dirs.tmp, "fake-home");
mkdirSync(join(fakeHome, ".codex"), { recursive: true });
writeFileSync(join(fakeHome, ".codex", "auth.json"), JSON.stringify({ tokens: "not real" }));

const binDir = join(dirs.tmp, "harness-bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexec sleep 600\n");
chmodSync(join(binDir, "codex"), 0o755);

const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "tmux";
writeFileSync(
  join(binDir, "tmux"),
  `#!/bin/sh
for a in "$@"; do
  if [ "$a" = '#{pane_id}\t#{pane_pid}' ]; then
    '${realTmux}' "$@" | cut -f1
    exit 0
  fi
done
exec '${realTmux}' "$@"
`,
  { mode: 0o755 },
);

let mcp;
let anchor;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    env: { HIVE_SPAWN_READY_MS: "3000", HOME: fakeHome, PATH: `${binDir}:${process.env.PATH}` },
  });
  await mcp.start();
  if (hasTmux) anchor = await mcp.call("agent_spawn", { name: "anchor", command: "sleep", extra_args: ["600"] });
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe("remain-on-exit armed by a spawn", () => {
  it(
    "is cleared when launchAgent throws after arming it",
    { skip: hasTmux ? false : "tmux is not installed" },
    async () => {
      await assert.rejects(
        mcp.call("agent_spawn", { name: "no-pid", harness: "codex" }),
        /did not report a process id for the new pane %\d+ when it created it/,
      );
      const window = execFileSync(
        realTmux,
        ["display-message", "-p", "-t", anchor.tmux_target, "#{session_name}:#{window_id}"],
        { encoding: "utf8" },
      ).trim();
      const options = execFileSync(realTmux, ["show-window-options", "-t", window], { encoding: "utf8" });
      assert.doesNotMatch(options, /remain-on-exit on/);
      const panes = execFileSync(realTmux, ["list-panes", "-t", window, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
      assert.equal(panes, anchor.tmux_target, "the pane with no recorded pid was left running");
    },
  );
});
