import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
const { dataDir, projectDir, tmp } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { janitor } = await import("../dist/scheduler.js");
const { codexHomeDir } = await import("../dist/codexHome.js");
migrate();

const project = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("p", projectDir).id;

const EMPTY = { panes: new Set(), windows: new Set(), serverAnswered: true };

function seedHome(key) {
  mkdirSync(codexHomeDir(key), { recursive: true });
  writeFileSync(join(codexHomeDir(key), "marker"), "x");
}

function seedAgent(name, { status, parkedAt = "", codexHome }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind,
          parked_at, codex_home, closed_at)
       VALUES (?, ?, ?, '', '', 'codex', ?, ?, 'agent', ?, ?, datetime('now'))
       RETURNING id`,
    )
    .get(project, `agent:${name}`, name, join(tmp, `wt-${name}`), status, parkedAt, codexHome).id;
}

describe("janitor's codex-home backstop reaps a closed, non-parked home", () => {
  it("removes the directory and clears the row's codex_home", () => {
    const key = "closed-key-1";
    seedHome(key);
    const id = seedAgent("closed-1", { status: "closed", codexHome: key });

    const result = janitor(EMPTY);

    assert.equal(result.reaped_codex_homes, 1);
    assert.equal(existsSync(codexHomeDir(key)), false, "the home must be gone");
    assert.equal(
      db.prepare("SELECT codex_home FROM agents WHERE id = ?").get(id).codex_home,
      "",
      "the row's codex_home must be cleared so a repeat sweep does not re-attempt an already-gone directory",
    );
  });

  it("a second sweep finds nothing left to reap, which is the backstop working as a backstop", () => {
    assert.equal(janitor(EMPTY).reaped_codex_homes, 0);
  });
});

describe("janitor never reaps a PARKED codex-home, even though its row is status='closed' too", () => {
  it("leaves the directory and the row's codex_home alone", () => {
    const key = "parked-key-1";
    seedHome(key);
    const id = seedAgent("parked-1", { status: "closed", parkedAt: "2026-08-23 00:00:00", codexHome: key });

    const result = janitor(EMPTY);

    assert.equal(result.reaped_codex_homes, 0);
    assert.equal(
      existsSync(codexHomeDir(key)),
      true,
      "a parked worker's home must survive - agent_park expects to resume it, cold-cache and all",
    );
    assert.equal(db.prepare("SELECT codex_home FROM agents WHERE id = ?").get(id).codex_home, key);
  });
});

describe("janitor never reaps a RUNNING codex-home", () => {
  it("leaves it alone", () => {
    const key = "running-key-1";
    seedHome(key);
    seedAgent("running-1", { status: "running", codexHome: key });

    const result = janitor(EMPTY);

    assert.equal(result.reaped_codex_homes, 0);
    assert.equal(existsSync(codexHomeDir(key)), true);
  });
});
