import { db } from "./db.js";
import { LEAD_KIND } from "./agentKinds.js";
import { observationFailed, observeRowOwnership, ownershipLiveness, rowOwnership, type AliveSnapshot, type Liveness, type RowOwnership } from "./tmux.js";

export interface AgentRow {
  id: number;
  project_id: number;
  actor_id: string;
  name: string;
  tmux_target: string;
  tmux_socket: string;
  pane_pid: string;
  command: string;
  cwd: string;
  parent_actor_id: string | null;
  status: string;
  created_at: string;
  closed_at: string | null;
  agent_state: string;
  state_changed_at: string | null;
  kind: string;
  session_id: string;
  transcript_path: string;
  parked_at: string;
  parked_branch: string;
  resumed_at: string;
  codex_home: string;
  exit_tail: string;
  model: string | null;
  extra_args: string | null;
  claude_messaging_socket: string;
  claude_messaging_pane_pid: string;
  todo_id: number | null;
}

export const CLOSED_ROW_ORDER = "(parked_at != '') DESC, closed_at DESC, id DESC";

export function getAgentRow(projectId: number, id: number, notFoundHint: string): AgentRow {
  const row = db.prepare("SELECT * FROM agents WHERE project_id = ? AND id = ?").get(projectId, id) as
    | AgentRow
    | undefined;
  if (!row) throw new Error(`No agent ${id} in project ${projectId}. ${notFoundHint}`);
  return row;
}

function closedAgentNamed(
  projectId: number,
  needle: string,
): { id: number; name: string; kind: string; parked_at: string } | undefined {
  return (
    db
      .prepare(
        `SELECT id, name, kind, parked_at FROM agents WHERE project_id = ? AND status != 'running' ORDER BY ${CLOSED_ROW_ORDER}`,
      )
      .all(projectId) as { id: number; name: string; kind: string; parked_at: string }[]
  ).find((r) => r.name.toLowerCase() === needle);
}

export function findAgent(projectId: number, ref: { agent_id?: number; name?: string }): AgentRow {
  if (ref.agent_id != null) {
    return getAgentRow(projectId, ref.agent_id, "Call agent_list.");
  }
  if (ref.name) {
    const rows = db
      .prepare("SELECT * FROM agents WHERE project_id = ? AND status = 'running' ORDER BY id")
      .all(projectId) as AgentRow[];

    const exact = rows.filter((r) => r.name === ref.name);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`Multiple running agents named "${ref.name}". Target by agent_id instead.`);
    }

    const needle = ref.name.toLowerCase();
    const sameName = rows.filter((r) => r.name.toLowerCase() === needle);
    if (sameName.length === 1) return sameName[0];

    const closed = closedAgentNamed(projectId, needle);
    if (closed) {

      if (closed.parked_at) {
        throw new Error(
          `Agent ${closed.id} ("${closed.name}") is PARKED, not finished - it was paused on ` +
            `${closed.parked_at} and its session is waiting. Bring it back with agent_resume(agent_id: ` +
            `${closed.id}), or abandon the park with agent_close(agent_id: ${closed.id}).`,
        );
      }
      const remedy = closed.kind === LEAD_KIND ? "Run `hive lead` to start a new one" : "Spawn a new worker";
      throw new Error(
        `Agent ${closed.id} ("${closed.name}") is closed. ${remedy}, or target a running one by name or agent_id.`,
      );
    }

    const partial = rows.filter((r) => r.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const candidates = partial.map((r) => `${r.name} (agent_id ${r.id})`).join(", ");
      throw new Error(
        `"${ref.name}" matches ${partial.length} running agents: ${candidates}. Use the full name or agent_id.`,
      );
    }

    if (/^\d+$/.test(ref.name)) {
      const id = Number(ref.name);
      if (Number.isSafeInteger(id)) {
        const byId = db
          .prepare("SELECT * FROM agents WHERE project_id = ? AND id = ? AND status = 'running'")
          .get(projectId, id) as AgentRow | undefined;
        if (byId) return byId;
      }
    } else if (/^[a-z]+:\d+$/i.test(ref.name)) {
      const byActorId = db
        .prepare("SELECT * FROM agents WHERE project_id = ? AND actor_id = ? AND status = 'running'")
        .get(projectId, ref.name) as AgentRow | undefined;
      if (byActorId) return byActorId;
    }

    throw new Error(`No running agent matching "${ref.name}" in project ${projectId}. Call agent_list.`);
  }
  throw new Error("Pass agent_id or name.");
}

export const PROBE_FAILED_NOTE =
  "tmux could not be probed, so liveness is unknown. Nothing was changed. Retry in a few seconds.";

const unknownOwnershipNote = (snapshot: AliveSnapshot | null): string =>
  observationFailed(snapshot) ? PROBE_FAILED_NOTE : UNVERIFIED_OWNERSHIP_NOTE;

export const UNVERIFIED_OWNERSHIP_NOTE =
  "This row's pane cannot be verified as its own: it is on another tmux socket, or no pane pid was recorded for it, so liveness is unknown and no screen was read. Nothing was changed. If the row is stale, a human or peer lead can retire it with agent_close(row_only=true).";

export const probeFailed = (agent: AgentRow) =>
  new Error(`Agent ${agent.id} ("${agent.name}"): ${PROBE_FAILED_NOTE}`);

// A failed probe throws rather than answering unknown, so callers keep the retry wording.
export function observeOwnership(agent: AgentRow): RowOwnership {
  const ownership = observeRowOwnership(agent);
  if (ownership === "probe-failed") throw probeFailed(agent);
  return ownership;
}

export const REISSUED_PANE_NOTE =
  "Its recorded pane id now belongs to a different process (the recorded pane pid no longer matches), so its own process is gone and the pane is someone else's. Nothing was typed, read or killed there.";

export function notOwnedError(agent: AgentRow, ownership: Exclude<RowOwnership, "live">): Error {
  const who = `Agent ${agent.id} ("${agent.name}")`;
  if (ownership === "gone") {
    return new Error(
      `${who} has no live tmux window (its process exited or the window was killed). Close it with agent_close and spawn a new one.`,
    );
  }
  if (ownership === "reissued") {
    return new Error(
      `${who}: pane ownership reads reissued. ${REISSUED_PANE_NOTE} Close the row with agent_close, which retires it without touching that pane.`,
    );
  }
  return new Error(`${who}: pane ownership reads unknown. ${UNVERIFIED_OWNERSHIP_NOTE}`);
}

export function summaryLiveness(row: AgentRow, snapshot?: AliveSnapshot | null): Liveness {
  if (row.status !== "running") return false;
  return ownershipLiveness(rowOwnership(row, snapshot));
}

