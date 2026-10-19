import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { extendOwnedLease, insertLease, purgeExpiredLeases, readLease, releaseOwnedLease } from "../leaseStore.js";
import { run } from "../result.js";
import { idParam, projectIdParam } from "./params.js";

export function registerLeases(server: McpServer): void {
  server.registerTool(
    "lease_acquire",
    {
      description:
        "Try to take a named lease on state another session could also change, such as a shared checkout, a dev database or a port (non-blocking). Re-taking your own lease extends it. Leases expire on their own.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        key: z.string().describe('Stable and specific, like "db:dev".'),
        ttl_seconds: z.number().int().positive(),
        project_id: projectIdParam,
      },
      outputSchema: {
        project_id: idParam,
        key: z.string(),
        acquired: z.boolean(),
        expires_at: z.string().optional(),
        extended: z.boolean().optional(),
        held_by: z.string().optional(),
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        purgeExpiredLeases(projectId);
        const actor = currentActor();

        const inserted = insertLease(projectId, args.key, actor, args.ttl_seconds);
        if (inserted) {
          return { project_id: projectId, key: args.key, acquired: true, expires_at: inserted.expires_at };
        }

        const row = readLease(projectId, args.key);
        if (!row) {

          return { project_id: projectId, key: args.key, acquired: false };
        }
        if (row.owner === actor) {
          if (extendOwnedLease(projectId, args.key, actor, args.ttl_seconds)) {
            return { project_id: projectId, key: args.key, acquired: true, extended: true };
          }

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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { key: z.string(), project_id: projectIdParam },
      outputSchema: { project_id: idParam, key: z.string(), released: z.boolean() },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const released = releaseOwnedLease(projectId, args.key, currentActor());
        return { project_id: projectId, key: args.key, released };
      }),
  );
}
