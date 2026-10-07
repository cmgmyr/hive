import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { commitQueenStateWrite } from "../queenAudit.js";
import { currentActor, effectiveProjectId, getProject, isQueenLead } from "../context.js";
import { run } from "../result.js";
import { findAgent, observeOwnership, notOwnedError, summaryLiveness, type AgentRow } from "./agents.js";
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
import {
  findUnsafeControlChar,
  foreignSocket,
  liveTargets,
  observationFailed,
  rowOwnership,
  TEXT_ALLOWED_CONTROL_CHARS,
} from "../tmux.js";
import { readLeadTurnState } from "../leadState.js";
import { LEAD_TARGET_GONE, LEAD_TARGET_REISSUED, leadSubscription, paneVeto, runningLeadOf } from "../leadWatch.js";
import { isRunningLeadActor, LEAD_KIND } from "../spawn.js";
import { commandHead, screenClassifiable } from "../harnesses.js";

const agentRefParam = z
  .union([idParam, z.string()])
  .describe("Running agent's name (preferred), or its numeric agent id.");

function resolveAgentRef(projectId: number, ref: number | string): AgentRow {
  return typeof ref === "number"
    ? findAgent(projectId, { agent_id: ref })
    : findAgent(projectId, { name: ref });
}

function refuseUnclassifiableTarget(agent: AgentRow): void {
  if (screenClassifiable(agent.command)) return;
  throw new Error(
    `Agent ${agent.id} ("${agent.name}") runs ${JSON.stringify(commandHead(agent.command))}, and hive can only ` +
      "classify a claude screen. A wake is delivered by pasting its body and pressing Enter, and the two guards " +
      "that decide whether that is safe - a dialog on screen, unsubmitted human text in the box - both read " +
      "claude's own chrome, so on this pane neither can answer. Delivery would type blind: into a dialog it " +
      "answers the highlighted option, and on a shell it executes whatever the paste merged with. " +
      "Refused here rather than at delivery, where it could only ever be held forever - a pane's harness never " +
      "becomes classifiable, so that hold would never clear, and a timer that cannot fire is worse than an " +
      "error you can read now. Drive this pane with agent_send(keys: [...]) instead, which is unguarded for " +
      "exactly this reason.",
  );
}

function resolveDelivery(
  projectId: number,
  deliverTo?: number | string,
): { actor: string; pane: string } {
  if (deliverTo != null) {
    const agent = resolveAgentRef(projectId, deliverTo);
    // Before the liveness probe: the harness is a durable fact about the row, while liveness is a
    // question about right now, so a dead bash worker should say what is actually wrong with it.
    refuseUnclassifiableTarget(agent);
    const ownership = agent.status === "running" ? observeOwnership(agent) : "gone";
    if (ownership === "gone") throw new Error(`Agent "${agent.name}" has no live tmux window to deliver to.`);
    if (ownership !== "live") throw notOwnedError(agent, ownership);
    return { actor: agent.actor_id, pane: agent.tmux_target };
  }
  const actor = currentActor();

  const own = db
    .prepare("SELECT * FROM agents WHERE actor_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(actor) as AgentRow | undefined;
  // Checked on the ROW, not behind the liveness probe: isLive is three-state, and letting a null
  // fall through to the TMUX_PANE branch below accepts a wake the scheduler will then hold forever
  // against that same row's command - the never-firing timer this refusal exists to prevent.
  if (own) refuseUnclassifiableTarget(own);
  if (own) {
    const ownership = observeOwnership(own);
    if (ownership === "live") return { actor, pane: own.tmux_target };
    // Unknown never falls through to the ambient pane: that would bind this row's actor to a pane it may not own.
    if (ownership === "unknown") throw notOwnedError(own, ownership);
  }
  const pane = process.env.TMUX_PANE;
  if (pane) return { actor, pane };
  throw new Error(
    "This session cannot receive wake-ups: it is not running inside tmux, so nothing can be typed into its terminal. Start the lead inside tmux (run tmux, then claude; watch with tmux attach, or tmux -CC attach for iTerm's native windows), or pass deliver_to targeting a spawned agent.",
  );
}

function pendingWakes(projectId: number): TimerRow[] {
  return db
    .prepare(`SELECT * FROM wakes WHERE project_id = ? AND ${ACTIVE_TIMER_WHERE} ORDER BY id`)
    .all(projectId) as TimerRow[];
}

const RECENTLY_FIRED_LIMIT = 10;

function recentlyFiredWakes(projectId: number): TimerRow[] {
  return db
    .prepare(
      `SELECT * FROM wakes
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
  delivery_method: string | null;
  socket_attempt_at: string | null;
} {
  return {
    typed_at: t.typed_at,
    typed_seen: t.typed_seen,
    held_at: t.held_at,
    held_reason: t.held_reason,
    confirmed_at: t.confirmed_at,

    confirmation:
      t.typed_at == null && t.socket_attempt_at == null
        ? null
        : t.confirmed_at != null
          ? "confirmed"
          : !hasChannel(t.deliver_actor)
            ? "no_confirmation_channel"
            : t.typed_busy === 1
              ? "unconfirmed_busy"
              : "unconfirmed",
    delivery_method: t.delivery_method,
    socket_attempt_at: t.socket_attempt_at,
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
  ...(t.parent_wake_id != null ? { parent_wake_id: t.parent_wake_id } : {}),
  ...leadWatchFields(t),
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
        `SELECT id, max_wait_at FROM wakes
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
        `INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, max_wait_at)
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

export const LEAD_WATCH_QUEEN_ONLY = "LEAD_WATCH_QUEEN_ONLY";

const openLeadWatch = db.transaction(
  (
    homeProjectId: number,
    body: string,
    mode: "any" | "all",
    delivery: { actor: string; pane: string },
    maxWait: number,
    target: { projectId: number; agentId: number; panePid: string },
  ): { id: number; session_id: string; baseline_idle_seq: number } => {
    const state = readLeadTurnState(target.agentId);
    const sameLaunch = state !== null && state.pane_pid === target.panePid;
    const sessionId = sameLaunch && state.state !== "unknown" ? state.session_id : "";
    const baseline = state?.idle_seq ?? 0;
    const row = db
      .prepare(
        `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, max_wait_at)
         VALUES (?, ?, ?, ?, '[]', ?, ?, datetime('now', printf('+%d seconds', ?)))
         RETURNING id`,
      )
      .get(homeProjectId, currentActor(), body, `idle_${mode}`, delivery.actor, delivery.pane, maxWait) as { id: number };
    db.prepare(
      `INSERT INTO lead_idle_subscriptions (wake_id, target_project_id, agent_id, pane_pid, session_id, baseline_idle_seq)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, target.projectId, target.agentId, target.panePid, sessionId, baseline);
    return { id: row.id, session_id: sessionId, baseline_idle_seq: baseline };
  },
);

function createLeadWatch(
  leadProjectId: number,
  args: { body: string; mode?: "any" | "all"; max_wait_seconds?: number; deliver_to?: number | string; project_id?: number },
): Record<string, unknown> {
  if (!isQueenLead()) {
    throw new Error(
      `${LEAD_WATCH_QUEEN_ONLY}: lead_project_id is the queen's alone. Only the running queen lead, in its own ` +
        "project and without HIVE_PROJECT_LOCK, may wait on another project's lead; a project's own lead and " +
        "every worker are refused. A worker is watched with agents=[...] or scope=\"project\" instead.",
    );
  }
  if (args.project_id != null || args.deliver_to != null) {
    throw new Error(
      "lead_project_id refuses project_id and deliver_to: the wake is always stored in the queen's own project " +
        "and delivered to the queen's own pane, so neither has anything to choose. Name the watched project " +
        "with lead_project_id alone.",
    );
  }
  const home = effectiveProjectId();
  if (leadProjectId === home) {
    throw new Error("lead_project_id names the queen's own project, and the queen cannot wait on itself.");
  }
  const project = getProject(leadProjectId);
  if (!project) throw new Error(`Unknown project_id ${leadProjectId}. Call project_list to see options.`);
  const lead = runningLeadOf(leadProjectId);
  if (!lead) throw new Error(`${LEAD_TARGET_GONE}: project ${leadProjectId} ("${project.name}") has no running lead to watch.`);
  if (!screenClassifiable(lead.command)) {
    throw new Error(
      `Project ${leadProjectId}'s lead runs ${JSON.stringify(commandHead(lead.command))}, whose screen hive cannot ` +
        "classify, so a turn ending while a human is typing to it could not be told apart from one nobody is at.",
    );
  }
  if (foreignSocket(lead.tmux_socket)) {
    throw new Error(`Project ${leadProjectId}'s lead lives on a tmux socket this process cannot probe.`);
  }
  const snapshot = liveTargets();
  if (observationFailed(snapshot)) throw new Error("tmux did not answer, so the watched lead's pane cannot be verified. Try again.");
  const ownership = rowOwnership(lead, snapshot);
  if (ownership === "unknown") {
    throw new Error(
      `Project ${leadProjectId}'s lead's pane ownership is unknown: it has no recorded pane pid (or a legacy ` +
        "window target), so a reused pane id could not be told from this lead. Restart it with hive lead to record one.",
    );
  }
  if (ownership === "gone") throw new Error(`${LEAD_TARGET_GONE}: project ${leadProjectId}'s lead pane is gone.`);
  if (ownership === "reissued") {
    throw new Error(`${LEAD_TARGET_REISSUED}: project ${leadProjectId}'s lead pane id now belongs to another process.`);
  }

  const mode = args.mode ?? "any";
  const state = readLeadTurnState(lead.id);
  const idleNow = state !== null && state.pane_pid === lead.pane_pid && state.state === "idle";
  if (mode === "all" && idleNow && paneVeto(lead) === null) {
    return {
      status: "already_satisfied",
      note: `Project ${leadProjectId}'s lead has already ended its turn; nothing was scheduled. Read it now.`,
    };
  }
  const delivery = resolveDelivery(home);
  const maxWait = args.max_wait_seconds ?? 900;
  const row = openLeadWatch.immediate(home, args.body, mode, delivery, maxWait, {
    projectId: leadProjectId,
    agentId: lead.id,
    panePid: lead.pane_pid,
  });
  return {
    wake_id: row.id,
    mode,
    lead_watch: {
      project_id: leadProjectId,
      agent_id: lead.id,
      name: lead.name,
      state: state !== null && state.pane_pid === lead.pane_pid ? state.state : "unknown",
      baseline_idle_seq: row.baseline_idle_seq,
    },
    max_wait_seconds: maxWait,
    deliver_to: delivery.actor,
    note:
      (mode === "any"
        ? "Fires on the lead's NEXT turn ending; a turn that already ended does not count. "
        : "Fires once the lead's turn has ended. ") +
      "A turn ending is not the lead finishing its work: read it before acting. A dead, restarted or reissued " +
      "lead pane ends the watch with that reason instead.",
  };
}

function leadWatchFields(t: TimerRow): Record<string, unknown> {
  const sub = leadSubscription(t.id);
  if (sub === null) return {};
  return {
    lead_watch: {
      project_id: sub.target_project_id,
      agent_id: sub.agent_id,
      pane_pid: sub.pane_pid,
      session_id: sub.session_id,
      baseline_idle_seq: sub.baseline_idle_seq,
      ...(sub.terminal_reason !== null ? { terminal_reason: sub.terminal_reason } : {}),
    },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
        return commitQueenStateWrite("wake_set", projectId, args, () => {
          const row = db
            .prepare(
              `INSERT INTO wakes (project_id, owner, body, kind, deliver_actor, deliver_pane, due_at, repeat_every_ms)
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
        });
      }),
  );

  server.registerTool(
    "wake_when_idle",
    {
      description:
        "Wake up when watched agents go idle (exact state from Claude Code hooks) or max_wait_seconds passes - except delivery HOLDS past that bound instead, for as long as the target pane is on a dialog or has unsubmitted human text in it, rather than pasting the wake body into either (.claude/rules/tmux-and-panes.md). Two shapes for workers, plus one for the queen, and you pass EXACTLY ONE of them. agents=[...] is a ONE-SHOT over a named list: mode=any fires on the first fresh idle transition, mode=all fires when every watched agent is idle (returns already_satisfied without scheduling anything if they all are now), and either way it stops watching once it fires. Arming a one-shot of the same mode for the same deliver target and an identical watched set cancels your own older pending one and names it in the receipt's superseded. scope=\"project\" is a STANDING WATCH over the crew you spawn in this project, including workers spawned later: it never stops watching, and on each finish it delivers a roster naming who finished and who is still going, until max_wait_seconds runs out or you wake_cancel it. You may hold ONE standing watch per project: a second call is refused and names the one already running, since two would report every finish twice. Use the standing watch when you are running more than one worker - a one-shot leaves every other worker unwatched from the moment it fires. Use either instead of polling. agents=[...] refuses a lead: it watches worker state, which a lead does not write. lead_project_id is the QUEEN's alone: a one-shot that fires when another registered project's running lead ENDS A TURN (never 'finished its work'), stored in and delivered to the queen's own project, and ended with a named reason if that lead's pane dies, is reissued, or restarts.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
        lead_project_id: idParam
          .optional()
          .describe(
            "QUEEN ONLY: wake when the running lead of this OTHER registered project ends a turn. The wake is " +
              "stored in the queen's own project and delivered only to the queen; the watched lead is read, never " +
              "typed into. Mutually exclusive with agents and scope; refuses project_id and deliver_to.",
          ),
        deliver_to: agentRefParam.optional().describe("Deliver to a spawned agent instead of this session."),
        project_id: projectIdParam,
      },
      outputSchema: {
        status: z.literal("already_satisfied").optional(),
        lead_watch: z.record(z.string(), z.unknown()).optional(),
        wake_id: idParam.optional(),
        scope: z.literal("project").optional(),
        standing: z.boolean().optional(),
        watching_now: z.array(z.string()).optional(),
        superseded: z.array(idParam).optional(),
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

        const selectors = [
          args.agents != null && "agents",
          args.scope != null && "scope",
          args.lead_project_id != null && "lead_project_id",
        ].filter((x): x is string => x !== false);
        if (selectors.length !== 1) {
          throw new Error(
            "wake_when_idle needs exactly one of agents=[...] (a one-shot over a named list), " +
              'scope="project" (a standing watch over this project\'s crew), or lead_project_id (the queen ' +
              "waiting on another project's lead). " +
              (selectors.length === 0
                ? "You passed none."
                : `You passed ${selectors.length === 2 ? "both" : "all of"} ${selectors.join(" and ")}, and they mean different things.`),
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
        if (args.lead_project_id != null) return createLeadWatch(args.lead_project_id, args);
        const mode = args.mode ?? "any";
        const watched = (args.agents ?? []).map((ref) => resolveAgentRef(projectId, ref));

        const leadWatched = watched.find((a) => a.kind === LEAD_KIND);
        if (leadWatched) {
          throw new Error(
            `Agent ${leadWatched.id} ("${leadWatched.name}") is this project's lead session, and agents=[...] ` +
              "watches worker state, which a lead does not write: its hook never moves agent_state. " +
              "wake_when_idle refuses a lead target in agents=[...]; it could only ever fire at max_wait_seconds, " +
              "reported as a timeout instead of the failure it actually is. A lead's turn has its own channel, " +
              "which only the queen may watch, with lead_project_id=<that lead's project id>.",
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
        return commitQueenStateWrite("wake_when_idle", projectId, args, () => db.transaction(() => {
          const watchedIds = watched.map((a) => a.id);
          const sameSet = (json: string) => {
            const ids = JSON.parse(json) as number[];
            return ids.length === watchedIds.length && watchedIds.every((id) => ids.includes(id));
          };
          const candidates = (
            db
              .prepare(
                `SELECT id, watch FROM wakes
                  WHERE project_id = ? AND owner = ? AND kind = ?
                    AND watch_scope IS NULL AND deliver_actor = ? AND deliver_pane = ?
                    AND fired_at IS NULL AND cancelled_at IS NULL
                    AND id NOT IN (SELECT wake_id FROM lead_idle_subscriptions)`,
              )
              .all(projectId, currentActor(), `idle_${mode}`, delivery.actor, delivery.pane) as { id: number; watch: string }[]
          )
            .filter((w) => sameSet(w.watch))
            .map((w) => w.id);
          const superseded = candidates.filter(
            (id) =>
              db
                .prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ? AND cancelled_at IS NULL AND fired_at IS NULL")
                .run(id).changes === 1,
          );
          const info = db
            .prepare(
              `INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane,
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
            ...(superseded.length > 0 ? { superseded } : {}),
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
        }).immediate());
      }),
  );

  server.registerTool(
    "wake_get",
    {
      description:
        "Read one wake-up by id, in this project, with its UNTRUNCATED body. wake_list truncates " +
        "body at 120 chars; use this to see exactly what a wake will say, or to confirm what " +
        "wake_update just changed.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { wake_id: idParam, project_id: projectIdParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const t = db
          .prepare("SELECT * FROM wakes WHERE id = ? AND project_id = ?")
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
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
              `SELECT kind FROM wakes WHERE id = ? AND project_id = ? AND owner = ? AND parent_wake_id IS NULL
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

        return commitQueenStateWrite("wake_update", projectId, args, () => {
          const row = db
            .prepare(
              `UPDATE wakes SET ${sets.join(", ")}
               WHERE id = ? AND project_id = ? AND owner = ? AND parent_wake_id IS NULL AND ${ACTIVE_TIMER_WHERE}
               RETURNING due_at`,
            )
            .get(...params) as { due_at: string } | undefined;
          return { wake_id: args.wake_id, updated: row !== undefined, due_at: row?.due_at ?? null };
        });
      }),
  );

  server.registerTool(
    "wake_cancel",
    {
      description:
        "Cancel a pending wake-up you own, or - if you are a running lead - any pending wake-up in this " +
        "project. Cancelling any wake also cancels the hold notices already filed about IT (modal-hold, " +
        "unsubmitted-input, and one-shot block), since a notice about a wake that no longer exists has " +
        "nothing left to say; unlike a finish notice these never expire on their own, since the thing they " +
        "report may well still be true an hour later. Cancelling a standing watch also cancels the FINISH " +
        "notices it has already filed but not yet delivered. It does NOT cancel a standing watch's own " +
        "per-worker block notice (a crew member stopped on a dialog): that carries no parent link, so one " +
        "already filed still delivers, and it may still be true - the worker is probably still on that " +
        "dialog - but it no longer claims anything about the watch's own liveness, deliberately.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
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
        return commitQueenStateWrite("wake_cancel", projectId, args, () => {
          const info = isLead
            ? db
                .prepare(
                  `UPDATE wakes SET cancelled_at = datetime('now')
                   WHERE id = ? AND project_id = ? AND cancelled_at IS NULL`,
                )
                .run(args.wake_id, projectId)
            : db
                .prepare(
                  `UPDATE wakes SET cancelled_at = datetime('now')
                   WHERE id = ? AND project_id = ? AND owner = ? AND cancelled_at IS NULL`,
                )
                .run(args.wake_id, projectId, currentActor());

          const notices =
            info.changes > 0
              ? db
                  .prepare(
                    `UPDATE wakes SET cancelled_at = datetime('now')
                     WHERE parent_wake_id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
                  )
                  .run(args.wake_id).changes
              : 0;
          return { wake_id: args.wake_id, cancelled: info.changes > 0, cancelled_notices: notices };
        });
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
