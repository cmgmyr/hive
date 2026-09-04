import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("the hive.yml visible key tests");

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-visible-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { configHash, loadProjectYml } = await import("../dist/projectYml.js");
const { sessionName } = await import("../dist/tmux.js");

describe("hive.yml `visible` key (todo 767)", () => {
  it("defaults to true when the expanded form omits it, so today's own-window behaviour is unchanged", () => {
    const { config, warnings } = loadProjectYml(
      ymlProject("processes:\n  web:\n    command: sleep 600\n"),
    );
    assert.equal(config.processes.web.visible, true);
    assert.deepEqual(warnings, []);
  });

  it("is true for the shorthand string form, which has nowhere to say otherwise", () => {
    const { config, warnings } = loadProjectYml(ymlProject("processes:\n  web: sleep 600\n"));
    assert.equal(config.processes.web.visible, true);
    assert.deepEqual(warnings, []);
  });

  it("is false when the expanded form says false", () => {
    const { config, warnings } = loadProjectYml(
      ymlProject("processes:\n  web:\n    command: sleep 600\n    visible: false\n"),
    );
    assert.equal(config.processes.web.visible, false);
    assert.deepEqual(warnings, []);
  });

  it('warns naming the process and falls back to true on a non-boolean, so "no" does not read as false', () => {
    const { config, warnings } = loadProjectYml(
      ymlProject('processes:\n  web:\n    command: sleep 600\n    visible: "no"\n'),
    );
    assert.equal(config.processes.web.visible, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /visible must be true or false; ignoring "no"/);
    assert.match(warnings[0], /"web"/);
  });

  it("keeps every other process key untouched when visible is set", () => {
    const { config } = loadProjectYml(
      ymlProject(
        "processes:\n  web:\n    command: sleep 600\n    auto_start: false\n    visible: false\n    env:\n      PORT: 3000\n",
      ),
    );
    assert.deepEqual(config.processes.web, {
      command: "sleep 600",
      dir: null,
      auto_start: false,
      visible: false,
      env: { PORT: "3000" },
    });
  });

  it("does not smuggle visible into any field the trust hash covers", () => {
    const shown = loadProjectYml(
      ymlProject("processes:\n  web:\n    command: sleep 600\n    visible: true\n"),
    ).config.processes.web;
    const hidden = loadProjectYml(
      ymlProject("processes:\n  web:\n    command: sleep 600\n    visible: false\n"),
    ).config.processes.web;

    assert.equal(
      configHash("web", hidden.command, hidden.dir, hidden.env),
      configHash("web", shown.command, shown.dir, shown.env),
    );
  });
});

let session;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  session = sessionName();
});

after(() => cleanup(session));

describe("toggling `visible` does not re-require trust approval (todo 767, comment 3128)", () => {
  it("starts a process already approved under the other visibility, instead of asking again", async () => {
    const projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
    const ymlPath = join(dirs.projectDir, "hive.yml");

    writeFileSync(ymlPath, "processes:\n  web:\n    command: sleep 600\n    visible: true\n");
    const approved = loadProjectYml(dirs.projectDir).config.processes.web;
    db.prepare(
      "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
    ).run(projectId, "web", configHash("web", approved.command, approved.dir, approved.env));

    writeFileSync(ymlPath, "processes:\n  web:\n    command: sleep 600\n    visible: false\n");
    const { code, stdout } = await runCli(["start", "web"], opts);

    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /not trusted yet/, stdout);

    db.prepare("DELETE FROM agents WHERE project_id = ? AND name = 'web'").run(projectId);
  });
});
