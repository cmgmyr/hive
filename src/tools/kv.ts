import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { run } from "../result.js";
import { projectIdParam } from "./params.js";

function purgeExpired(projectId: number): void {
  db.prepare(
    "DELETE FROM kv WHERE project_id = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')",
  ).run(projectId);
}

export function registerKv(server: McpServer): void {
  server.registerTool(
    "kv_set",
    {
      description:
        "Set a small shared JSON value other sessions can discover. Optional TTL in seconds.",
      inputSchema: {
        key: z.string(),
        // The only z.any() in the codebase, and DO NOT make it .optional().
        // Issue #105 lane C: under zod 3 this emitted required: ["key"] while
        // z.any() also accepted a missing `value` at runtime, so a kv_set with
        // no value at all SUCCEEDED and stored the key with JSON null in it -
        // measured, not inferred. zod 4 treats a bare z.any() in a required
        // position as nonoptional and refuses that call (-32602, "expected
        // nonoptional, received undefined at value"), and emits
        // required: ["key", "value"] to match.
        //
        // THIS IS A BREAKING INPUT-CONTRACT CORRECTION, not free compatibility,
        // and it is worth keeping anyway. An external caller written against
        // the zod 3 schema could send {"key": "maintenance"} and now gets a
        // -32602. `value: null` expresses the same intent and still succeeds,
        // but that is a caller migration, not an automatic upgrade path. What
        // makes the trade right is that the only call newly refused is the one
        // that was storing nothing under a key that then read back as a real
        // JSON null.
        value: z.any().describe("Any JSON value."),
        ttl_seconds: z.number().int().positive().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        purgeExpired(projectId);
        const actor = currentActor();
        db.prepare(
          `INSERT INTO kv (project_id, key, value, updated_by, expires_at)
           VALUES (?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', printf('+%d seconds', ?)) END)
           ON CONFLICT(project_id, key) DO UPDATE SET
             value = excluded.value,
             updated_by = excluded.updated_by,
             updated_at = datetime('now'),
             expires_at = excluded.expires_at`,
        ).run(
          projectId,
          args.key,
          JSON.stringify(args.value ?? null),
          actor,
          args.ttl_seconds ?? null,
          args.ttl_seconds ?? null,
        );
        return { project_id: projectId, key: args.key };
      }),
  );

  server.registerTool(
    "kv_get",
    {
      description: "Get a shared JSON value by key.",
      inputSchema: { key: z.string(), project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        purgeExpired(projectId);
        const row = db
          .prepare("SELECT * FROM kv WHERE project_id = ? AND key = ?")
          .get(projectId, args.key) as
          | { key: string; value: string; updated_by: string; updated_at: string; expires_at: string | null }
          | undefined;
        if (!row) return { project_id: projectId, key: args.key, found: false };
        return {
          project_id: projectId,
          key: row.key,
          found: true,
          value: JSON.parse(row.value),
          updated_by: row.updated_by,
          updated_at: row.updated_at,
          expires_at: row.expires_at,
        };
      }),
  );

  server.registerTool(
    "kv_list",
    {
      description: "List shared values, optionally filtered by key prefix.",
      inputSchema: { prefix: z.string().optional(), project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        purgeExpired(projectId);
        let sql = "SELECT * FROM kv WHERE project_id = ?";
        const params: unknown[] = [projectId];
        if (args.prefix) {
          sql += " AND key LIKE ?";
          params.push(`${args.prefix}%`);
        }
        sql += " ORDER BY key";
        const rows = db.prepare(sql).all(...params) as {
          key: string;
          value: string;
          updated_by: string;
          updated_at: string;
          expires_at: string | null;
        }[];
        return {
          project_id: projectId,
          entries: rows.map((r) => ({
            key: r.key,
            value: JSON.parse(r.value),
            updated_by: r.updated_by,
            updated_at: r.updated_at,
            expires_at: r.expires_at,
          })),
        };
      }),
  );

  server.registerTool(
    "kv_delete",
    {
      description: "Delete a shared value by key.",
      inputSchema: { key: z.string(), project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const info = db
          .prepare("DELETE FROM kv WHERE project_id = ? AND key = ?")
          .run(projectId, args.key);
        return { project_id: projectId, key: args.key, deleted: info.changes > 0 };
      }),
  );
}
