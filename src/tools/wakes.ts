import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { run } from "../result.js";
import { findAgent, isLive, probeFailed, summaryLiveness, type AgentRow } from "./agents.js";
import {
  ACTIVE_TIMER_WHERE,
  LOG_RETENTION,
  OWNED_BY_WATCH,
  WATCH_SCOPE_PROJECT,
  seedGoneCursor,
  type TimerRow,
} from "../scheduler.js";
import { idParam, projectIdParam } from "./params.js";
import { cutToUnitBudget } from "../slug.js";
import { awaitingFirstPrompt } from "../firstPrompt.js";
import { deriveProvenance } from "../stateProvenance.js";
import { findUnsafeControlChar, liveTargets, TEXT_ALLOWED_CONTROL_CHARS } from "../tmux.js";
import { isRunningLeadActor, LEAD_KIND } from "../spawn.js";

const agentRefParam = z
  .union([idParam, z.string()])
  .describe("Running agent's name (preferred), or its numeric agent id.");

function resolveAgentRef(projectId: number, ref: number | string): AgentRow {
  return typeof ref === "number"
    ? findAgent(projectId, { agent_id: ref })
    : findAgent(projectId, { name: ref });
}

function resolveDelivery(
  projectId: number,
  deliverTo?: number | string,
): { actor: string; pane: string } {
  if (deliverTo != null) {
    const agent = resolveAgentRef(projectId, deliverTo);
    const live = isLive(agent);
    if (live === null) throw probeFailed(agent);
    if (!live) {
      throw new Error(`Agent "${agent.name}" has no live tmux window to deliver to.`);
    }
    return { actor: agent.actor_id, pane: agent.tmux_target };
  }
  const actor = currentActor();

  const own = db
    .prepare("SELECT * FROM agents WHERE actor_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(actor) as AgentRow | undefined;
  if (own && isLive(own) === true) return { actor, pane: own.tmux_target };
  const pane = process.env.TMUX_PANE;
  if (pane) return { actor, pane };
  throw new Error(
    "This session cannot receive wake-ups: it is not running inside tmux, so nothing can be typed into its terminal. Start the lead inside tmux (run tmux, then claude; watch with tmux attach, or tmux -CC attach for iTerm's native windows), or pass deliver_to targeting a spawned agent.",
  );
}

function pendingWakes(projectId: number): TimerRow[] {
  return db
    .prepare(`SELECT * FROM timers WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE} ORDER BY id`)
    .all(projectId) as TimerRow[];
}

const RECENTLY_FIRED_LIMIT = 10;

function recentlyFiredWakes(projectId: number): TimerRow[] {
  return db
    .prepare(
      `SELECT * FROM timers
       WHERE project_id = ? AND cancelled_at IS NULL AND fired_at IS NOT NULL AND repeat_every_ms IS NULL
         AND fired_at >= datetime('now', ?)
       ORDER BY fired_at DESC, id DESC LIMIT ${RECENTLY_FIRED_LIMIT}`,
    )
    .all(projectId, LOG_RETENTION) as TimerRow[];
}

function makeChannelChecker(): (actorId: string) => boolean {
  const known = new Map<string, boolean>();
  return (actorId) => {
    let has = known.get(actorId);
    if (has === undefined) {
      has = db.prepare("SELECT 1 FROM agents WHERE actor_id = ?").get(actorId) !== undefined;
      known.set(actorId, has);
    }
    return has;
  };
}

type ConfirmationStatus = "confirmed" | "unconfirmed" | "unconfirmed_busy" | "no_confirmation_channel";

function deliveryState(
  t: TimerRow,
  hasChannel: (actorId: string) => boolean,
): {
  typed_at: string | null;
  typed_seen: string | null;
  held_at: string | null;
  held_reason: string | null;
  confirmed_at: string | null;
  confirmation: ConfirmationStatus | null;
} {
  return {
    typed_at: t.typed_at,
    typed_seen: t.typed_seen,
    held_at: t.held_at,
    held_reason: t.held_reason,
    confirmed_at: t.confirmed_at,

    confirmation:
      t.typed_at == null
        ? null
        : t.confirmed_at != null
          ? "confirmed"
          : !hasChannel(t.deliver_actor)
            ? "no_confirmation_channel"
            : t.typed_busy === 1
              ? "unconfirmed_busy"
              : "unconfirmed",
  };
}

export const truncateBody = (body: string): string =>
  body.length > 120 ? `${cutToUnitBudget(body, 120)}…` : body;

function rejectUnsafeBody(body: string): void {
  const bad = findUnsafeControlChar(body, TEXT_ALLOWED_CONTROL_CHARS);
  if (bad) {
    throw new Error(
      `body cannot contain ${bad.label} at offset ${bad.index}: it is typed literally into the target pane ` +
        "when the wake fires, and a raw control byte reaches tmux as a keystroke instead of as text, " +
        "silently turning the delivery into a keys call nobody chose. Tab and newline are the only control " +
        "characters allowed - every wake in this project is multi-line prose. To send an actual keystroke " +
        'on purpose, call agent_send(keys: [...]) against the target directly instead of scheduling it here.',
    );
  }
}

const baseWakeFields = (t: TimerRow, { truncate = true } = {}) => ({
  wake_id: t.id,
  kind: t.kind,
  body: truncate ? truncateBody(t.body) : t.body,
  owner: t.owner,
  deliver_to: t.deliver_actor,
  ...(t.watch_scope ? { scope: t.watch_scope, standing: true } : {}),
  ...(t.parent_timer_id != null ? { parent_wake_id: t.parent_timer_id } : {}),
});

const STANDING_WATCH_LIFETIME_SECONDS = 4 * 60 * 60;

const openStandingWatch = db.transaction(
  (
    projectId: number,
    owner: string,
    body: string,
    deliverActor: string,
    deliverPane: string,
    maxWait: number,
  ): { id: number; max_wait_at: string } => {
    const existing = db
      .prepare(
        `SELECT id, max_wait_at FROM timers
          WHERE project_id = ? AND owner = ? AND watch_scope IS NOT NULL AND ${ACTIVE_TIMER_WHERE}
          ORDER BY id LIMIT 1`,
      )
      .get(projectId, owner) as { id: number; max_wait_at: string | null } | undefined;
    if (existing !== undefined) {
      throw new Error(
        `You already have a standing watch on this project: wake #${existing.id}, which expires at ` +
          `${existing.max_wait_at ?? "an unrecorded time"}. It is still watching the crew you spawned, ` +
          "including workers spawned since you set it, so a second one would report every finish twice and " +
          `leave two wake ids to cancel. Use it, or wake_cancel(wake_id: ${existing.id}) first if you want to ` +
          "change its body, its lifetime or its deliver_to.",
      );
    }
    const row = db
      .prepare(
        `INSERT INTO timers (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, max_wait_at)
         VALUES (?, ?, ?, 'idle_any', ?, ?, ?, datetime('now', printf('+%d seconds', ?)))
         RETURNING id, max_wait_at`,
      )
      .get(projectId, owner, body, WATCH_SCOPE_PROJECT, deliverActor, deliverPane, maxWait) as {
      id: number;
      max_wait_at: string;
    };
    seedGoneCursor(row.id, projectId);
    return row;
  },
);

function createStandingWatch(
  projectId: number,
  args: { body: string; max_wait_seconds?: number; deliver_to?: number | string },
): Record<string, unknown> {
  const delivery = resolveDelivery(projectId, args.deliver_to);
  const maxWait = args.max_wait_seconds ?? STANDING_WATCH_LIFETIME_SECONDS;
  const row = openStandingWatch.immediate(
    projectId,
    currentActor(),
    args.body,
    delivery.actor,
    delivery.pane,
    maxWait,
  );

  const crew = db
    .prepare(
      `SELECT name FROM agents a
        WHERE a.project_id = ? AND a.kind = 'agent' AND a.status = 'running' AND a.actor_id != ?
          ${OWNED_BY_WATCH}
        ORDER BY a.id`,
    )
    .all(projectId, currentActor(), currentActor()) as { name: string }[];
  return {
    wake_id: row.id,
    scope: WATCH_SCOPE_PROJECT,
    standing: true,
    watching_now: crew.map((c) => c.name),
    expires_at: row.max_wait_at,
    max_wait_seconds: maxWait,
    deliver_to: delivery.actor,
    note:
      "Standing watch: it reports EACH crew member as it finishes or goes away, including workers spawned " +
      "after this call, and keeps watching until it expires or you wake_cancel it. Agents already idle now " +
      "DO count and are reported on the first tick - unlike mode=any, deliberately, because a worker that " +
      "finished before the watch was set is exactly the finish a one-shot loses. Go quiet.",
  };
}

export function registerWakes(server: McpServer): void {
  server.registerTool(
    "wake_set",
    {
      description:
        "Schedule a wake-up: after delay_seconds the body is typed into the target session's terminal " +
        "as a fresh user turn (prefixed [hive wake #N]). Defaults to delivering to THIS session. Use " +
        "instead of polling. Write the body self-contained: ids, context, next action - it may arrive in " +
        "a session that has none of this conversation. Delivering to your OWN lead pane, where the " +
        "context is already there, prefer the action, the ids, and a pointer to where the detail lives.",
      inputSchema: {
        delay_seconds: z.number().int().positive(),
        body: z.string(),
        deliver_to: agentRefParam.optional().describe("Deliver to a spawned agent instead of this session."),
        repeat_every_seconds: z.number().int().positive().optional(),
        project_id: projectIdParam,
      },
      outputSchema: {
        wake_id: idParam,
        due_at: z.string(),
        deliver_to: z.string(),
        repeating: z.boolean(),
      },
    },
    (args) =>
      run(() => {
        rejectUnsafeBody(args.body);
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
        "Wake up when watched agents go idle (exact state from Claude Code hooks) or max_wait_seconds passes - except delivery HOLDS past that bound instead, for as long as the target pane is on a dialog or has unsubmitted human text in it, rather than pasting the wake body into either (.claude/rules/tmux-and-panes.md). Two shapes, and you pass EXACTLY ONE of them. agents=[...] is a ONE-SHOT over a named list: mode=any fires on the first fresh idle transition, mode=all fires when every watched agent is idle (returns already_satisfied without scheduling anything if they all are now), and either way it stops watching once it fires. scope=\"project\" is a STANDING WATCH over the crew you spawn in this project, including workers spawned later: it never stops watching, and on each finish it delivers a roster naming who finished and who is still going, until max_wait_seconds runs out or you wake_cancel it. You may hold ONE standing watch per project: a second call is refused and names the one already running, since two would report every finish twice. Use the standing watch when you are running more than one worker - a one-shot leaves every other worker unwatched from the moment it fires. Use either instead of polling. Refuses a lead target: a lead has no idle/working state channel.",
      inputSchema: {
        agents: z
          .array(agentRefParam)
          .min(1)
          .optional()
          .describe("Agents to watch, as a ONE-SHOT. Mutually exclusive with scope."),
        body: z.string(),
        mode: z.enum(["any", "all"]).optional().describe("Defaults to any. Only meaningful with agents."),

        scope: z
          .enum(["project"])
          .optional()
          .describe(
            "Watch the crew you spawn in this project as a STANDING watch that keeps watching after each " +
              "finish, including workers spawned later. Mutually exclusive with agents.",
          ),
        max_wait_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "For agents=[...]: how long to wait for idle before firing anyway, default 900. For " +
              "scope=\"project\": THE WATCH'S LIFETIME, default 14400 (4 hours), after which it delivers one " +
              "last wake saying it has expired and stops watching. Not a hard deadline either way: delivery " +
              "holds past it while the target pane is on a dialog or has unsubmitted text, until the pane clears.",
          ),
        deliver_to: agentRefParam.optional().describe("Deliver to a spawned agent instead of this session."),
        project_id: projectIdParam,
      },
      outputSchema: {
        status: z.literal("already_satisfied").optional(),
        wake_id: idParam.optional(),
        scope: z.literal("project").optional(),
        standing: z.boolean().optional(),
        watching_now: z.array(z.string()).optional(),
        mode: z.enum(["any", "all"]).optional(),
        watching: z
          .array(
            z.object({
              agent_id: idParam,
              name: z.string(),
              state: z.string(),
              provenance: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        expires_at: z.string().optional(),
        max_wait_seconds: z.number().optional(),
        deliver_to: z.string().optional(),
        note: z.string().optional(),
      },
    },
    (args) =>
      run(() => {
        rejectUnsafeBody(args.body);
        const projectId = effectiveProjectId(args.project_id);

        if ((args.agents == null) === (args.scope == null)) {
          throw new Error(
            "wake_when_idle needs exactly one of agents=[...] (a one-shot over a named list) or " +
              'scope="project" (a standing watch over this project\'s crew). ' +
              (args.agents == null
                ? "You passed neither."
                : "You passed both, and they mean different things: a standing watch computes its own " +
                  "membership every tick, so the list would be ignored."),
          );
        }
        if (args.scope != null && args.mode != null) {
          throw new Error(
            `mode="${args.mode}" has no meaning for a standing watch: a standing watch reports EACH crew ` +
              "member as it finishes, rather than firing once on the first (any) or once on the last (all). " +
              "Drop mode, or use agents=[...] if you want one of those two.",
          );
        }
        if (args.scope != null) return createStandingWatch(projectId, args);
        const mode = args.mode ?? "any";
        const watched = (args.agents ?? []).map((ref) => resolveAgentRef(projectId, ref));

        const leadWatched = watched.find((a) => a.kind === LEAD_KIND);
        if (leadWatched) {
          throw new Error(
            `Agent ${leadWatched.id} ("${leadWatched.name}") is this project's lead session, which has no ` +
              "idle/working state channel: its hook writes only agent_state_log, never agent_state. " +
              "wake_when_idle refuses a lead target; it could only ever fire at max_wait_seconds, reported " +
              "as a timeout instead of the failure it actually is.",
          );
        }
        const delivery = resolveDelivery(projectId, args.deliver_to);

        const snapshot = liveTargets();

        if (mode === "all") {

          const allIdle = watched.every((a) => {
            const live = summaryLiveness(a, snapshot);

            if (awaitingFirstPrompt(a)) return false;
            return live === false || (live === true && a.agent_state === "idle");
          });
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
            `INSERT INTO timers (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
               max_wait_at)
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

          watching: watched.map((a) => {

            const { state, ...provenance } = deriveProvenance(a, summaryLiveness(a, snapshot));
            return { agent_id: a.id, name: a.name, state, provenance };
          }),
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
    "wake_get",
    {
      description:
        "Read one wake-up by id, in this project, with its UNTRUNCATED body. wake_list truncates " +
        "body at 120 chars; use this to see exactly what a wake will say, or to confirm what " +
        "wake_update just changed.",
      inputSchema: { wake_id: idParam, project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const t = db
          .prepare("SELECT * FROM timers WHERE id = ? AND project_id = ?")
          .get(args.wake_id, projectId) as TimerRow | undefined;
        if (!t) throw new Error(`Wake ${args.wake_id} not found in this project.`);
        const hasChannel = makeChannelChecker();
        return {
          ...baseWakeFields(t, { truncate: false }),
          due_at: t.due_at,
          max_wait_at: t.max_wait_at,
          repeat_every_seconds: t.repeat_every_ms != null ? t.repeat_every_ms / 1000 : null,
          repeating: t.repeat_every_ms != null,
          fire_count: t.fire_count,
          cancelled_at: t.cancelled_at,

          first_held_at: t.first_held_at,
          ...deliveryState(t, hasChannel),
        };
      }),
  );

  server.registerTool(
    "wake_update",
    {
      description:
        "Edit a pending wake-up you own, in place, without minting a new id. Provide any subset of " +
        "delay_seconds, body, repeat_every_seconds. delay_seconds is RELATIVE TO NOW, exactly as in " +
        "wake_set: it moves the next fire time to now + delay_seconds. repeat_every_seconds only " +
        "changes the interval used for firings AFTER this one; on its own it does not move the next " +
        "fire time. Only a still-pending wake can be edited; use wake_get to read the result back. " +
        "delay_seconds and repeat_every_seconds only apply to a delay wake (from wake_set) - an idle " +
        "wake (from wake_when_idle) fires on watched-agent state and max_wait_seconds instead, so " +
        "only body can be edited on one.",
      inputSchema: {
        wake_id: idParam,
        delay_seconds: z.number().int().positive().optional(),
        body: z.string().optional(),
        repeat_every_seconds: z.number().int().positive().optional(),
        project_id: projectIdParam,
      },
      outputSchema: { wake_id: idParam, updated: z.boolean(), due_at: z.string().nullable() },
    },
    (args) =>
      run(() => {
        if (args.delay_seconds == null && args.body == null && args.repeat_every_seconds == null) {
          throw new Error(
            "wake_update requires at least one of delay_seconds, body, repeat_every_seconds.",
          );
        }
        const projectId = effectiveProjectId(args.project_id);

        if (args.delay_seconds != null || args.repeat_every_seconds != null) {
          const target = db
            .prepare(
              `SELECT kind FROM timers WHERE id = ? AND project_id = ? AND owner = ? AND parent_timer_id IS NULL
                 AND ${ACTIVE_TIMER_WHERE}`,
            )
            .get(args.wake_id, projectId, currentActor()) as { kind: string } | undefined;
          if (target && target.kind !== "delay") {
            throw new Error(
              `Wake ${args.wake_id} is a ${target.kind} wake (from wake_when_idle): it fires on ` +
                "watched-agent state and max_wait_seconds, not due_at, so delay_seconds and " +
                "repeat_every_seconds have no effect on it. Only body can be edited on it.",
            );
          }
        }
        const sets: string[] = [];
        const params: unknown[] = [];

        if (args.body != null) {
          rejectUnsafeBody(args.body);
          sets.push("body = ?");
          params.push(args.body);
        }

        if (args.repeat_every_seconds != null) {
          sets.push("repeat_every_ms = ?");
          params.push(args.repeat_every_seconds * 1000);
        }

        if (args.delay_seconds != null) {
          sets.push("due_at = datetime('now', printf('+%d seconds', ?))");
          params.push(args.delay_seconds);
        }
        params.push(args.wake_id, projectId, currentActor());

        const row = db
          .prepare(
            `UPDATE timers SET ${sets.join(", ")}
             WHERE id = ? AND project_id = ? AND owner = ? AND parent_timer_id IS NULL AND ${ACTIVE_TIMER_WHERE}
             RETURNING due_at`,
          )
          .get(...params) as { due_at: string } | undefined;
        return { wake_id: args.wake_id, updated: row !== undefined, due_at: row?.due_at ?? null };
      }),
  );

  server.registerTool(
    "wake_cancel",
    {
      description:
        "Cancel a pending wake-up you own, or - if you are a running lead - any pending wake-up in this " +
        "project. Cancelling a standing watch also cancels the FINISH notices it has already filed but not " +
        "yet delivered. It does NOT cancel a block notice (a worker stopped on a dialog): those carry no " +
        "parent link, so one already filed still delivers, and it may still be true - the worker is probably " +
        "still on that dialog - but its sentence about the watch itself will not be.",
      inputSchema: { wake_id: idParam, project_id: projectIdParam },
      outputSchema: {
        wake_id: idParam,
        cancelled: z.boolean(),
        cancelled_notices: z.number().int().nonnegative(),
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);

        const isLead = isRunningLeadActor(currentActor());
        const info = isLead
          ? db
              .prepare(
                `UPDATE timers SET cancelled_at = datetime('now')
                 WHERE id = ? AND project_id = ? AND cancelled_at IS NULL`,
              )
              .run(args.wake_id, projectId)
          : db
              .prepare(
                `UPDATE timers SET cancelled_at = datetime('now')
                 WHERE id = ? AND project_id = ? AND owner = ? AND cancelled_at IS NULL`,
              )
              .run(args.wake_id, projectId, currentActor());

        const notices =
          info.changes > 0
            ? db
                .prepare(
                  `UPDATE timers SET cancelled_at = datetime('now')
                   WHERE parent_timer_id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
                )
                .run(args.wake_id).changes
            : 0;
        return { wake_id: args.wake_id, cancelled: info.changes > 0, cancelled_notices: notices };
      }),
  );

  server.registerTool(
    "wake_list",
    {
      description:
        "List pending wake-ups in this project, plus recently_delivered: the last " +
        `${RECENTLY_FIRED_LIMIT} one-shot wakes that have already fired, with their delivery ` +
        "state (typed_at, held_at/held_reason, confirmation). A one-shot wake leaves the " +
        "pending list the moment it fires; recently_delivered is where to check whether it " +
        "was actually typed and, if its target has a confirmation channel, acknowledged.",
      inputSchema: { project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const hasChannel = makeChannelChecker();
        return {
          project_id: projectId,
          wakes: pendingWakes(projectId).map((t) => ({
            ...baseWakeFields(t),
            due_at: t.due_at,
            max_wait_at: t.max_wait_at,
            repeating: t.repeat_every_ms != null,
            fire_count: t.fire_count,
            ...deliveryState(t, hasChannel),
          })),
          recently_delivered: recentlyFiredWakes(projectId).map((t) => ({
            ...baseWakeFields(t),
            fired_at: t.fired_at,
            fire_count: t.fire_count,
            ...deliveryState(t, hasChannel),
          })),
        };
      }),
  );
}
