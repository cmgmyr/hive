import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { db } from "../db.js";
import { acquireLease, releaseLease } from "../leaseStore.js";
import { run } from "../result.js";
import { idParam, projectIdParam } from "./params.js";
import { resolveWakeDelivery } from "../wakeTarget.js";

export function registerLeases(server: McpServer): void {
  server.registerTool(
    "lease_acquire",
    {
      description:
        "Try to take a named lease on state another session could also change, such as a shared checkout, a dev database or a port (non-blocking). Re-taking your own lease extends it. With wait:true, queue FIFO on a held lease and receive one wake when granted; the requested TTL starts at grant time, and max_wait_seconds defaults to 3600. The caller must have a safe running session that can receive wakes. lease_release cancels your queued wait. The grant wake reports a deadline that may pass before delivery; call lease_acquire again before then to extend it. A worker's leases are released when hive stops its pane, parks it or confirms it dead; row_only retirement leaves them in place because it does not stop the pane. Leases expire on their own.",
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
        wait: z.boolean().optional(),
        max_wait_seconds: z.number().int().positive().optional(),
      },
      outputSchema: {
        project_id: idParam,
        key: z.string(),
        acquired: z.boolean(),
        expires_at: z.string().optional(),
        extended: z.boolean().optional(),
        held_by: z.string().optional(),
        queued: z.literal(true).optional(),
        position: z.number().int().positive().optional(),
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const actor = currentActor();
        if (args.max_wait_seconds !== undefined && args.wait !== true) {
          throw new Error("max_wait_seconds requires wait:true");
        }
        if (args.wait === true && args.key.startsWith("wake-pane:")) {
          throw new Error("wait:true is not supported for internal wake-pane leases");
        }
        let wait;
        if (args.wait === true) {
          const own = db.prepare(
            "SELECT id FROM agents WHERE project_id = ? AND actor_id = ? AND status = 'running' AND parked_at = '' ORDER BY id DESC LIMIT 1",
          ).get(projectId, actor) as { id: number } | undefined;
          if (!own) throw new Error("You must be a session an answer can be woken back to");
          wait = { max_wait_seconds: args.max_wait_seconds ?? 3600, delivery: resolveWakeDelivery(projectId, own.id) };
        }
        const result = acquireLease(projectId, args.key, actor, args.ttl_seconds, wait);
        if (args.wait !== true && result.extended) {
          return { project_id: projectId, key: args.key, acquired: true, extended: true };
        }
        return result;
      }),
  );

  server.registerTool(
    "lease_release",
    {
      description: "Release a lease you own, or cancel your queued wait for the key.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { key: z.string(), project_id: projectIdParam },
      outputSchema: { project_id: idParam, key: z.string(), released: z.boolean(), left_queue: z.literal(true).optional() },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        return { project_id: projectId, key: args.key, ...releaseLease(projectId, args.key, currentActor()) };
      }),
  );
}
