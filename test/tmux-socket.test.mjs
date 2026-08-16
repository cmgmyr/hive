import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  clearHiveEnv,
  isolateTmux,
  leadRow,
  makeFakeClaude,
  recordScratchTmuxSocket,
  runCli,
  scratchDirs,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the tmux-socket write-path tests");

clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { sessionName, tmuxSocketPath } = await import("../dist/tmux.js");
const { addProject } = await import("../dist/context.js");
migrate();

describe(
  "launchAgent records this process's tmux socket on the INSERT and the tmux_target UPDATE",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("a freshly spawned agents row carries tmuxSocketPath(TMUX, TMUX_TMPDIR) for this process", async () => {
      const { launchAgent, closeAgentRow } = await import("../dist/spawn.js");
      const project = addProject(dirs.projectDir, "tmux-socket-spawn");
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const commandString = fakeClaude("sleep 600");

      const { agentId } = launchAgent({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        name: "tmux-socket-worker",
        kind: "agent",
        commandString,
        cwd: project.path,
        env: {},
        placement: "window",
        parentActor: "test:tmux-socket-spawn",
      });

      const expected = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);

      assert.ok(expected.length > 0, "setup bug: this process's own socket path must be non-empty");

      const row = db.prepare("SELECT tmux_socket, tmux_target FROM agents WHERE id = ?").get(agentId);
      assert.equal(row.tmux_socket, expected);
      assert.ok(row.tmux_target.length > 0, "setup bug: the target must have been recorded for this assertion to mean anything");

      closeAgentRow(agentId);
      cleanup(sessionName());
    });
  },
);

describe(
  "hive lead records the socket at creation and re-records it on every restart",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    const leadProjectDir = mkdtempSync(join(dirs.tmp, "lead-proj-"));
    const project = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id, name, path")
      .get("tmux-socket-lead", leadProjectDir);
    const session = sessionName();
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude("sleep 600");
    const PATH = `${dirname(claudePath)}:${process.env.PATH}`;

    after(() => cleanup(session));

    it("the first `hive lead` seeds tmux_socket on the fresh INSERT and the restart CAS", async () => {
      const lead = await runCli(["lead"], {
        cwd: project.path,
        dataDir: dirs.dataDir,
        tmp: dirs.tmp,
        env: { PATH },
      });
      assert.equal(lead.code, 0, lead.stderr);

      const row = leadRow(db, project.id);
      const expected = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
      assert.equal(row.tmux_socket, expected);
      assert.ok(row.tmux_target.startsWith("%"), "setup bug: the lead pane must have been recorded");
    });

    it("a restart landing on a DIFFERENT real tmux server re-records the new socket, not the old one", async () => {
      const before = leadRow(db, project.id);

      const otherSocketDir = mkdtempSync(join(tmpdir(), "hive-tmux-b-"));
      const otherSession = sessionName();

      const expectedNew = tmuxSocketPath(undefined, otherSocketDir);

      recordScratchTmuxSocket(expectedNew);
      try {
        const restarted = await runCli(["lead"], {
          cwd: project.path,
          dataDir: dirs.dataDir,
          tmp: dirs.tmp,
          env: { PATH, TMUX_TMPDIR: otherSocketDir },
        });
        assert.equal(restarted.code, 0, restarted.stderr);

        const updated = leadRow(db, project.id);
        const expectedOld = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
        assert.notEqual(expectedNew, expectedOld, "setup bug: the two tmux servers must resolve to different sockets");
        assert.equal(updated.tmux_socket, expectedNew, "the row must carry the socket of the server the restart actually landed on");
        assert.notEqual(updated.tmux_socket, before.tmux_socket, "the OLD socket must not survive the restart");
      } finally {
        try {
          execFileSync("tmux", ["-S", expectedNew, "kill-session", "-t", `=${otherSession}`], { stdio: "ignore" });
        } catch {

        }
        rmSync(otherSocketDir, { recursive: true, force: true });
      }
    });
  },
);
