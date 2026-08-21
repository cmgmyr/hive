import { cutToUnitBudget, flatten } from "./slug.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "killed", "error"]);

// Every background_tasks[].type ever observed in a Stop payload, and what hive does with it. "latch"
// withholds the worker's idle; "name" only names it in a standing notice. An unlisted type is
// treated as "name" - see unknownTypeIsNamedNotLatched below.
export const BACKGROUND_TASK_DISPOSITION: Readonly<Record<string, "latch" | "name">> = {
  subagent: "latch",
  shell: "name",
  monitor: "name",
};

export interface LiveBackgroundTask {
  type: string;
  status: string;
  description: string;
}

export function liveBackgroundTasks(tasks: unknown): LiveBackgroundTask[] {
  if (!Array.isArray(tasks)) return [];
  const live: LiveBackgroundTask[] = [];
  for (const entry of tasks) {
    const task = entry as { type?: unknown; status?: unknown; description?: unknown } | null;
    const status = String(task?.status ?? "");
    if (TERMINAL_STATUSES.has(status)) continue;
    live.push({
      type: String(task?.type ?? ""),
      status,
      description: String(task?.description ?? ""),
    });
  }
  return live;
}

export const withholdsIdle = (task: LiveBackgroundTask): boolean =>
  BACKGROUND_TASK_DISPOSITION[task.type] === "latch";

const typeOf = (task: LiveBackgroundTask): string => flatten(task.type) || "unknown";

const groupsOf = (tasks: LiveBackgroundTask[]): string[] => [...new Set(tasks.map(typeOf))].sort();

export function describeLiveTasks(tasks: LiveBackgroundTask[]): string {
  const types = groupsOf(tasks);
  const plural = tasks.length === 1 ? "" : "s";
  return types.length === 1
    ? `${tasks.length} background ${types[0]}${plural}`
    : `${tasks.length} background task${plural} (${types.join(", ")})`;
}

const DESCRIPTION_BUDGET = 80;

export function describeOneTask(task: LiveBackgroundTask): string {
  const flat = flatten(task.description);
  if (flat === "") return typeOf(task);
  const text = flat.length > DESCRIPTION_BUDGET ? `${cutToUnitBudget(flat, DESCRIPTION_BUDGET)}…` : flat;
  return `${typeOf(task)}: "${text}"`;
}
