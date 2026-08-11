import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DIST, raceProcesses, scratchDirs } from "./helpers.mjs";

// Issue #148 / todo 345. addProject used to be SELECT-then-INSERT: two
// sessions resolving the same unseen checkout at once could both find
// nothing, then both INSERT, and the loser hit projects.path's UNIQUE
// constraint and threw even though the project now exists, correctly, under
// the winner's row.
//
// Unlike the pad and lease races, this window is NOT sub-microsecond. The
// SELECT that used to decide "nothing here yet" ran near the top of the old
// function, well before any competing process could have committed its own
// INSERT, so real concurrent processes land inside it reliably rather than
// by luck. This test races real processes instead of asserting the SQL
// directly, matching this suite's own precedent
// (test/attach-view-race.test.mjs) for a race wide enough to actually hit.
//
// PROVEN RED against the pre-fix SELECT-then-INSERT: at least one of six
// racing processes threw a UNIQUE constraint error instead of returning a
// project. Output pasted in the PR body.

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();

describe("project registration race (todo 345 / issue #148)", () => {
  it("racing sessions registering the same unseen checkout all succeed and converge on one row", async () => {
    const script = `
import { addProject } from ${JSON.stringify(join(DIST, "context.js"))};
const [path] = process.argv.slice(2);
const project = addProject(path);
console.log(JSON.stringify({ id: project.id, path: project.path }));
`;
    const raceCount = 6;
    const results = await raceProcesses(
      script,
      Array.from({ length: raceCount }, () => [dirs.projectDir]),
      { env: { HIVE_DATA_DIR: dirs.dataDir } },
    );

    const ids = new Set(results.map((r) => r.id));
    assert.equal(
      ids.size,
      1,
      `all ${raceCount} racing registrations must converge on one project row, got ids: ${JSON.stringify([...ids])}`,
    );

    const count = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE path = ?").get(dirs.projectDir);
    assert.equal(count.n, 1, "exactly one row must exist for the path afterward");
  });
});
