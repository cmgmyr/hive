import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { run } from "../result.js";
import { findAgent, isLive, type AgentRow } from "./agents.js";
import { ACTIVE_TIMER_WHERE, type TimerRow } from "../scheduler.js";
import { projectIdParam } from "./params.js";

const agentRefParam = z
  .union([z.number().int(), z.string()])
  .describe("Running agent's name (preferred), or its numeric agent id.");

function resolveAgentRef(projectId: number, ref: number | string): AgentRow {
  return typeof ref === "number"
    ? findAgent(projectId, { agent_id: ref })
    : findAgent(projectId, { name: ref });
}

// Where a wake-up's body gets typed when it fires. Workers are deliverable via
// their tmux window; a lead session is deliverable when it runs inside tmux
// (the MCP server inherits TMUX_PANE from the pane that launched claude).
function resolveDelivery(
  projectId: number,
  deliverTo?: number | string,
): { actor: string; pane: string } {
  if (deliverTo != null) {
    const agent = resolveAgentRef(projectId, deliverTo);
    if (!isLive(agent)) {
      throw new Error(`Agent "${agent.name}" has no live tmux window to deliver to.`);
    }
    return { actor: agent.actor_id, pane: agent.tmux_target };
  }
  const actor = currentActor();
  const own = db
    .prepare("SELECT * FROM agents WHERE actor_id = ? AND status = 'running'")
    .get(actor) as AgentRow | undefined;
  if (own && isLive(own)) return { actor, pane: own.tmux_target };
  const pane = process.env.TMUX_PANE;
  if (pane) return { actor, pane };
  throw new Error(
    "This session cannot receive wake-ups: it is not running inside tmux, so nothing can be typed into its terminal. Start the lead inside tmux (run tmux, then claude; watch via iTerm with tmux -CC attach), or pass deliver_to targeting a spawned agent.",
  );
}

function pendingWakes(projectId: number): TimerRow[] {
  return db
    .prepare(`SELECT * FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE} ORDER BY id`)
    .all(projectId) as TimerRow[];
}

export function registerWakes(server: McpServer): void {
  server.registerTool(
    "wake_set",
    {
      description:
        "Schedule a wake-up: after delay_seconds the body is typed into the target session's terminal as a fresh user turn (prefixed [hive wake #N]). Defaults to delivering to THIS session. Use instead of polling. Write the body self-contained: ids, context, next action.",
      inputSchema: {
        delay_seconds: z.number().int().positive(),
        body: z.string(),
        deliver_to: agentRefParam.optional().describe("Deliver to a spawned agent instead of this session."),
        repeat_every_seconds: z.number().int().positive().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const delivery = resolveDelivery(projectId, args.deliver_to);
        const row = db
          .prepare(
            `INSERT INTO timers (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, repeat_every_ms)
             VALUES (?, ?, ?, 'delay', ?, ?, datetime('now', printf('+%d seconds', ?)), ?)
             RETURNING id, due_at`,
          )
          .get(
            projectId,
            currentActor(),
            args.body,
            delivery.actor,
            delivery.pane,
            args.delay_seconds,
            args.repeat_every_seconds != null ? args.repeat_every_seconds * 1000 : null,
          ) as { id: number; due_at: string };
        return {
          wake_id: row.id,
          due_at: row.due_at,
          deliver_to: delivery.actor,
          repeating: args.repeat_every_seconds != null,
        };
      }),
  );

  server.registerTool(
    "wake_when_idle",
    {
      description:
        "Wake up when watched agents go idle (exact state from Claude Code hooks) or max_wait_seconds passes. mode=any fires on the first fresh idle transition; mode=all fires when every watched agent is idle (returns already_satisfied without scheduling anything if they all are now). Use instead of polling workers.",
      inputSchema: {
        agents: z.array(agentRefParam).min(1).describe("Agents to watch."),
        body: z.string(),
        mode: z.enum(["any", "all"]).optional().describe("Defaults to any."),
        max_wait_seconds: z.number().int().positive().optional().describe("Deadline. Defaults to 900."),
        deliver_to: agentRefParam.optional().describe("Deliver to a spawned agent instead of this session."),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const mode = args.mode ?? "any";
        const watched = args.agents.map((ref) => resolveAgentRef(projectId, ref));
        const delivery = resolveDelivery(projectId, args.deliver_to);

        if (mode === "all") {
          const allIdle = watched.every((a) => !isLive(a) || a.agent_state === "idle");
          if (allIdle) {
            return {
              status: "already_satisfied",
              note: "Every watched agent is already idle; nothing was scheduled. Act now.",
            };
          }
        }

        const maxWait = args.max_wait_seconds ?? 900;
        const info = db
          .prepare(
            `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', printf('+%d seconds', ?)))`,
          )
          .run(
            projectId,
            currentActor(),
            args.body,
            `idle_${mode}`,
            JSON.stringify(watched.map((a) => a.id)),
            delivery.actor,
            delivery.pane,
            maxWait,
          );
        return {
          wake_id: Number(info.lastInsertRowid),
          mode,
          watching: watched.map((a) => ({ agent_id: a.id, name: a.name, state: a.agent_state })),
          max_wait_seconds: maxWait,
          deliver_to: delivery.actor,
          note:
            mode === "any"
              ? "Fires on the next fresh idle transition; agents already idle now do not count."
              : "Fires when all watched agents are idle.",
        };
      }),
  );

  server.registerTool(
    "wake_cancel",
    {
      description: "Cancel a pending wake-up you own.",
      inputSchema: { wake_id: z.number().int(), project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const info = db
          .prepare(
            `UPDATE timers SET cancelled_at = datetime('now')
             WHERE id = ? AND project_id = ? AND owner = ? AND cancelled_at IS NULL`,
          )
          .run(args.wake_id, projectId, currentActor());
        return { wake_id: args.wake_id, cancelled: info.changes > 0 };
      }),
  );

  server.registerTool(
    "wake_list",
    {
      description: "List pending wake-ups in this project.",
      inputSchema: { project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        return {
          project_id: projectId,
          wakes: pendingWakes(projectId).map((t) => ({
            wake_id: t.id,
            kind: t.kind,
            body: t.body.length > 120 ? `${t.body.slice(0, 120)}…` : t.body,
            owner: t.owner,
            deliver_to: t.deliver_actor,
            due_at: t.due_at,
            max_wait_at: t.max_wait_at,
            repeating: t.repeat_every_ms != null,
            fire_count: t.fire_count,
          })),
        };
      }),
  );
}
