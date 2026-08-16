import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { getPadMeta, bumpPad, createPad } = await import("../dist/tools/pads.js");
migrate();

function makeProject(tmp, name) {
  const dir = mkdtempSync(join(tmp, `${name}-`));
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, dir);
}

describe("pad revision race (todo 345 / issue #148)", () => {
  it("a write built from a stale read is rejected once another write has landed, not silently lost", () => {
    const project = makeProject(dirs.tmp, "pad-race-1");
    const padId = createPad(project.id, "plan", "start", []);

    const readByA = getPadMeta(project.id, padId);
    const readByB = getPadMeta(project.id, padId);
    assert.equal(readByA.revision, 1);
    assert.equal(readByB.revision, 1);

    const revisionAfterA = bumpPad(padId, readByA.revision, "content = ?", "from A");
    assert.equal(revisionAfterA, 2);

    assert.throws(
      () => bumpPad(padId, readByB.revision, "content = ?", "from B"),
      /Revision mismatch for pad \d+: expected 1, current 2/,
    );

    const row = db.prepare("SELECT content, revision FROM scratchpads WHERE id = ?").get(padId);
    assert.equal(row.content, "from A", "A's write must survive; B's must not have silently applied");
    assert.equal(row.revision, 2);
  });

  it("a delete built from a stale read is rejected the same way, not silently applied", () => {
    const project = makeProject(dirs.tmp, "pad-race-2");
    const padId = createPad(project.id, "plan", "start", []);

    const readByA = getPadMeta(project.id, padId);
    const readByB = getPadMeta(project.id, padId);

    bumpPad(padId, readByA.revision, "content = ?", "from A");

    const info = db.prepare("DELETE FROM scratchpads WHERE id = ? AND revision = ?").run(padId, readByB.revision);
    assert.equal(info.changes, 0, "B's delete must not remove a row it never actually saw current");

    const row = db.prepare("SELECT content FROM scratchpads WHERE id = ?").get(padId);
    assert.equal(row.content, "from A", "the pad must still exist with A's content");
  });

  it("two unconditional bumps in a row report sequential revisions (ordinary correctness, not a staleness test)", () => {
    const project = makeProject(dirs.tmp, "pad-race-3");
    const padId = createPad(project.id, "plan", "start", []);

    bumpPad(padId, undefined, "content = ?", "x");
    const revision = bumpPad(padId, undefined, "content = ?", "y");
    assert.equal(revision, 3);
  });

  it("reports the true post-write revision even when it disagrees with a revision read before an intervening write (discriminates stale+1 from RETURNING)", () => {
    const project = makeProject(dirs.tmp, "pad-race-4");
    const padId = createPad(project.id, "plan", "start", []);

    const staleRevision = getPadMeta(project.id, padId).revision;
    assert.equal(staleRevision, 1);

    bumpPad(padId, undefined, "content = ?", "an intervening write nobody here read back");

    const revision = bumpPad(padId, undefined, "content = ?", "the write under test");
    assert.equal(revision, 3, "must be the row's true post-write revision, read back via RETURNING");
    assert.notEqual(
      revision,
      staleRevision + 1,
      "if this holds, the intervening write above stopped actually intervening and the test no longer discriminates",
    );
  });
});
