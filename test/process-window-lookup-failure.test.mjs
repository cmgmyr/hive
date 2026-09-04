import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import { fakeFailingTmux, isolateTmux, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the window-lookup failure tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { createWindow, ensureSession, projectWindows, sessionName } = await import("../dist/tmux.js");

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

let projectId;
let session;
let blindTmux;

// Everything but list-windows still answers, so the pane is genuinely there and genuinely hidden:
// the only thing hive has lost is its ability to say WHERE.
const blind = () => ({ ...opts, env: { PATH: `${blindTmux}:${process.env.PATH}` } });

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  const project = db.prepare("SELECT id, name FROM projects LIMIT 1").get();
  projectId = project.id;
  session = sessionName();
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: { api: { command: "sleep 600", visible: false } },
  });
  blindTmux = fakeFailingTmux({ failOn: "list-windows" });

  if (!hasTmux) return;

  ensureSession(session, dirs.projectDir, { bare: true });
  createWindow(session, project.name, dirs.projectDir, [], "sleep 600", projectId, true, false);
  await runCli(["start", "api"], opts);
});

after(() => {
  cleanup(session);
  rmSync(blindTmux, { recursive: true, force: true });
});

describe("a window lookup that did not answer is not read as a located pane (todo 767)", () => {
  it("answers null for a failed lookup and a windowless answer for a session that has none", needsTmux, () => {
    assert.deepEqual(projectWindows(`${session}-no-such-session`, projectId), {
      processes: undefined,
      project: undefined,
    });

    const realPath = process.env.PATH;
    process.env.PATH = `${blindTmux}:${realPath}`;
    try {
      assert.equal(projectWindows(session, projectId), null);
    } finally {
      process.env.PATH = realPath;
    }
  });

  it("makes show say it cannot tell, not that the project has no window yet", needsTmux, async () => {
    const { code, stdout } = await runCli(["show", "api"], blind());

    assert.equal(code, 0, stdout);
    assert.match(stdout, /api: tmux could not be probed, so hive cannot tell where its pane is/);
  });

  it("makes hide say it cannot tell, rather than failing on tmux's own error text", needsTmux, async () => {
    const { code, stdout, stderr } = await runCli(["hide", "api"], blind());

    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /api: tmux could not be probed, so hive cannot tell where its pane is/);
    assert.doesNotMatch(stdout + stderr, /break-pane|join-pane/);
  });

  it("stops hive status calling the pane's own window a location", needsTmux, async () => {
    const { code, stdout } = await runCli(["status"], blind());

    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /cmd\s+api\s+(own window|hidden|shown)/);
    assert.match(stdout, /cmd\s+api\s+running/);
  });

  it("counts the process hive cannot locate separately from the ones it can", needsTmux, async () => {
    const { stdout } = await runCli(["doctor"], blind());

    assert.match(stdout, /processes:\s+1 running \(0 hidden, 1 hive cannot locate\), 0 defined not running/);
  });

  it("keeps the located counts clean when the lookup does answer", needsTmux, async () => {
    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /processes:\s+1 running \(1 hidden\), 0 defined not running/);
  });
});
