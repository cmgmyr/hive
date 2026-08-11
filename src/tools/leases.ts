import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { run } from "../result.js";
import { projectIdParam } from "./params.js";

interface LeaseRow {
  project_id: number;
  lock_key: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
}

function purgeExpired(projectId: number): void {
  db.prepare("DELETE FROM locks WHERE project_id = ? AND expires_at < datetime('now')").run(
    projectId,
  );
}

// The row a lease_acquire re-read always MIGHT not find: whatever made it
// worth re-reading (a failed insert, a lost extend race) is itself evidence
// something else is changing this row, and a release can remove it in the
// same window. Both call sites below used to cast one of these two reads
// `as LeaseRow` with no `| undefined` and dereference it unguarded (fix
// round 1, P2 - one of the two casts was already guarded, the other was
// not; this makes both go through the one function instead of disagreeing).
//
// Exported for test/lease-acquire-conflict-undefined.test.mjs: proves the
// guard directly rather than racing the couple of statements between a
// failed insert and this read - too narrow for two real processes to land
// in reliably, the same reasoning as extendOwnedLease's own test.
export function readLease(projectId: number, key: string): LeaseRow | undefined {
  return db.prepare("SELECT * FROM locks WHERE project_id = ? AND lock_key = ?").get(projectId, key) as
    | LeaseRow
    | undefined;
}

// AND owner = ?, not just project_id/lock_key: between the caller's own
// SELECT (below) and this UPDATE, another actor's lease_acquire can
// purgeExpired this exact row and insert itself as owner. Without the owner
// predicate this UPDATE would still match by key alone and extend THAT
// actor's lease while the caller believes it renewed its own - two actors
// then both hold evidence they own the same key, the one thing a lease
// exists to prevent. Returns false when that race happened (or the lease
// was released outright) instead of reporting a false success.
//
// Exported for test/lease-owner-race.test.mjs: the race window above is a
// couple of synchronous SQL statements wide, too narrow to hit reliably by
// racing two real MCP server processes (their IPC and scheduling jitter
// dwarfs it). The test calls this directly with the row's owner already
// changed out from under it, reconstructing what that race would leave
// behind instead of chasing it live.
export function extendOwnedLease(projectId: number, key: string, actor: string, ttlSeconds: number): boolean {
  const info = db
    .prepare(
      `UPDATE locks SET expires_at = datetime('now', printf('+%d seconds', ?))
       WHERE project_id = ? AND lock_key = ? AND owner = ?`,
    )
    .run(ttlSeconds, projectId, key, actor);
  return info.changes > 0;
}

// Update is NOT missing here: re-acquiring your own lease extends it in
// place below, so lease_acquire fills both the Create and Update cells the
// way kv_set does for kv. The first pass of #82's matrix left that cell an
// unqualified "none", which read as unclassified; the PR gate caught it.
//
// No lease_read or lease_list (issue #82). A failed acquire below already
// answers "who holds this, until when" through held_by and expires_at, with
// no side effect when the lease is actually contended. It only stops being a
// clean read when the lease is free: acquiring one to check it claims it.
// That gap (a side-effect-free peek, or a project-wide list of every held
// lease) is accepted rather than filed. It has not bitten anyone yet, and a
// caller who wants to check before dispatching a worker into a contended
// area can already do so for the one case that matters: the lease is held.
export function registerLeases(server: McpServer): void {
  server.registerTool(
    "lease_acquire",
    {
      description:
        "Try to take a named lease on a shared work area (non-blocking). Re-taking your own lease extends it. Leases expire on their own.",
      inputSchema: {
        key: z.string().describe('Stable and specific, like "file:src/api/routes.ts".'),
        ttl_seconds: z.number().int().positive(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        purgeExpired(projectId);
        const actor = currentActor();
        // RETURNING, not a separate SELECT afterward: fix round 1, both
        // counselor seats. A inserts a one-second lease and stalls before a
        // follow-up SELECT could run; the lease expires, B purges it and
        // inserts its own, and A's SELECT - reached only after the stall -
        // reads B's row instead of the one A itself just created. A then
        // reports B's future expiry as evidence of its OWN acquisition.
        // RETURNING makes the receipt come from the exact row this
        // statement inserted, with no later read that could observe a
        // replacement. DO NOTHING's conflict branch returns no row, so
        // `.get()` returning undefined already tells us whether we won -
        // no separate changes count needed.
        const inserted = db
          .prepare(
            `INSERT INTO locks (project_id, lock_key, owner, expires_at)
             VALUES (?, ?, ?, datetime('now', printf('+%d seconds', ?)))
             ON CONFLICT(project_id, lock_key) DO NOTHING
             RETURNING expires_at`,
          )
          .get(projectId, args.key, actor, args.ttl_seconds) as { expires_at: string } | undefined;
        if (inserted) {
          return { project_id: projectId, key: args.key, acquired: true, expires_at: inserted.expires_at };
        }
        // We lost the INSERT (some row already existed a moment ago), but a
        // concurrent lease_release can remove that exact row before this
        // read runs.
        const row = readLease(projectId, args.key);
        if (!row) {
          // Released between our failed insert and this read - nothing to
          // report as held; the caller can just retry lease_acquire.
          return { project_id: projectId, key: args.key, acquired: false };
        }
        if (row.owner === actor) {
          if (extendOwnedLease(projectId, args.key, actor, args.ttl_seconds)) {
            return { project_id: projectId, key: args.key, acquired: true, extended: true };
          }
          // Lost the race: `row` is now stale, since another actor's own
          // lease_acquire purged and took it between our read above and the
          // extend attempt just now. Re-read for who actually holds it.
          const current = readLease(projectId, args.key);
          if (!current) {
            return { project_id: projectId, key: args.key, acquired: false };
          }
          return {
            project_id: projectId,
            key: args.key,
            acquired: false,
            held_by: current.owner,
            expires_at: current.expires_at,
          };
        }
        return {
          project_id: projectId,
          key: args.key,
          acquired: false,
          held_by: row.owner,
          expires_at: row.expires_at,
        };
      }),
  );

  server.registerTool(
    "lease_release",
    {
      description: "Release a lease you own.",
      inputSchema: { key: z.string(), project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const info = db
          .prepare("DELETE FROM locks WHERE project_id = ? AND lock_key = ? AND owner = ?")
          .run(projectId, args.key, currentActor());
        return { project_id: projectId, key: args.key, released: info.changes > 0 };
      }),
  );
}
