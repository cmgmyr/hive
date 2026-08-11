import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

// Fix round 1 on todo 345 / issue #148, P1: both counselor seats
// independently found that pad_append's separator was decided in JS from
// `pad.content` AS READ (a `joined` variable), not from the live column -
// so while the append's own concatenation was safe against a concurrent
// change, the SEPARATOR was not. Two sessions both reading content that
// ends in a newline both decide joined = "", and whichever writes second
// glues its entry onto the first's with none: content "alpha\n", A reads
// it, B appends "B-entry" first (content now "alpha\nB-entry", no trailing
// newline), then A's write runs with its own already-decided joined = "",
// producing "alpha\nB-entryA-entry".
//
// The fix (APPEND_WITH_SEPARATOR_SET, src/tools/pads.ts) moves the decision
// into the same UPDATE statement as a CASE over the live `content` column,
// so there is no read-then-decide step left to go stale - matching the
// property pad_append's own concatenation already had. That means there is
// no race window left to reconstruct the way the revision and lease races
// were: nothing in JS reads content before this statement runs at all, so
// the test below proves the property directly - the separator always
// reflects whatever content the row ACTUALLY holds at write time, never
// what an earlier read believed - rather than raced or interleaved.
//
// PROVEN RED against the pre-fix `joined`-in-JS shape: a throwaway repro
// reproducing the exact scenario above (readByA taken once, B's append
// landing before A's, A's write using its stale separator) produced
// "alpha\nB-entryA-entry" - B's and A's entries glued with no separator.
// Output pasted in the PR body.

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
    // Starts with no trailing newline, matching pad_append's own JSDoc
    // scenario in reverse (missing separator becomes a spurious blank line
    // the other direction) - this direction is the glued-entries case.
    const padId = createPad(project.id, "log", "alpha", []);

    // B's append: content "alpha" has no trailing newline, so this adds one.
    bumpPad(padId, undefined, APPEND_WITH_SEPARATOR_SET, "B-entry");
    assert.equal(db.prepare("SELECT content FROM scratchpads WHERE id = ?").get(padId).content, "alpha\nB-entry");

    // A's append never reads content at all - there is nothing in JS left to
    // go stale. The CASE in the same statement sees content as it actually
    // is right now ("alpha\nB-entry", no trailing newline) and separates
    // correctly regardless of what content looked like at any earlier point.
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
