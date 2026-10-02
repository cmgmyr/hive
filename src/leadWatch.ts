import { db } from "./db.js";
import { paneClassifierFor } from "./harnesses.js";
import { readLeadTurnState } from "./leadState.js";
import { LEAD_KIND } from "./spawn.js";
import { foreignSocket, holdsHumanInput, observationFailed, rowOwnership, type AliveSnapshot } from "./tmux.js";

export const LEAD_TARGET_GONE = "LEAD_TARGET_GONE";
export const LEAD_TARGET_REISSUED = "LEAD_TARGET_REISSUED";
export const LEAD_TARGET_RESTARTED = "LEAD_TARGET_RESTARTED";

export interface LeadIdleSubscription {
  wake_id: number;
  target_project_id: number;
  agent_id: number;
  pane_pid: string;
  session_id: string;
  baseline_idle_seq: number;
  terminal_reason: string | null;
}

export interface WatchedLead {
  id: number;
  name: string;
  status: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
  command: string;
}

export type LeadWatchResult =
  | { kind: "idle"; idle_seq: number }
  | { kind: "pending"; reason: string }
  | { kind: "invalid"; reason: string };

export interface PaneReaders {
  awaitingChoice: (pane: string, command: string) => boolean | null;
  holdsInput: (pane: string, command: string) => boolean;
}

const directPaneReaders: PaneReaders = {
  awaitingChoice: (pane, command) => paneClassifierFor(command)?.choiceCheck(pane).awaitingChoice ?? null,
  holdsInput: (pane, command) => holdsHumanInput(paneClassifierFor(command)?.inputBoxState(pane) ?? null),
};

export function leadSubscription(wakeId: number): LeadIdleSubscription | null {
  return (
    (db.prepare("SELECT * FROM lead_idle_subscriptions WHERE wake_id = ?").get(wakeId) as LeadIdleSubscription | undefined) ??
    null
  );
}

export function runningLeadOf(projectId: number): WatchedLead | null {
  return (
    (db
      .prepare(
        `SELECT id, name, status, tmux_target, tmux_socket, pane_pid, command FROM agents
          WHERE project_id = ? AND kind = ? AND status = 'running' ORDER BY id LIMIT 1`,
      )
      .get(projectId, LEAD_KIND) as WatchedLead | undefined) ?? null
  );
}

// Reads the watched lead's screen only to stay quiet; it can never make a lead read idle.
export function paneVeto(lead: WatchedLead, readers: PaneReaders = directPaneReaders): string | null {
  const choice = readers.awaitingChoice(lead.tmux_target, lead.command);
  if (choice === true) return "it is on a dialog";
  if (choice === null) return "its screen could not be read";
  if (readers.holdsInput(lead.tmux_target, lead.command)) return "it has unsubmitted text in its input box";
  return null;
}

export function evaluateLeadWatch(
  sub: LeadIdleSubscription,
  mode: "any" | "all",
  snapshot: AliveSnapshot | null,
  readers: PaneReaders,
): LeadWatchResult {
  const lead = db
    .prepare("SELECT id, name, status, tmux_target, tmux_socket, pane_pid, command FROM agents WHERE id = ? AND kind = ?")
    .get(sub.agent_id, LEAD_KIND) as WatchedLead | undefined;
  if (!lead || lead.status !== "running") return { kind: "invalid", reason: LEAD_TARGET_GONE };
  if (lead.pane_pid !== sub.pane_pid) return { kind: "invalid", reason: LEAD_TARGET_RESTARTED };
  if (foreignSocket(lead.tmux_socket)) return { kind: "pending", reason: "its pane cannot be probed from this process" };
  if (observationFailed(snapshot)) return { kind: "pending", reason: "tmux did not answer" };
  const ownership = rowOwnership(lead, snapshot);
  if (ownership === "unknown") return { kind: "pending", reason: "pane ownership unknown" };
  if (ownership === "gone") return { kind: "invalid", reason: LEAD_TARGET_GONE };
  if (ownership === "reissued") return { kind: "invalid", reason: LEAD_TARGET_REISSUED };

  const state = readLeadTurnState(lead.id);
  if (state === null || state.pane_pid !== sub.pane_pid) return { kind: "pending", reason: "no turn recorded yet" };
  let session = sub.session_id;
  if (session === "" && state.state !== "unknown") {
    session = state.session_id;
    try {
      db.prepare("UPDATE lead_idle_subscriptions SET session_id = ? WHERE wake_id = ? AND session_id = ''").run(session, sub.wake_id);
    } catch {
      // Unbound for another tick; the in-memory binding still judges this one.
    }
  }
  if (session !== "" && state.session_id !== session) return { kind: "invalid", reason: LEAD_TARGET_RESTARTED };
  const ended = mode === "any" ? state.idle_seq > sub.baseline_idle_seq : state.state === "idle";
  if (!ended) return { kind: "pending", reason: `its turn state is ${state.state}` };
  const vetoed = paneVeto(lead, readers);
  if (vetoed !== null) return { kind: "pending", reason: `its turn ended, but ${vetoed}` };
  return { kind: "idle", idle_seq: state.idle_seq };
}
