import { db } from "./db.js";
import { matchesAnyTag, parseTags } from "./result.js";
import { fallbackSlug } from "./slug.js";
import { OPEN_BLOCKERS_FROM_WHERE } from "./todoScope.js";

export interface TodoRow {
  id: number;
  project_id: number;
  title: string;
  body: string;
  priority: string;
  status: string;
  locked_by: string | null;
  tags: string;
  slug: string;
  created_at: string;
  completed_at: string | null;
  archived_at: string | null;
  updated_at: string;
  open_blockers?: number;
  comment_count?: number;
}

export const COMMENT_COUNT_SQL = `(SELECT COUNT(*) FROM todo_comments c WHERE c.todo_id = t.id)`;

const SUMMARY_SQL = `
  SELECT t.*,
    (SELECT COUNT(*) ${OPEN_BLOCKERS_FROM_WHERE}) AS open_blockers,
    ${COMMENT_COUNT_SQL} AS comment_count
  FROM todos t`;

export function getTodo(projectId: number, todoId: number): TodoRow {
  const row = db
    .prepare(`${SUMMARY_SQL} WHERE t.project_id = ? AND t.id = ?`)
    .get(projectId, todoId) as TodoRow | undefined;
  if (!row) throw new Error(`No todo with id ${todoId} in project ${projectId}. Call todo_list.`);
  return row;
}

export interface TodoSummary {
  todo_id: number;
  title: string;
  slug: string;
  status: string;
  priority: string;
  tags: string[];
  archived: boolean;
  is_blocked: boolean;
  open_blockers: number;
  comment_count: number;
  updated_at: string;
}

function summarize(row: TodoRow): TodoSummary {
  return {
    todo_id: row.id,
    title: row.title,

    slug: row.slug || fallbackSlug(row.title) || `todo ${row.id}`,
    status: row.status,
    priority: row.priority,
    tags: parseTags(row.tags),
    archived: row.archived_at != null,
    is_blocked: (row.open_blockers ?? 0) > 0,
    open_blockers: row.open_blockers ?? 0,
    comment_count: row.comment_count ?? 0,
    updated_at: row.updated_at,
  };
}

export interface TodoListFilter {
  statuses?: string[];
  priority?: string;
  query?: string;
  tags?: string[];
  isBlocked?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export function listTodoSummaries(projectId: number, filter: TodoListFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;
  let sql = `${SUMMARY_SQL} WHERE t.project_id = ?`;
  const params: unknown[] = [projectId];
  if (!filter.includeArchived) {
    sql += " AND t.archived_at IS NULL";
  }
  if (filter.statuses && filter.statuses.length > 0) {
    sql += ` AND t.status IN (${filter.statuses.map(() => "?").join(",")})`;
    params.push(...filter.statuses);
  }
  if (filter.priority) {
    sql += " AND t.priority = ?";
    params.push(filter.priority);
  }
  if (filter.query) {

    sql += " AND (t.title LIKE ? OR t.body LIKE ? OR t.slug LIKE ?)";
    params.push(`%${filter.query}%`, `%${filter.query}%`, `%${filter.query}%`);
  }
  sql += " ORDER BY t.updated_at DESC";
  let rows = (db.prepare(sql).all(...params) as TodoRow[]).filter((r) =>
    matchesAnyTag(r.tags, filter.tags),
  );
  if (filter.isBlocked != null) {
    rows = rows.filter((r) => ((r.open_blockers ?? 0) > 0) === filter.isBlocked);
  }
  return {
    total_count: rows.length,
    offset,
    limit,
    todos: rows.slice(offset, offset + limit).map(summarize),
  };
}

interface TodoRef {
  id: number;
  title: string;
  status: string;
}

interface TodoComment {
  id: number;
  author: string;
  body: string;
  created_at: string;
}

export interface TodoDetail extends TodoSummary {
  body: string;
  created_at: string;
  completed_at: string | null;
  blockers: TodoRef[];
  blocking: TodoRef[];
  comments?: TodoComment[];
}

export function getTodoDetail(projectId: number, todoId: number, includeComments: boolean): TodoDetail {
  const todo = getTodo(projectId, todoId);
  const blockers = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM todo_blockers b
       JOIN todos t ON t.id = b.blocker_id WHERE b.todo_id = ?`,
    )
    .all(todo.id) as TodoRef[];
  const blocking = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM todo_blockers b
       JOIN todos t ON t.id = b.todo_id WHERE b.blocker_id = ?`,
    )
    .all(todo.id) as TodoRef[];
  const result: TodoDetail = {
    ...summarize(todo),
    body: todo.body,
    created_at: todo.created_at,
    completed_at: todo.completed_at,
    blockers,
    blocking,
  };
  if (includeComments) {
    result.comments = db
      .prepare(
        "SELECT id, author, body, created_at FROM todo_comments WHERE todo_id = ? ORDER BY created_at",
      )
      .all(todo.id) as TodoComment[];
  }
  return result;
}
