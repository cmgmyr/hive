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
import { LEAD_KIND } from "../spawn.js";

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
  // ORDER BY id DESC LIMIT 1, matching splitTargetWindow's identical shape
  // (src/spawn.ts): two running rows sharing one actor_id should never
  // happen, but a `.get()` with no ordering picks whichever SQLite returns
  // first if it ever does, and the ordering costs nothing. One convention,
  // not two - cross-referenced here and there.
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

type ConfirmationStatus = "confirmed" | "unconfirmed" | "unconfirmed_busy" | "no_confirmation_channel";

// Shared by both sections below so a wake's delivery state reads the same
// way wherever it appears. confirmation is deliberately a tri-state, now
// four, rather than boolean-plus-null: each value is an absent confirmed_at
// for a DIFFERENT reason, and collapsing any two back together would
// recreate the exact ambiguity this field exists to remove.
//
// Issue #75. unconfirmed_busy is that discipline applied to a third cause:
// typed_busy (src/scheduler.ts's deliver()) records that the target's last
// recorded hook state, AT THE MOMENT HIVE TYPED, was mid-turn. It is an
// OBSERVATION, not a prediction of whether this wake will go on to confirm.
//
// Counselors round 1 (todo 209, item B) corrected an earlier version of this
// comment, which claimed a busy delivery "can structurally never confirm".
// .claude/rules/tmux-and-panes.md:43 and this project's board disagree about
// exactly that - both claim verification - and this value does not need
// either one to be right (see deliver()'s own comment for the full
// argument). If a genuine prompt row DOES arrive later, confirmed_at is set
// exactly as it is for any other wake and this branch is never reached: the
// ternary below checks confirmed_at first. unconfirmed_busy only ever means
// "still unconfirmed, and the target's last recorded state at typing time
// was mid-turn" - nothing stronger.
//
// typed_busy === 0 or null (idle, or no hook row to ask at all) still
// reports plain "unconfirmed": that is the real alarm this tri-, now four-,
// state exists to keep legible, and a row written before this column existed
// has typed_busy NULL, so it reports exactly as it always did - no backfill
// needed, no behaviour change for history.
//
// NAMED RESIDUAL: typed_busy=1 can be STALE. A target latched into a stuck
// 'working' (issue #38, or a dropped API response) or a permanently stuck
// 'waiting' (issue #28, a permission prompt nobody ever answers - deliver()'s
// own comment puts 'waiting' in the same busy bucket as 'working') reports
// unconfirmed_busy, the quiet value, for what is actually the real alarm - a
// target that is not coming back. Not fixed here: this field must not grow a
// freshness bound (stateProvenance.ts's own docstring forbids exactly that
// inference). Issue #72 (merged f1b805b, shortly before this lane) is the
// compensating control - last_log_event plus its age is surfaced in
// agent_list, `hive status` and `hive doctor`, so a stale 'working' or
// 'waiting' row is visible through a channel built to show staleness, even
// though this field deliberately does not try. Reopen if unconfirmed_busy is
// ever the ONLY place a stuck target would have been visible.
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
          : !hasChannel(t.deliver_actor)
            ? "no_confirmation_channel"
            : t.typed_busy === 1
              ? "unconfirmed_busy"
              : "unconfirmed",
  };
}

const truncateBody = (body: string): string => (body.length > 120 ? `${body.slice(0, 120)}…` : body);

// The five fields every wake carries regardless of which section it appears
// in, factored out so the callers below cannot drift apart on a field they
// are all supposed to report identically. truncate defaults to true for
// wake_list's two sections; wake_get passes false, since an untruncated body
// is its whole reason to exist.
const baseWakeFields = (t: TimerRow, { truncate = true } = {}) => ({
  wake_id: t.id,
  kind: t.kind,
  body: truncate ? truncateBody(t.body) : t.body,
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
        "Wake up when watched agents go idle (exact state from Claude Code hooks) or max_wait_seconds passes - except delivery HOLDS past that bound instead, for as long as the target pane is on a dialog or has unsubmitted human text in it, rather than pasting the wake body into either (.claude/rules/tmux-and-panes.md). mode=any fires on the first fresh idle transition; mode=all fires when every watched agent is idle (returns already_satisfied without scheduling anything if they all are now). Use instead of polling workers. Refuses a lead target: a lead has no idle/working state channel.",
      inputSchema: {
        agents: z.array(agentRefParam).min(1).describe("Agents to watch."),
        body: z.string(),
        mode: z.enum(["any", "all"]).optional().describe("Defaults to any."),
        max_wait_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How long to wait for idle before firing anyway. Defaults to 900. Not a hard deadline: delivery holds past it while the target pane is on a dialog or has unsubmitted text, until the pane clears.",
          ),
        deliver_to: agentRefParam.optional().describe("Deliver to a spawned agent instead of this session."),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const mode = args.mode ?? "any";
        const watched = args.agents.map((ref) => resolveAgentRef(projectId, ref));
        // Issue #27's L4 fix round, DECISION 4/5. The lead's hook writes only
        // its append-only log row, never agents.agent_state (worker-state.md,
        // src/hook.ts's UPDATE is scoped to kind = 'agent') - so watchedStates
        // (src/scheduler.ts) can never read a lead as idle, "idle" is false
        // forever, and this would silently degrade to firing only at
        // max_wait_seconds, reported as a timeout rather than the loud,
        // immediate error a caller can actually act on. Refuse before the
        // INSERT, not after: a scheduled wake that can only ever time out is
        // worse than no wake at all.
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
    "wake_get",
    {
      description:
        "Read one wake-up by id, in this project, with its UNTRUNCATED body. wake_list truncates " +
        "body at 120 chars; use this to see exactly what a wake will say, or to confirm what " +
        "wake_update just changed.",
      inputSchema: { wake_id: z.number().int(), project_id: projectIdParam },
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
        wake_id: z.number().int(),
        delay_seconds: z.number().int().positive().optional(),
        body: z.string().optional(),
        repeat_every_seconds: z.number().int().positive().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        if (args.delay_seconds == null && args.body == null && args.repeat_every_seconds == null) {
          throw new Error(
            "wake_update requires at least one of delay_seconds, body, repeat_every_seconds.",
          );
        }
        const projectId = effectiveProjectId(args.project_id);
        // due_at/repeat_every_ms only mean anything to a 'delay' wake.
        // tick()'s candidates query (this file's own scheduler.ts) dispatches
        // purely on kind: an idle_any/idle_all row goes to maybeFireIdle
        // regardless of due_at, so writing due_at on one is a silent no-op -
        // the exact "receipt says something happened when it did not" shape
        // as the claimOneShot staleness this same PR already fixed, reached
        // from a different direction. Worse for repeat_every_seconds:
        // ACTIVE_TIMER_WHERE keeps a row with repeat_every_ms set active
        // forever once fired_at is set, but an idle-kind candidate requires
        // fired_at IS NULL (tick()'s WHERE), so once it fires once it can
        // never be a candidate again - a permanently-pending wake that can
        // never fire, visible in wake_list forever.
        //
        // Counselors round on #101, P2. Scoped by the SAME predicate the
        // final UPDATE below uses (id, project_id, owner, ACTIVE_TIMER_WHERE)
        // - not project_id alone, which the first version of this check used.
        // A wake's kind never changes after creation, so there is no
        // staleness risk in checking it separately from the write; the
        // reason to match predicates is failure SHAPE, not correctness.
        // Scoping only by project_id meant "another actor's idle wake" or "a
        // cancelled/fired idle wake" threw this kind-specific error instead
        // of the plain updated: false every other kind of miss (wrong owner,
        // not pending) already returns - two different failure shapes for
        // what is, from the caller's side, the same class of "you can't
        // touch this wake" miss. Matching the predicate means this throw is
        // reachable only for a wake the caller could otherwise legitimately
        // edit, so the helpful, kind-specific message survives for the one
        // case a caller can actually act on; every other mismatch (including
        // a foreign or non-pending idle wake) now falls through to the same
        // updated: false the main UPDATE already returns for its own misses.
        if (args.delay_seconds != null || args.repeat_every_seconds != null) {
          const target = db
            .prepare(
              `SELECT kind FROM timers WHERE id = ? AND project_id = ? AND owner = ? AND ${ACTIVE_TIMER_WHERE}`,
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
        // body: same free-text field wake_set already accepts from this same
        // caller, typed into a terminal the identical way (deliver()'s prefix
        // and sendText are unchanged by this lane) - no new untrusted surface,
        // so nothing here needs the sanitize-the-field discipline that
        // applies to a value hive itself derives, like describeLastLogEvent's
        // event column (.claude/sessions/dead-ends/2026-08-02-capping-the-
        // sentence-not-the-field.md). Matches wake_set exactly; adds nothing.
        if (args.body != null) {
          sets.push("body = ?");
          params.push(args.body);
        }
        // Changes the interval used from the NEXT firing onward only.
        // due_at (the next fire time) is written solely by the scheduler's
        // claim UPDATE (src/scheduler.ts's fireDelay), using repeat_every_ms
        // read from the row AT THAT FIRING - so updating this column here
        // never moves a due_at already set by the prior cycle. Verified
        // against src/scheduler.ts as todo 236's own check, not assumed.
        if (args.repeat_every_seconds != null) {
          sets.push("repeat_every_ms = ?");
          params.push(args.repeat_every_seconds * 1000);
        }
        // The only field that moves due_at, and it does so relative to now,
        // matching wake_set (Chris's pre-decision) rather than the wake's
        // original due_at.
        if (args.delay_seconds != null) {
          sets.push("due_at = datetime('now', printf('+%d seconds', ?))");
          params.push(args.delay_seconds);
        }
        params.push(args.wake_id, projectId, currentActor());
        // Owner-scoped and pending-only, mirroring wake_cancel's own WHERE
        // (owner = ?, cancelled_at IS NULL) - reusing ACTIVE_TIMER_WHERE
        // rather than hand-writing a second pending predicate that could
        // drift from pendingWakes()'s. A miss (wrong id, not yours, not
        // pending) reads as updated: false, the same soft-failure shape
        // wake_cancel already uses for the identical predicate shape.
        const row = db
          .prepare(
            `UPDATE timers SET ${sets.join(", ")}
             WHERE id = ? AND project_id = ? AND owner = ? AND ${ACTIVE_TIMER_WHERE}
             RETURNING due_at`,
          )
          .get(...params) as { due_at: string } | undefined;
        return { wake_id: args.wake_id, updated: row !== undefined, due_at: row?.due_at ?? null };
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
