export const SCHEMA_VERSION = 1;
export const REFRESH_MS = 5000;
export const TIMEOUT_MS = 4000;

export function ago(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export async function readCrew(run, cwd) {
  let res;
  try {
    res = await run(["hive", "crew", "--json"], { cwd, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    throw new Error(`hive crew did not answer: ${String(err instanceof Error ? err.message : err).slice(0, 100)}`);
  }
  if (res.exitCode !== 0) {
    const line = String(res.stderr ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
    throw new Error(line ? line.slice(0, 120) : `hive crew exited ${res.exitCode}`);
  }
  let snap;
  try {
    snap = JSON.parse(res.stdout);
  } catch {
    throw new Error("hive crew returned invalid JSON");
  }
  if (snap === null || typeof snap !== "object" || snap.schema_version !== SCHEMA_VERSION) {
    throw new Error(`hive crew schema ${snap?.schema_version ?? "unknown"} is not ${SCHEMA_VERSION}; update hive`);
  }
  if (!Array.isArray(snap.lanes) || !Array.isArray(snap.needs_you) || snap.wakes === null || typeof snap.wakes !== "object" || !Array.isArray(snap.wakes.watching)) {
    throw new Error("hive crew JSON is missing lanes, needs_you or wakes");
  }
  return snap;
}

export function emptyView() {
  return { header: "", rows: [], needsYou: [], footer: [], error: "", memory: {} };
}

export function failedView(previousView, message) {
  return { ...(previousView ?? emptyView()), error: message };
}

function duration(worker, activity, nowMs, memory, nextMemory) {
  const key = `${worker.id}|${worker.session_id}|${activity.label}`;
  const stamp = activity.since;
  const at = stamp ? Date.parse(stamp) : NaN;
  if (Number.isFinite(at)) return `${activity.lower_bound ? ">=" : ""}${ago((nowMs - at) / 1000)}`;
  const first = memory[key] ?? nowMs;
  nextMemory[key] = first;
  return `~${ago((nowMs - first) / 1000)}`;
}

function workerRow(lane, snapshot, nowMs, memory, nextMemory) {
  const w = lane.worker;
  const checkpoint = snapshot.context_checkpoint_percent;
  const todo = lane.todo;
  const state = w.state === "blocked" ? "blocked" : w.your_turn ? "your turn" : w.state;
  const color = state === "blocked" ? "red" : state === "your turn" ? "yellow" : state === "working" ? "green" : "gray";
  const fill = w.context_fill;
  const head = [w.model || w.harness];
  if (state === "working") head.push(`${w.activity.label} ${duration(w, w.activity, nowMs, memory, nextMemory)}`);
  else {
    const since = state === "blocked" ? null : w.state_changed_at;
    head.push(`${state} ${duration(w, { label: state, since, lower_bound: false }, nowMs, memory, nextMemory)}`);
  }
  const tail = [ago(w.age_seconds)];
  if (w.commits_ahead !== null && w.commits_ahead !== undefined) tail.push(`+${w.commits_ahead} commits`);
  return {
    key: `w${w.id}`,
    color,
    id: todo ? String(todo.id) : "--",
    slug: todo ? todo.slug : `${w.name} unlinked`,
    model: head[0],
    activity: head[1],
    ctx: fill ? `ctx ${Math.round(fill.used_percent)}%` : "ctx ?",
    rest: tail.join(" · "),
    ctxAmber: Boolean(fill) && checkpoint !== null && checkpoint !== undefined && fill.used_percent >= checkpoint,
  };
}

export function buildCrewView(snapshot, previousView, nowMs) {
  const memory = previousView?.memory ?? {};
  const nextMemory = {};
  const rows = snapshot.lanes.map((lane) =>
    lane.worker
      ? workerRow(lane, snapshot, nowMs, memory, nextMemory)
      : { key: `t${lane.todo.id}`, color: "gray", id: String(lane.todo.id), slug: lane.todo.slug, model: "", activity: "unstaffed", ctx: "", rest: "", ctxAmber: false },
  );
  const { wakes } = snapshot;
  const footer = [];
  if (wakes.next) {
    const due = wakes.next.due_at ? Date.parse(wakes.next.due_at) : NaN;
    footer.push(`next: ${wakes.next.label}${Number.isFinite(due) ? ` in ${ago((due - nowMs) / 1000)}` : ""}`);
  } else footer.push("next: none");
  if (wakes.watching.length > 0) footer.push(`watching: ${wakes.watching.map((x) => x.label).join(", ")}`);
  const workers = snapshot.lanes.filter((l) => l.worker).length;
  return {
    header: `${snapshot.project.name} · ${workers} worker${workers === 1 ? "" : "s"}`,
    rows,
    needsYou: snapshot.needs_you.map((t) => ({ id: String(t.id), slug: t.slug })),
    footer,
    error: "",
    memory: nextMemory,
  };
}
