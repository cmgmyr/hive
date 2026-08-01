import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId } from "../context.js";
import { run } from "../result.js";
import { findAgent, isLive, probeFailed, summaryLiveness, type AgentRow } from "./agents.js";
import { ACTIVE_TIMER_WHERE, LOG_RETENTION, type TimerRow } from "../scheduler.js";
import { projectIdParam } from "./params.js";
import { deriveProvenance } from "../stateProvenance.js";
import { liveTargets } from "../tmux.js";

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
    const live = isLive(agent);
    if (live === null) throw probeFailed(agent);
    if (!live) {
      throw new Error(`Agent "${agent.name}" has no live tmux window to deliver to.`);
    }
    return { actor: agent.actor_id, pane: agent.tmux_target };
  }
  const actor = currentActor();
  const own = db
    .prepare("SELECT * FROM agents WHERE actor_id = ? AND status = 'running'")
    .get(actor) as AgentRow | undefined;
  if (own && isLive(own) === true) return { actor, pane: own.tmux_target };
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

// Issue #27. A ONE-SHOT wake leaves pendingWakes() the moment it fires -
// ACTIVE_TIMER_WHERE excludes it on purpose (src/scheduler.ts), and widening
// that clause would change what the scheduler FIRES, not just what is
// reported (pinned by test/delivery-state.test.mjs). So "delivered,
// unconfirmed" has nowhere to appear without a second, separate section.
// This is that section: one-shot only (a repeating timer never leaves
// pendingWakes(), so it would only be a duplicate row here), most recent
// fired_at first, bounded by RECENTLY_FIRED_LIMIT so wake_list's output
// cannot grow without bound in a busy project ("write tools return slim
// receipts; token cost is a design input", CLAUDE.md).
const RECENTLY_FIRED_LIMIT = 10;

// Counselors A6. Also bounded by LOG_RETENTION (the same window
// checkConfirmations, src/scheduler.ts, uses to decide what it can still
// confirm), and that second bound is not cosmetic. Past LOG_RETENTION, a
// typed one-shot's confirmed_at can never change again - hive has
// permanently stopped looking - but deliveryState() below still renders it
// as "unconfirmed", the identical string used for a wake typed eight seconds
// ago that hive is actively still watching. A quiet project would otherwise
// show a one-shot fired months ago under "recently" and report it as
// waiting on an ack it structurally cannot ever receive. Dropping those rows
// loses no information a lead could act on; it just stops the section lying
// about what "unconfirmed" means.
// Counselors A7. `, id DESC` is a real tiebreaker, not decoration: fired_at
// is whole-second (src/scheduler.ts's datetime('now')) and a single tick
// fires every due timer in one loop, so a burst sharing one second is
// ordinary, not exotic. Without a tiebreak, ORDER BY carries no stability
// guarantee for equal keys, so which rows survive LIMIT can differ between
// two calls with no intervening write.
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

// A wake's target has never written a hook row at all (the lead, until issue
// #27's L4 lands) versus a target that writes hook rows but simply has not
// submitted one yet: an absent confirmed_at means one of those two very
// different things, and reporting only "not confirmed" for both is exactly
// the kind of small lie #27 exists to remove (see plan-l3-delivery-states,
// "WHAT L3 CAN AND CANNOT REPORT ABOUT THE LEAD"). Every spawned agent gets
// an agents row (running or closed) the moment it is spawned; the lead does
// not, today. Existence, not liveness - a closed worker's earlier prompt
// rows are still real evidence.
//
// Memoized per wake_list call, not globally: a repeating wake or several
// wakes to the same worker would otherwise repeat an identical lookup once
// per row across both sections below. Not worth a shared cache across calls
// - the whole answer depends on `agents`, which changes on every spawn.
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

type ConfirmationStatus = "confirmed" | "unconfirmed" | "no_confirmation_channel";

// Shared by both sections below so a wake's delivery state reads the same
// way wherever it appears. confirmation is deliberately a tri-state rather
// than boolean-plus-null: "unconfirmed" and "no_confirmation_channel" are
// both an absent confirmed_at, and collapsing them back into one value would
// recreate the exact ambiguity this field exists to remove.
function deliveryState(
  t: TimerRow,
  hasChannel: (actorId: string) => boolean,
): {
  typed_at: string | null;
  held_at: string | null;
  held_reason: string | null;
  confirmed_at: string | null;
  confirmation: ConfirmationStatus | null;
} {
  return {
    typed_at: t.typed_at,
    held_at: t.held_at,
    held_reason: t.held_reason,
    confirmed_at: t.confirmed_at,
    // null (rather than "unconfirmed") when typed_at itself is unset: this
    // is either a wake still pending delivery, or - for a fired one-shot in
    // the recently-delivered section - a claim whose sendText never
    // completed (issue #27's own motivating defect). Neither is "waiting on
    // an ack", so forcing either into the confirmed/unconfirmed pair would
    // hide the more urgent fact that nothing was ever typed at all.
    confirmation:
      t.typed_at == null
        ? null
        : t.confirmed_at != null
          ? "confirmed"
          : hasChannel(t.deliver_actor)
            ? "unconfirmed"
            : "no_confirmation_channel",
  };
}

const truncateBody = (body: string): string => (body.length > 120 ? `${body.slice(0, 120)}…` : body);

// The five fields every wake carries regardless of which section it appears
// in, factored out so the two map() calls below cannot drift apart on a
// field they are both supposed to report identically.
const baseWakeFields = (t: TimerRow) => ({
  wake_id: t.id,
  kind: t.kind,
  body: truncateBody(t.body),
  owner: t.owner,
  deliver_to: t.deliver_actor,
});

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
        // One subprocess for every watched agent's liveness, not one per
        // agent: the mode=all check below and the watching decoration
        // further down both need it, and src/tmux.ts's own comment on
        // liveTargets names this exact "many targets" shape as what it is
        // for (agent_list's own snapshot uses the same pattern).
        const snapshot = liveTargets();

        if (mode === "all") {
          // An agent tmux says is gone counts as nothing left to wait for. An
          // agent tmux could not answer about does NOT: reading unknown as
          // satisfied returns "Act now" while every worker is mid-task, and
          // the lead proceeds on a completion that never happened.
          const allIdle = watched.every((a) => {
            const live = summaryLiveness(a, snapshot);
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
          // provenance is decoration only: it does not change what this call
          // schedules or what already_satisfied above fired on (that stays a
          // bare liveness + agent_state check, deliberately -- see
          // src/tools/wakes.ts's design pad note on why a freshness check
          // there is out of scope for this lane).
          watching: watched.map((a) => {
            // `state` replaces the sibling field below rather than duplicating
            // it: deriveProvenance already applies the "gone" override when
            // the snapshot says the pane is dead, so using it here (instead of
            // the raw a.agent_state agentSummary would have shown "gone" for)
            // keeps this surface consistent with agent_list for the exact
            // same worker.
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
