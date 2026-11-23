import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, fakeFailingTmux, isolateTmux, runCli, scratchDirs, seedTrustedYml } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the process start outcome tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
await assertScratchStore();
const { sessionName } = await import("../dist/tmux.js");
const session = sessionName();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };
const outside = join(dirname(dirs.projectDir), "outside");
const untrustedMarker = join(dirs.tmp, "untrusted-ran");
let projectId;

before(async () => {
  mkdirSync(outside, { recursive: true });
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects WHERE path = ?").get(dirs.projectDir).id;
  await seedTrustedYml({
    db,
    projectId,
    projectDir: dirs.projectDir,
    processes: {
      api: { command: "sleep 600", visible: false },
      crash: { command: "exit 17", visible: false },
      lead: { command: "sleep 600", visible: false },
      escaped: { command: "sleep 600", visible: false, dir: "../outside" },
      untrusted: { command: `touch ${untrustedMarker}`, visible: false },
    },
  });
  db.prepare("DELETE FROM command_trust WHERE project_id = ? AND name = ?").run(projectId, "untrusted");
});

after(() => cleanup(session));

describe("hive start reports typed outcomes", () => {
  it("sets a nonzero exit status when process launch throws", needsTmux, async () => {
    const result = await runCli(["start", "crash"], opts);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^crash: failed: /m);
    assert.equal(db.prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = 'crash' AND status = 'running'").get(projectId), undefined);
  });

  it("keeps already-running starts successful", needsTmux, async () => {
    const first = await runCli(["start", "api"], opts);
    assert.equal(first.code, 0, first.stdout + first.stderr);

    const second = await runCli(["start", "api"], opts);

    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /^api: already running(?: \((?:shown|hidden)\))?$/m);
  });

  it("sets a nonzero exit status when existing process liveness is unknown", needsTmux, async () => {
    const first = await runCli(["start", "api"], opts);
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const failingTmux = fakeFailingTmux({ failOn: "list-panes" });

    try {
      const result = await runCli(["start", "api"], {
        ...opts,
        env: { PATH: `${failingTmux}:${process.env.PATH}` },
      });

      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /api: skipped: tmux could not be probed/);
      assert.doesNotMatch(result.stdout, /api: failed:/);
    } finally {
      rmSync(failingTmux, { recursive: true, force: true });
    }
  });

  it("sets a nonzero exit status when the process name is reserved", async () => {
    const result = await runCli(["start", "lead"], opts);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^lead: skipped: "lead" is reserved/m);
    assert.equal(db.prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = 'lead'").get(projectId), undefined);
  });

  it("sets a nonzero exit status when the configured directory escapes the project", async () => {
    const result = await runCli(["start", "escaped"], opts);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^escaped: skipped: dir "\.\.\/outside" escapes the project root$/m);
    assert.equal(db.prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = 'escaped'").get(projectId), undefined);
  });

  it("keeps an untrusted command refused and exits nonzero", async () => {
    const result = await runCli(["start", "untrusted"], opts);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /"untrusted" is not trusted yet/);
    assert.equal(existsSync(untrustedMarker), false);
    assert.equal(db.prepare("SELECT 1 FROM agents WHERE project_id = ? AND name = 'untrusted'").get(projectId), undefined);
  });
});
