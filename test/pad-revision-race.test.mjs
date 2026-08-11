import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scratchDirs } from "./helpers.mjs";

// Issue #148 / todo 345. bumpPad's UPDATE used to be `WHERE id = ?` with no
// revision predicate: two sessions that both read revision N before either
// wrote both pass checkRevision's JS-level pre-check (it compares against
// its OWN fresh read, not against the other session), then both UPDATE. The
// second write silently overwrites the first's content, and BOTH receipts
// report success with a revision computed from each session's own stale
// read - the actual current revision after both writes disagrees with what
// either caller was told.
//
// The interleaving that triggers this is checkRevision's SELECT racing
// against another session's UPDATE - a couple of synchronous SQL statements
// wide, sub-microsecond. Racing two real MCP server PROCESSES for this
// (spawn, IPC round trip, JSON parsing) introduces jitter many orders of
// magnitude larger than the window itself, so a process race here would
// pass or fail on luck, not prove anything either way. Per the lead's
// standing preference on todo 345, this test instead asserts the
// conditional write's WHERE clause directly: it calls getPadMeta and
// bumpPad exactly as two raced sessions would, with the state that a real
// interleaving would produce constructed on purpose instead of chased.
//
// PROVEN RED against the pre-fix bumpPad (WHERE id = ? only, no RETURNING):
// the first assert.throws below failed because session B's write silently
// succeeded, and the trailing content assertion failed because B's content
// had overwritten A's. Output pasted in the PR body.

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

    // Both sessions read while the pad is still at revision 1 - the state
    // that exists right up until either writer's UPDATE commits.
    const readByA = getPadMeta(project.id, padId);
    const readByB = getPadMeta(project.id, padId);
    assert.equal(readByA.revision, 1);
    assert.equal(readByB.revision, 1);

    // Session A's write lands first.
    const revisionAfterA = bumpPad(padId, readByA.revision, "content = ?", "from A");
    assert.equal(revisionAfterA, 2);

    // Session B's write is built from ITS OWN read, taken before A wrote -
    // exactly the interleaving above. It must now be rejected rather than
    // silently overwriting A's write.
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

  // Fix round 1, counselors: this test's original form (two bare
  // unconditional bumps in a row, asserting the second returns 3) cannot
  // discriminate what its own name claimed. Two sequential calls in one
  // process never construct a "stale" number at all - nothing here ever
  // reads a revision and holds onto it while something else changes the
  // row, so "stale+1" and "the true value" are the same number by
  // construction and would agree even if bumpPad's RETURNING were reverted
  // to some other computation entirely. Renamed to what it actually shows
  // (ordinary sequential correctness), kept because it is still real
  // coverage of the RETURNING path, and paired below with a version that
  // actually discriminates.
  it("two unconditional bumps in a row report sequential revisions (ordinary correctness, not a staleness test)", () => {
    const project = makeProject(dirs.tmp, "pad-race-3");
    const padId = createPad(project.id, "plan", "start", []);

    // Two unconditional bumps in a row, as pad_append with no
    // expected_revision would issue.
    bumpPad(padId, undefined, "content = ?", "x");
    const revision = bumpPad(padId, undefined, "content = ?", "y");
    assert.equal(revision, 3);
  });

  it("reports the true post-write revision even when it disagrees with a revision read before an intervening write (discriminates stale+1 from RETURNING)", () => {
    const project = makeProject(dirs.tmp, "pad-race-4");
    const padId = createPad(project.id, "plan", "start", []);

    // "Stale" knowledge, captured early - what a caller relying on an
    // earlier read (or a bumpPad implementation that computed its return
    // value as thisRevision + 1 instead of reading RETURNING) would believe
    // the revision to be for the call under test below.
    const staleRevision = getPadMeta(project.id, padId).revision;
    assert.equal(staleRevision, 1);

    // An intervening write neither the caller nor staleRevision above has
    // any knowledge of. True revision is now 2.
    bumpPad(padId, undefined, "content = ?", "an intervening write nobody here read back");

    // The call under test. staleRevision + 1 (2) and the row's true
    // post-write revision (3) are now DIFFERENT numbers, which is exactly
    // what the original version of this test never constructed - two
    // sequential calls with nothing else running between them can never
    // produce a disagreement to catch.
    const revision = bumpPad(padId, undefined, "content = ?", "the write under test");
    assert.equal(revision, 3, "must be the row's true post-write revision, read back via RETURNING");
    assert.notEqual(
      revision,
      staleRevision + 1,
      "if this holds, the intervening write above stopped actually intervening and the test no longer discriminates",
    );
  });
});
