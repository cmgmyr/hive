import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
const { dataDir } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { withWindowClaim } = await import("../dist/spawn.js");
migrate();

describe("withWindowClaim refuses to nest inside an outer transaction", () => {
  it("throws when called from inside an already-open transaction, instead of silently riding along as a no-op savepoint", () => {
    assert.throws(
      () => {
        db.transaction(() => {
          withWindowClaim(() => "claimed");
        })();
      },
      /withWindowClaim/,
      "a nested call must be refused, not absorbed as a savepoint with no writer slot of its own",
    );
  });

  it("names the hazard (savepoint nesting, lost exclusion) and the remedy (move the transaction out, or the work in)", () => {
    assert.throws(
      () => {
        db.transaction(() => {
          withWindowClaim(() => "claimed");
        })();
      },
      (err) => {
        assert.match(err.message, /SAVEPOINT|savepoint/, "must name the mechanism that would otherwise hide this");
        assert.match(err.message, /exclusion/, "must say what is lost, not just that something is refused");
        assert.match(
          err.message,
          /outermost|move/i,
          "must tell the caller what to do instead, not just that it is wrong",
        );
        return true;
      },
    );
  });

  it("does not fire on the ordinary path: no outer transaction at all", () => {
    const result = withWindowClaim(() => "claimed");
    assert.equal(result, "claimed");
    assert.equal(db.inTransaction, false, "the claim's own transaction must have committed and released the lock");
  });

  it("refuses before db.transaction is ever entered, so the outer transaction rolls back clean instead of unwinding a savepoint", () => {

    db.prepare("CREATE TABLE IF NOT EXISTS guard_probe (n INTEGER)").run();
    assert.throws(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO guard_probe (n) VALUES (1)").run();
        withWindowClaim(() => "claimed");
      })();
    });

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM guard_probe").get().n, 0);
  });
});
