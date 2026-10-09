import {
  HELD_REASON_CONVERSATION,
  HELD_REASON_LEAD_PANE_DEAD,
  isLeadRowClosedHold,
  isUnclassifiablePaneHold,
  isUnsubmittedInputHold,
  wasHeldForPaneIdentity,
} from "./scheduler.js";

// test/docs.test.mjs fails if a label here is missing from docs/install.md. It checks
// presence only: docs/install.md also counts the set in prose, and nothing guards that number.
export const HELD_REASON_LABELS = ["typing", "talking", "needs you", "blocked"] as const;

export function heldReasonLabel(heldReason: string | null): (typeof HELD_REASON_LABELS)[number] {
  if (isUnsubmittedInputHold(heldReason)) return "typing";
  if (
    heldReason === HELD_REASON_LEAD_PANE_DEAD ||
    wasHeldForPaneIdentity(heldReason) ||
    isLeadRowClosedHold(heldReason) ||
    isUnclassifiablePaneHold(heldReason)
  ) {
    return "needs you";
  }
  if (heldReason === HELD_REASON_CONVERSATION) return "talking";
  return "blocked";
}
