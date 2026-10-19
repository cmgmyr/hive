export const DELIVERY_METHOD = {
  socket: "socket",
  socketRepeating: "socket-repeating",
  pty: "pty",
  ptyAfterSocketTimeout: "pty-after-socket-timeout",
} as const;

export function activeWakeWhere(prefix = ""): string {
  return `${prefix}cancelled_at IS NULL AND (${prefix}fired_at IS NULL OR ${prefix}repeat_every_ms IS NOT NULL)`;
}

export const ACTIVE_TIMER_WHERE = activeWakeWhere();
export const LOG_RETENTION = "-7 days";
export const NOTICE_RETRY_AFTER = "-60 seconds";

export function pendingOneShotWhere(prefix = ""): string {
  return `${prefix}cancelled_at IS NULL AND ${prefix}fired_at IS NULL`;
}

export function firedOneShotWhere(prefix = ""): string {
  return `${prefix}cancelled_at IS NULL AND ${prefix}fired_at IS NOT NULL AND ${prefix}repeat_every_ms IS NULL`;
}

export function heldWakeWhere(prefix = ""): string {
  return `${prefix}held_at IS NOT NULL`;
}

export function sentWakeAtSql(prefix = ""): string {
  return `COALESCE(${prefix}socket_attempt_at, ${prefix}typed_at)`;
}

export function schedulerCandidateWhere(prefix = ""): string {
  return `${prefix}cancelled_at IS NULL AND (
         (${prefix}kind = 'delay' AND ${prefix}due_at <= datetime('now')
           AND (${prefix}fired_at IS NULL OR ${prefix}repeat_every_ms IS NOT NULL))
         OR (${prefix}kind != 'delay' AND ${prefix}fired_at IS NULL)
       )`;
}

export const socketAwaitingWhere = (prefix = ""): string =>
  `${prefix}delivery_method = '${DELIVERY_METHOD.socket}' AND ${prefix}confirmed_at IS NULL AND ${prefix}typed_at IS NULL AND ${prefix}cancelled_at IS NULL`;

export const currentAttempt = (prefix = ""): string =>
  `${prefix}socket_attempt_at IS NOT NULL AND ${prefix}confirmed_at IS NULL AND ${prefix}typed_at IS NULL AND ${prefix}cancelled_at IS NULL
   AND ${prefix}fired_at IS NOT NULL AND ${prefix}socket_attempt_at >= ${prefix}fired_at`;

export const repeatingSocketAwaitingWhere = (prefix = ""): string =>
  `${prefix}delivery_method = '${DELIVERY_METHOD.socketRepeating}' AND ${currentAttempt(prefix)}`;

export const FIRING_DROPPED_NOTE = "dropped";

export const repeatingFallbackClaimedWhere = (prefix = ""): string =>
  `${prefix}repeat_every_ms IS NOT NULL AND ${prefix}delivery_method = '${DELIVERY_METHOD.ptyAfterSocketTimeout}' AND ${currentAttempt(prefix)}
   AND ${prefix}socket_delivery_note IS NOT '${FIRING_DROPPED_NOTE}'`;

export const repeatingFiringPendingWhere = (prefix = ""): string =>
  `((${repeatingSocketAwaitingWhere(prefix)}) OR (${repeatingFallbackClaimedWhere(prefix)}))
  AND ${prefix}socket_attempt_at >= datetime('now', '${LOG_RETENTION}')`;

export const repeatingSocketFiringWhere = (prefix = ""): string =>
  `${prefix}repeat_every_ms IS NOT NULL AND COALESCE(${prefix}delivery_method, '') IN ('${DELIVERY_METHOD.socketRepeating}', '${DELIVERY_METHOD.ptyAfterSocketTimeout}')`;

export function spentUntypedNotice(alias: string): string {
  return `${alias}.fired_at IS NOT NULL AND COALESCE(${alias}.typed_at, ${alias}.socket_attempt_at) IS NULL ` +
    `AND ${alias}.cancelled_at IS NULL AND ${alias}.fired_at < datetime('now', '${NOTICE_RETRY_AFTER}')`;
}

export function watchWatchingWhere(prefix = ""): string {
  return `${prefix}cancelled_at IS NULL AND ${prefix}fired_at IS NULL
             AND (${prefix}max_wait_at IS NULL OR ${prefix}max_wait_at > datetime('now'))`;
}

export function handoffSocketInFlightWhere(prefix = ""): string {
  return `${prefix}fired_at IS NOT NULL AND ${prefix}cancelled_at IS NULL
        AND ${prefix}delivery_method LIKE 'socket%' AND ${prefix}confirmed_at IS NULL
        AND ${prefix}socket_attempt_at >= datetime('now', ?)`;
}

export function holdableWakeWhere(prefix = ""): string {
  return `${prefix}cancelled_at IS NULL
       AND (${prefix}fired_at IS NULL OR (${prefix}repeat_every_ms IS NOT NULL AND ${prefix}due_at = ? AND (? IS NULL OR ${prefix}fire_count = ?))
         OR (${socketAwaitingWhere(prefix)}))`;
}

export type ConfirmationStatus = "confirmed" | "unconfirmed" | "unconfirmed_busy" | "no_confirmation_channel";

export function wakeConfirmation(
  row: { typed_at: string | null; socket_attempt_at: string | null; confirmed_at: string | null; typed_busy: number | null },
  hasChannel: boolean,
): ConfirmationStatus | null {
  if (row.typed_at == null && row.socket_attempt_at == null) return null;
  if (row.confirmed_at != null) return "confirmed";
  if (!hasChannel) return "no_confirmation_channel";
  if (row.typed_busy === 1) return "unconfirmed_busy";
  return "unconfirmed";
}

export const HELD_REASON_MODAL_CHOICE = "pane is awaiting a modal choice (folder-trust or /model picker)";
export const HELD_REASON_LEAD_BOOT_INPUT_BOX = "the lead's input box is not on screen yet; holding while its session starts";
export const HELD_REASON_LEAD_PANE_DEAD =
  "the lead's pane is not live right now (likely mid-restart); lead-owned wakes are exempt from " +
  "cancellation for this alone, so it is held rather than lost";

export const HELD_REASON_PANE_REISSUED_PREFIX =
  "the pane id recorded for this wake now belongs to a different pane than the one it was set " +
  "against (its pid no longer matches, most likely a tmux server restart reissuing the id); held " +
  "rather than typed into the wrong pane - ";
export const HELD_REASON_PANE_REISSUED_LEAD =
  `${HELD_REASON_PANE_REISSUED_PREFIX}run \`hive lead\` to re-point it at the live one`;
export const HELD_REASON_PANE_REISSUED_WORKER =
  `${HELD_REASON_PANE_REISSUED_PREFIX}nothing re-points a worker's wake automatically, so cancel ` +
  "it with wake_cancel and set a fresh one once the worker's pane is confirmed live, or leave it: " +
  "it will keep holding rather than deliver wrongly";
export const HELD_REASON_PANE_REISSUED_THEN_DEAD =
  `${HELD_REASON_PANE_REISSUED_PREFIX}the pane it was reissued to has since gone dead too; nothing ` +
  "re-points a worker's wake automatically, so cancel it with wake_cancel (any running lead may do " +
  "this even though the wake is not theirs) if it is no longer needed";

export function wasHeldForPaneReissue(heldReason: string | null): boolean {
  return heldReason != null && heldReason.startsWith(HELD_REASON_PANE_REISSUED_PREFIX);
}

export const HELD_REASON_PANE_UNKNOWN_PREFIX =
  "pane ownership for this wake's row cannot be verified (no pane pid was recorded for it, its row now " +
  "records a different pane, or the pane is on another tmux socket); held rather than typed into a pane " +
  "that may not be its own - ";
export const HELD_REASON_PANE_UNKNOWN_LEAD =
  `${HELD_REASON_PANE_UNKNOWN_PREFIX}run \`hive lead\` to start or adopt a lead with a recorded pane and re-point it`;
export const HELD_REASON_PANE_UNKNOWN_WORKER =
  `${HELD_REASON_PANE_UNKNOWN_PREFIX}nothing re-points a worker's wake automatically, so cancel it with ` +
  "wake_cancel (any running lead may, even though the wake is not theirs), or leave it: it keeps holding " +
  "rather than deliver wrongly";
export const HELD_REASON_PANE_UNKNOWN_THEN_DEAD =
  `${HELD_REASON_PANE_UNKNOWN_PREFIX}that pane has since gone dead too; nothing re-points a worker's wake ` +
  "automatically, so cancel it with wake_cancel (any running lead may) if it is no longer needed";

export function wasHeldForPaneIdentity(heldReason: string | null): boolean {
  return wasHeldForPaneReissue(heldReason) || (heldReason?.startsWith(HELD_REASON_PANE_UNKNOWN_PREFIX) ?? false);
}

export const identityThenDead = (heldReason: string | null): string =>
  wasHeldForPaneReissue(heldReason) ? HELD_REASON_PANE_REISSUED_THEN_DEAD : HELD_REASON_PANE_UNKNOWN_THEN_DEAD;

export const HELD_REASON_ACTOR_CLOSED =
  "delivery actor closed: the row this wake was bound to is closed, so nothing was typed and the wake was " +
  "cancelled rather than delivered into a pane that row no longer owns";
export const HELD_REASON_LEAD_ROW_CLOSED =
  "the lead's row is closed, so no pane is this wake's to type into; held until `hive lead` starts or adopts a " +
  "lead and re-points it";

export function isLeadRowClosedHold(heldReason: string | null): boolean {
  return heldReason === HELD_REASON_LEAD_ROW_CLOSED;
}

export const HELD_REASON_OWNERSHIP_LOST_AFTER_CLAIM = "delivery stopped after claim: ";
export const HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX = "the pane's harness is not one hive can classify; ";
export const HELD_REASON_UNCLASSIFIABLE_PANE =
  `${HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX}neither the dialog guard nor the unsubmitted-text ` +
  "guard can read this screen and delivery would type blind. wake_set and wake_when_idle refuse such a " +
  "target outright now, so this wake predates that or its pane's command changed underneath it. Nothing " +
  "hive does on its own clears this: it lifts only when that pane is replaced by one hive starts itself " +
  "(`hive lead` after the pane exits). Cancel it with wake_cancel (any running lead may, even though the " +
  "wake is not theirs) and drive that pane with agent_send(keys: [...])";

export function isUnclassifiablePaneHold(heldReason: string | null): boolean {
  return heldReason != null && heldReason.startsWith(HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX);
}

export const HELD_REASON_COPY_MODE =
  "the pane is in tmux copy mode; tmux clears its bracketed-paste flag there, so the body would arrive " +
  "with no paste markers (losing everything before the last 1022-byte write) and the Enter would be " +
  "eaten by the mode instead of submitting - both silently, with tmux reporting success. It delivers " +
  "once whoever is reading that pane leaves copy mode";
export const HELD_REASON_UNSUBMITTED_INPUT_PREFIX = "the pane's input box has unsubmitted human text; ";
export const HELD_REASON_UNSUBMITTED_INPUT =
  `${HELD_REASON_UNSUBMITTED_INPUT_PREFIX}delivering now would paste the wake body onto it and submit ` +
  "both as one message";
export const HELD_REASON_UNSUBMITTED_INPUT_OWNER_UNRESOLVED =
  `${HELD_REASON_UNSUBMITTED_INPUT_PREFIX}hive could not resolve a live pane for the wake's owner on ` +
  "this tick - retrying, since that may be transient rather than permanent";

export function isUnsubmittedInputHold(heldReason: string | null): boolean {
  return heldReason != null && heldReason.startsWith(HELD_REASON_UNSUBMITTED_INPUT_PREFIX);
}

export const HELD_REASON_CONVERSATION =
  "a human talked to this lead more recently than the conversation-hold window; holding so a wake " +
  "does not split an in-progress discussion - it delivers once the window passes or the hold's own " +
  "ceiling is reached, whichever comes first";

export const HELD_REASON_HANDOFF =
  "the lead is handing off to a fresh session; held through the wind-down and the successor's boot, and delivered to " +
  "the lead row once the successor completes its first turn, or when the handoff fails or releases its hold";
