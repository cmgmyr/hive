import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DIST, raceProcesses, scratchDirs } from "./helpers.mjs";

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
