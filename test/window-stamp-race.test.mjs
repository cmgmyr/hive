import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  failureCount,
  isolateTmux,
  makeFakeClaude,
  McpClient,
  panesIn,
  runCli,
  scratchDirs,
  tmux,
  windowOwners,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the window-stamp race test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

describe(
  "two concurrent spawns for one project cannot leave two windows carrying its stamp",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const projectDir = mkdtempSync(join(dirs.tmp, "race-"));
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("race", projectDir);
    const session = sessionName();
    const clients = [];
    let spawned;

    before(async () => {

      tmux("new-session", "-d", "-s", session, "-c", projectDir);

      for (let i = 0; i < 2; i++) {
        const mcp = new McpClient({ cwd: projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "500" } });
        await mcp.start();
        clients.push(mcp);
      }

      spawned = await Promise.all(
        clients.map((mcp, i) =>
          mcp.call("agent_spawn", {
            name: `racer-${i}`,
            command: fakeClaude("sleep 600"),
            extra_args: [],
            placement: "split",
          }),
        ),
      );
    });

    after(async () => {
      for (const mcp of clients) await mcp.close();
      cleanup(session);
    });

    it("leaves exactly ONE window carrying this project's @hive-project-id", () => {
      const owners = windowOwners(session);
      const stamped = owners.filter(([, id]) => id === String(project.id));
      assert.equal(
        stamped.length,
        1,
        `two creators must converge on one window for project ${project.id}; a second stamped window is ` +
          `permanent (findProjectWindow takes the lower index forever), got: ${JSON.stringify(owners)}`,
      );
    });

    it("puts both workers in that one window, so the loser is not left in a tab nothing points at", () => {
      const stamped = windowOwners(session).find(([, id]) => id === String(project.id));
      const panes = panesIn(stamped[0]);
      for (const worker of spawned) {
        assert.ok(
          panes.includes(worker.tmux_target),
          `worker pane ${worker.tmux_target} must be in the project's one window (${stamped[0]}), panes: ${panes}`,
        );
      }
    });

    it("hive doctor FAILS on two windows carrying one project's stamp, and passes without them", async () => {
      const clean = await runCli(["doctor"], { cwd: projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.match(
        clean.stdout,
        /ok {4}window stamps: 1 project window\(s\), no duplicates/,
        `doctor must pass its own check before the duplicate is created, got:\n${clean.stdout}`,
      );

      const decoy = tmux("new-window", "-P", "-F", "#{window_id}", "-t", `=${session}`, "-d", "sleep 600");
      tmux("set-window-option", "-t", decoy, "@hive-project-id", String(project.id));

      const dirty = await runCli(["doctor"], { cwd: projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(
        failureCount(dirty.stdout) - failureCount(clean.stdout),
        1,
        `exactly one new doctor failure, got:\n${dirty.stdout}`,
      );
      assert.match(dirty.stdout, new RegExp(`FAIL {2}window stamps`), dirty.stdout);
      assert.match(dirty.stdout, new RegExp(`project ${project.id} is stamped on 2 windows`), dirty.stdout);

      tmux("kill-window", "-t", decoy);
    });
  },
);
