import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { loadProjectYml } = await import("../dist/projectYml.js");

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-review-tags-deprecation-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

describe("hive.yml review_tags deprecation", () => {
  it("warns once for review_tags while loading every other config key normally", () => {
    const dir = ymlProject("review_tags: [from-review]\nlead: codex\n");
    const { config, warnings } = loadProjectYml(dir);

    assert.equal(config.lead, "codex");
    assert.equal(Object.hasOwn(config, "review_tags"), false);
    assert.deepEqual(warnings, [`${join(dir, "hive.yml")}: review_tags is no longer used by hive; remove it from hive.yml.`]);
  });
});
