import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { configHash } from "../dist/projectYml.js";
import { isolateTmux, leadRow, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead session name tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();
const { sessionName } = await import("../dist/tmux.js");
const { carriesNameFlag } = await import("../dist/harnesses.js");

const binDir = join(dirs.tmp, "bin");
mkdirSync(binDir, { recursive: true });
writeFileSync(join(binDir, "claude"), "#!/bin/sh\nsleep 600\n");
writeFileSync(join(binDir, "codex"), "#!/bin/sh\nsleep 600\n");
chmodSync(join(binDir, "claude"), 0o755);
chmodSync(join(binDir, "codex"), 0o755);

const sessions = [];
after(() => {
  for (const session of sessions) cleanup(session);
});

function project(name, lead) {
  const projectDir = join(dirs.tmp, name);
  mkdirSync(projectDir, { recursive: true });
  if (lead) {
    writeFileSync(join(projectDir, "hive.yml"), `lead: ${lead}\n`);
  }
  const row = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, projectDir);
  if (lead) {
    db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)").run(
      row.id,
      "lead",
      configHash("lead", lead, null, {}),
    );
  }
  return { id: row.id, dir: projectDir };
}

async function start(project) {
  const session = sessionName();
  sessions.push(session);
  const result = await runCli(["lead"], {
    cwd: project.dir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(result.code, 0, result.stderr);
  return leadRow(db, project.id).command;
}

describe("naming a claude lead session", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("a claude lead is started with --name <project name>", async () => {
    const p = project("lead-name-default");
    assert.match(await start(p), /--name lead-name-default(?: |$)/);
  });

  it("a project name with a space is passed as one quoted token", async () => {
    const p = project("peer lead");
    assert.match(await start(p), /--name 'peer lead'(?: |$)/);
  });

  it("a configured lead command that already names itself is left alone", async () => {
    const p = project("lead-name-custom", "claude --name custom");
    const command = await start(p);
    assert.equal((command.match(/--name/g) ?? []).length, 1);
    assert.match(command, /--name custom/);
  });

  it("a -n short flag counts as already named", async () => {
    const p = project("lead-name-short", "claude -n custom");
    assert.doesNotMatch(await start(p), /--name/);
  });

  it("a codex lead gets no --name", async () => {
    const p = project("lead-name-codex", "codex");
    assert.doesNotMatch(await start(p), /--name/);
  });

  it("carriesNameFlag matches the three spellings and nothing else", () => {
    for (const tokens of [["--name"], ["--name=x"], ["-nx"]]) assert.equal(carriesNameFlag(tokens), true);
    for (const tokens of [["--names"], ["-"], ["--n"], []]) assert.equal(carriesNameFlag(tokens), false);
  });
});
