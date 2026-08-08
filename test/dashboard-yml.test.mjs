import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadProjectYml } from "../dist/projectYml.js";

// Chris's scope change, superseding plan-dashboard-v1's original
// directory-presence switch: hive.yml's `dashboard` key is now the enable
// gate for the dashboard lane (todos 308/309). Pure filesystem parsing, no
// tmux and no store, so this file needs neither isolateTmux nor
// HIVE_DATA_DIR the way test/layout.test.mjs (its structural sibling) does.

function ymlProject(body) {
  const dir = mkdtempSync(join(tmpdir(), "hive-yml-dashboard-"));
  writeFileSync(join(dir, "hive.yml"), body);
  return dir;
}

describe("hive.yml dashboard key", () => {
  it("defaults to false when the key is absent", () => {
    const { config, warnings } = loadProjectYml(ymlProject("placement: split\n"));
    assert.equal(config.dashboard, false);
    assert.deepEqual(warnings, []);
  });

  it("resolves an explicit null to false, not to a truthy default", () => {
    // Called out by name in the scope change: null must not reach a truthy
    // path. YAML's bare `dashboard:` (no value) parses to null, not to the
    // key being absent, so this is a genuinely different case from the one
    // above and needs its own assertion.
    const { config, warnings } = loadProjectYml(ymlProject("dashboard:\n"));
    assert.equal(config.dashboard, false);
    assert.deepEqual(warnings, []);
  });

  it("resolves an explicit false to false", () => {
    const { config, warnings } = loadProjectYml(ymlProject("dashboard: false\n"));
    assert.equal(config.dashboard, false);
    assert.deepEqual(warnings, []);
  });

  it("resolves an explicit true to true", () => {
    const { config, warnings } = loadProjectYml(ymlProject("dashboard: true\n"));
    assert.equal(config.dashboard, true);
    assert.deepEqual(warnings, []);
  });

  it("warns AND falls back to false on a malformed value - not just false on its own", () => {
    // A test that only checked the boolean would still pass if the warning
    // silently disappeared - the scope change calls this out by name.
    const { config, warnings } = loadProjectYml(ymlProject("dashboard: yesplease\n"));
    assert.equal(config.dashboard, false, "a malformed value must still fall back to disabled");
    assert.equal(warnings.length, 1, "a malformed value must produce exactly one warning");
    assert.match(warnings[0], /dashboard must be true or false/);
  });

  it("warns on a mapping value the same way", () => {
    const { config, warnings } = loadProjectYml(ymlProject("dashboard:\n  nested: true\n"));
    assert.equal(config.dashboard, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dashboard must be true or false/);
  });
});
