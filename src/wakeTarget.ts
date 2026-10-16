import { db } from "./db.js";
import { captureQueenWriteIdentity, currentActor, resolveQueenLeadTarget } from "./context.js";
import { findAgent, observeOwnership, notOwnedError, type AgentRow } from "./agentRecords.js";
import { commandHead, screenClassifiable } from "./harnesses.js";
import { findUnsafeControlChar, TEXT_ALLOWED_CONTROL_CHARS } from "./tmux.js";

export function resolveAgentRef(projectId: number, ref: number | string): AgentRow {
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

export function resolveWakeDelivery(
  projectId: number,
  deliverTo?: number | string,
  queenOperation?: "wake_set" | "wake_when_idle",
): { actor: string; pane: string } {
  if (deliverTo != null) {
    const agent = queenOperation
      ? resolveQueenLeadTarget(queenOperation, projectId, deliverTo, () => resolveAgentRef(projectId, deliverTo))
      : resolveAgentRef(projectId, deliverTo);
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
  if (queenOperation && !own && captureQueenWriteIdentity(projectId)) {
    resolveQueenLeadTarget<AgentRow>(queenOperation, projectId, deliverTo, () => {
      throw new Error("the calling session has no running agent row to receive this wake");
    });
  }
  // Checked on the ROW, not behind the liveness probe: isLive is three-state, and letting a null
  // fall through to the TMUX_PANE branch below accepts a wake the scheduler will then hold forever
  // against that same row's command - the never-firing timer this refusal exists to prevent.
  const target =
    own && queenOperation ? resolveQueenLeadTarget(queenOperation, projectId, deliverTo, () => own) : own;
  if (target) refuseUnclassifiableTarget(target);
  if (target) {
    const ownership = observeOwnership(target);
    if (ownership === "live") return { actor, pane: target.tmux_target };
    // Unknown never falls through to the ambient pane: that would bind this row's actor to a pane it may not own.
    if (ownership === "unknown") throw notOwnedError(target, ownership);
  }
  const pane = process.env.TMUX_PANE;
  if (pane) return { actor, pane };
  throw new Error(
    "This session cannot receive wake-ups: it is not running inside tmux, so nothing can be typed into its terminal. Start the lead inside tmux (run tmux, then claude; watch with tmux attach, or tmux -CC attach for iTerm's native windows), or pass deliver_to targeting a spawned agent.",
  );
}

export function assertSafeWakeBody(body: string): void {
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

