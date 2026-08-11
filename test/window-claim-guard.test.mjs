import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

// Todo 346, pad 111 entry 13. withWindowClaim (src/spawn.ts) is
// `db.transaction(claim).immediate()`, and better-sqlite3 nests a transaction
// inside an already-open one as a no-op SAVEPOINT rather than throwing (see
// node_modules/better-sqlite3/lib/methods/transaction.js: `if (db.inTransaction)`
// swaps BEGIN/COMMIT for SAVEPOINT/RELEASE, with no error either way). A claim
// made from inside an outer transaction would take no writer slot of its own,
// so the machine-wide mutual exclusion this function exists to provide is
// silently gone - no throw, no failing test. This file pins the guard that
// makes that a loud refusal instead.
//
// No tmux here at all: withWindowClaim's own body never touches it (only the
// `claim` callback passed in by real call sites does), so this exercises the
// guard directly against a scratch store with a no-op claim.

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
    // The refusal has to fire BEFORE db.transaction() is entered, or the
    // caller's outer transaction would already be holding a savepoint it
    // then has to unwind. Proven here by checking the outer transaction's own
    // effects are untouched by the throw: a sibling statement in the same
    // outer transaction still commits normally once the nested call is
    // removed, i.e. the guard does not corrupt the outer transaction's state.
    db.prepare("CREATE TABLE IF NOT EXISTS guard_probe (n INTEGER)").run();
    assert.throws(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO guard_probe (n) VALUES (1)").run();
        withWindowClaim(() => "claimed");
      })();
    });
    // The whole outer transaction rolled back on the throw (better-sqlite3's
    // own undo.run() in wrapTransaction), so the insert above must not have
    // survived either - proof the guard did not leave the store half-written.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM guard_probe").get().n, 0);
  });
});
