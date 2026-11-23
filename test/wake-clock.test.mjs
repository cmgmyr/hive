import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { InvalidClockRuleError, nextClockDue } from "../dist/wakeClock.js";

const epoch = (value) => Date.parse(value);

test("clock schedules choose today, tomorrow, exact-minute and midnight occurrences", () => {
  assert.equal(nextClockDue("19:00", "UTC", epoch("2026-11-14T18:59:00Z")), "2026-11-14 19:00:00");
  assert.equal(nextClockDue("19:00", "UTC", epoch("2026-11-14T19:00:00Z")), "2026-11-15 19:00:00");
  assert.equal(nextClockDue("19:00", "UTC", epoch("2026-11-14T19:00:00.999Z")), "2026-11-15 19:00:00");
  assert.equal(nextClockDue("00:00", "UTC", epoch("2026-11-14T23:59:30Z")), "2026-11-15 00:00:00");
});

test("daily clock schedules keep their local time across both New York DST transitions", () => {
  assert.equal(nextClockDue("19:00", "America/New_York", epoch("2026-10-31T23:00:00Z")), "2026-11-02 00:00:00");
  assert.equal(nextClockDue("19:00", "America/New_York", epoch("2027-03-14T00:00:00Z")), "2027-03-14 23:00:00");
});

test("clock schedules skip a spring gap and use only the first fall-fold occurrence", () => {
  assert.equal(nextClockDue("02:30", "America/New_York", epoch("2027-03-14T00:00:00Z")), "2027-03-15 06:30:00");
  assert.equal(nextClockDue("01:30", "America/New_York", epoch("2026-10-31T23:00:00Z")), "2026-11-01 05:30:00");
  assert.equal(nextClockDue("01:30", "America/New_York", epoch("2026-11-01T05:45:00Z")), "2026-11-02 06:30:00");
});

test("clock schedule validation rejects malformed times, zones and instants by name", () => {
  for (const [at, zone, afterMs] of [
    ["9:00", "UTC", epoch("2026-11-14T18:59:00Z")],
    ["24:00", "UTC", epoch("2026-11-14T18:59:00Z")],
    ["19:60", "UTC", epoch("2026-11-14T18:59:00Z")],
    ["19:00", "Not/AZone", epoch("2026-11-14T18:59:00Z")],
    ["19:00", "UTC", Number.NaN],
  ]) {
    assert.throws(() => nextClockDue(at, zone, afterMs), InvalidClockRuleError);
  }
});

test("clock schedules use the supplied zone when the process TZ differs", () => {
  const moduleUrl = new URL("../dist/wakeClock.js", import.meta.url).href;
  for (const TZ of ["UTC", "America/Los_Angeles"]) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `import { nextClockDue } from ${JSON.stringify(moduleUrl)}; console.log(nextClockDue("19:00", "America/New_York", Date.parse("2026-10-31T23:00:00Z")));`],
      { encoding: "utf8", env: { ...process.env, TZ } },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "2026-11-02 00:00:00", TZ);
  }
});
