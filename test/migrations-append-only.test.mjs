import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, MIGRATIONS } = await import("../dist/db.js");

if (!db.name.startsWith(dirs.dataDir)) throw new Error(`refusing: opened ${db.name}`);

const SHIPPED = [
  "058eaea448eddef2",
  "7ed0b31d338ea8c2",
  "c35667c2b6abe307",
  "d7f4cb37a8ccb60f",
  "4a05c3293b29174d",
  "3521fa90564350ed",
  "ebb872594bc1f403",
  "b1f121172b1d1339",
  "2846964360921060",
  "440b4a9f8176237e",
  "4e6c394b30f36fc8",
  "8b6cf7f340529b40",
  "1df238b984548edc",
  "0284c3d4d0606818",
  "50e5be93a3d2d3c1",
  "6b9cf9d6c8505ab2",
  "49abc04fba4bd1b6",
  "b18c8c60eb7474bb",
  "5b96b49adb3fd0b5",
  "39e3959be296ad71",
  "59dbf515aadccca6",
  "ee66e0fd9a707569",
  "5e816341d8d1d0c7",
  "3b030bc90113fcf2",
  "028363e574d3fe0f",
  "519a4e0b8b74c43f",
  "ea699bd7e918fa09",
  "3f322d6af6c0147d",
  "75d757454f283cd5",
  "4021b40fbf022799",
  "12aeab09e1f36797",
];

const hash = (sql) => createHash("sha256").update(sql).digest("hex").slice(0, 16);

describe("MIGRATIONS is append-only", () => {
  it("keeps every shipped entry byte-identical at the version a store recorded it under", () => {
    const drifted = SHIPPED.flatMap((pinned, i) => {
      const actual = MIGRATIONS[i] === undefined ? "missing" : hash(MIGRATIONS[i]);
      return actual === pinned ? [] : [`v${i + 1}: pinned ${pinned}, now ${actual}`];
    });
    assert.deepEqual(
      drifted,
      [],
      "a shipped migration moved or changed. Stores record migrations by index, so a store that already " +
        "applied that version never re-runs it, and one that did not runs whatever now sits there. Put the " +
        "entry back and add your change as a NEW entry at the end. Never edit a hash in SHIPPED.",
    );
  });

  it("pins a hash for every entry, so a new migration lands here as one appended line", () => {
    assert.equal(
      MIGRATIONS.length,
      SHIPPED.length,
      `append to SHIPPED, in order: ${MIGRATIONS.slice(SHIPPED.length).map((s) => JSON.stringify(hash(s))).join(", ")}`,
    );
  });
});
