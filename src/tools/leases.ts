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
        const info = db
          .prepare(
            `INSERT INTO locks (project_id, lock_key, owner, expires_at)
             VALUES (?, ?, ?, datetime('now', printf('+%d seconds', ?)))
             ON CONFLICT(project_id, lock_key) DO NOTHING`,
          )
          .run(projectId, args.key, actor, args.ttl_seconds);
        const row = db
          .prepare("SELECT * FROM locks WHERE project_id = ? AND lock_key = ?")
          .get(projectId, args.key) as LeaseRow;
        if (info.changes > 0) {
          return { project_id: projectId, key: args.key, acquired: true, expires_at: row.expires_at };
        }
        if (row.owner === actor) {
          db.prepare(
            `UPDATE locks SET expires_at = datetime('now', printf('+%d seconds', ?))
             WHERE project_id = ? AND lock_key = ?`,
          ).run(args.ttl_seconds, projectId, args.key);
          return {
            project_id: projectId,
            key: args.key,
            acquired: true,
            extended: true,
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
