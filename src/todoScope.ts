export const TODO_STATUSES = ["open", "in_progress", "backlog", "completed"] as const;

export const ACTIVE_TODO_SQL = "t.status IN ('open', 'in_progress') AND t.archived_at IS NULL";

export const NOT_COMPLETED_TODO_SQL = "status != 'completed'";

export const OPEN_BLOCKERS_FROM_WHERE = `FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
   WHERE b.todo_id = t.id AND bt.${NOT_COMPLETED_TODO_SQL}`;

export const OPEN_BLOCKERS_SQL = `SELECT 1 ${OPEN_BLOCKERS_FROM_WHERE}`;
