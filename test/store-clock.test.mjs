import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs } from "./helpers.mjs";

import { parseStoreTimestamp } from "../dist/storeClock.js";

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { cleanup } = isolateTmux("store clock consumer tests");
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
migrate();
const { formatLocal } = await import("../dist/dashboard.js");
const { ageSecondsSince } = await import("../dist/stateProvenance.js");
const { teardownWindow } = await import("../dist/teardown.js");
const { parseStaleHiveServers } = await import("../dist/staleServers.js");
const { addProject } = await import("../dist/context.js");
const { collectCrew } = await import("../dist/crew.js");
const { assertWakeFiredAfterLastCompletion } = await import("../scripts/part-c-assert.mjs");
const project = addProject(dirs.projectDir, "store-clock-test");

after(() => cleanup());

test("store clock preserves whole and fractional UTC instants", () => {
  assert.equal(parseStoreTimestamp("2026-10-19 12:34:56"), Date.parse("2026-10-19T12:34:56.000Z"));
  assert.equal(parseStoreTimestamp("2026-10-19 12:34:56.123"), Date.parse("2026-10-19T12:34:56.123Z"));
  assert.equal(parseStoreTimestamp("2026-10-19T12:34:56.789"), Date.parse("2026-10-19T12:34:56.789Z"));
});

test("store clock honors existing Z and numeric offsets", () => {
  const utc = Date.parse("2026-10-19T12:34:56.123Z");
  assert.equal(parseStoreTimestamp("2026-10-19 12:34:56.123Z"), utc);
  assert.equal(parseStoreTimestamp("2026-10-19T14:34:56.123+02:00"), utc);
  assert.equal(parseStoreTimestamp("2026-10-19T14:34:56.123+0200"), utc);
});

test("store clock returns NaN for invalid input", () => {
  assert.ok(Number.isNaN(parseStoreTimestamp("")));
  assert.ok(Number.isNaN(parseStoreTimestamp("bad")));
});

test("migration clock rejects fractional and zoned applied_at", () => {
  const appliedAtValues = [
    "2026-10-19 12:34:56.123",
    "2026-10-19 12:34:56Z",
    "2026-10-19 12:34:56+02:00",
  ];
  for (const appliedAt of appliedAtValues) {
    assert.deepEqual(
      parseStaleHiveServers("", appliedAt),
      { skipped: "the newest migration time is unavailable or invalid" },
      appliedAt,
    );
  }
  assert.deepEqual(parseStaleHiveServers("", "2026-10-19 12:34:56"), { servers: [] });
});

test("store clock stays UTC in subprocesses under both supported local timezones", () => {
  const helperUrl = new URL("../dist/storeClock.js", import.meta.url).href;
  for (const TZ of ["UTC", "America/New_York"]) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "import { parseStoreTimestamp } from " + JSON.stringify(helperUrl) + "; console.log(parseStoreTimestamp(\"2026-10-19 12:34:56.123\"));"],
      { encoding: "utf8", env: { ...process.env, TZ } },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), String(Date.parse("2026-10-19T12:34:56.123Z")), TZ);
  }
});

test("clock consumers honor offsets and keep their own output policies", () => {
  process.env.TZ = "America/New_York";
  assert.equal(formatLocal("2026-10-19T14:34:56+02:00"), "2026-10-19 08:34:56");
  assert.equal(formatLocal("not-a-time"), "not-a-time");
  assert.equal(ageSecondsSince("2026-10-19 12:34:56.123", Date.parse("2026-10-19T12:34:58.123Z")), 2);
  assert.ok(Number.isNaN(ageSecondsSince("bad", Date.parse("2026-10-19T12:34:58.123Z"))));
  assert.equal(
    teardownWindow("2026-10-19 12:34:56.123", "2026-10-19 12:34:56.623", "observed").width_seconds,
    0.5,
  );

  db.prepare(
    "INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, max_wait_at) VALUES (?, 'lead:test', 'clock', 'idle_any', 'project', 'lead:test', '%1', ?)",
  ).run(project.id, "2026-10-19T14:34:56+02:00");
  const crew = collectCrew(project, new Date("2026-10-19T12:34:56.000Z"));
  assert.equal(crew.wakes.watching[0].max_wait_at, "2026-10-19T12:34:56.000Z");

  assert.throws(
    () =>
      assertWakeFiredAfterLastCompletion({
        samples: [{
          completions: [1, 2, 3].map((epochSeconds) => ({ done: true, epochSeconds })),
          firedAt: "bad",
        }],
      }),
    /malformed timestamp "bad"/,
  );
});
