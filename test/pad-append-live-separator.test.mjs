import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { bumpPad, createPad, APPEND_WITH_SEPARATOR_SET } = await import("../dist/tools/pads.js");
migrate();

function makeProject(name) {
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, `/tmp/pad-append-live-sep-${name}`);
}

describe("pad_append's separator reads live content, not a stale read (fix round 1, P1)", () => {
  it("a second append still gets a newline separator even though its own caller never re-read content after the first append landed", () => {
    const project = makeProject("live-sep-1");

    const padId = createPad(project.id, "log", "alpha", []);

    bumpPad(padId, undefined, APPEND_WITH_SEPARATOR_SET, "B-entry");
    assert.equal(db.prepare("SELECT content FROM scratchpads WHERE id = ?").get(padId).content, "alpha\nB-entry");

    bumpPad(padId, undefined, APPEND_WITH_SEPARATOR_SET, "A-entry");
    const finalContent = db.prepare("SELECT content FROM scratchpads WHERE id = ?").get(padId).content;
    assert.equal(finalContent, "alpha\nB-entry\nA-entry", "each entry must land on its own line, never glued to the previous one");
  });

  it("does not add a spurious blank line when content already ends in a newline", () => {
    const project = makeProject("live-sep-2");
    const padId = createPad(project.id, "log", "alpha\n", []);
    bumpPad(padId, undefined, APPEND_WITH_SEPARATOR_SET, "next");
    assert.equal(db.prepare("SELECT content FROM scratchpads WHERE id = ?").get(padId).content, "alpha\nnext");
  });

  it("does not prepend a newline onto genuinely empty content", () => {
    const project = makeProject("live-sep-3");
    const padId = createPad(project.id, "log", "", []);
    bumpPad(padId, undefined, APPEND_WITH_SEPARATOR_SET, "first");
    assert.equal(db.prepare("SELECT content FROM scratchpads WHERE id = ?").get(padId).content, "first");
  });
});
