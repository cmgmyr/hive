import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId, resolveProject } from "../context.js";
import { matchesAnyTag, parseTags, run } from "../result.js";
import { projectIdParam } from "./params.js";

interface TodoRow {
  id: number;
  project_id: number;
  title: string;
  body: string;
  priority: string;
  status: string;
  locked_by: string | null;
  tags: string;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
  open_blockers?: number;
  comment_count?: number;
}

const priorityParam = z.enum(["high", "medium", "low"]);
// Shared with the CLI (hive todos --status): one list of valid statuses, so
// a status the MCP schema would reject can't slip past the CLI's own check
// and read as "you have no todos" instead of "that isn't a status".
export const TODO_STATUSES = ["open", "in_progress", "backlog", "completed"] as const;
const statusParam = z.enum(TODO_STATUSES);

// What "blocked" means, in one place. Correlates on t.id, so every caller
// spells its own status filter and reads dispatchability the same way:
// todo_list(is_blocked=false), hive statusline, and the kickoff digest all
// have to agree or the lead is reconciling numbers hive disagrees with itself
// about. Same shape as ACTIVE_TIMER_WHERE in scheduler.ts.
export const OPEN_BLOCKERS_SQL = `SELECT 1 FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
   WHERE b.todo_id = t.id AND bt.status != 'completed'`;

const SUMMARY_SQL = `
  SELECT t.*,
    (SELECT COUNT(*) FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
      WHERE b.todo_id = t.id AND bt.status != 'completed') AS open_blockers,
    (SELECT COUNT(*) FROM todo_comments c WHERE c.todo_id = t.id) AS comment_count
  FROM todos t`;

function getTodo(projectId: number, todoId: number): TodoRow {
  const row = db
    .prepare(`${SUMMARY_SQL} WHERE t.project_id = ? AND t.id = ?`)
    .get(projectId, todoId) as TodoRow | undefined;
  if (!row) throw new Error(`No todo with id ${todoId} in project ${projectId}. Call todo_list.`);
  return row;
}

// Shared with the CLI: the list-row shape both `hive todos` and `hive todo
// <id>` build on.
export interface TodoSummary {
  todo_id: number;
  title: string;
  status: string;
  priority: string;
  tags: string[];
  is_blocked: boolean;
  open_blockers: number;
  comment_count: number;
  updated_at: string;
}

function summarize(row: TodoRow): TodoSummary {
  return {
    todo_id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    tags: parseTags(row.tags),
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
  limit?: number;
  offset?: number;
}

// Shared with the CLI (hive todos): the same status/priority/query/tag/blocked
// filtering todo_list uses, so the two surfaces cannot disagree about what
// "dispatchable" or "matches" means. `statuses` is a set, not todo_list's
// single `status` param: the CLI's default view is "open or in_progress"
// together, which an exact-match `status` cannot express, so the MCP handler
// below passes a one-element array to stay behaviour-identical.
export function listTodoSummaries(projectId: number, filter: TodoListFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;
  let sql = `${SUMMARY_SQL} WHERE t.project_id = ?`;
  const params: unknown[] = [projectId];
  if (filter.statuses && filter.statuses.length > 0) {
    sql += ` AND t.status IN (${filter.statuses.map(() => "?").join(",")})`;
    params.push(...filter.statuses);
  }
  if (filter.priority) {
    sql += " AND t.priority = ?";
    params.push(filter.priority);
  }
  if (filter.query) {
    sql += " AND (t.title LIKE ? OR t.body LIKE ?)";
    params.push(`%${filter.query}%`, `%${filter.query}%`);
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

// Shared with the CLI (hive todo <id>): full detail, comments included when
// asked. Throws when the id is unknown in this project; the CLI catches that
// to print its own usage line rather than a stack trace.
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

function transitiveBlockers(startId: number): Set<number> {
  const seen = new Set<number>();
  const stack = [startId];
  const stmt = db.prepare("SELECT blocker_id FROM todo_blockers WHERE todo_id = ?");
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const row of stmt.all(current) as { blocker_id: number }[]) {
      if (!seen.has(row.blocker_id)) {
        seen.add(row.blocker_id);
        stack.push(row.blocker_id);
      }
    }
  }
  return seen;
}

function addBlocker(projectId: number, todoId: number, blockerId: number): void {
  if (todoId === blockerId) throw new Error("A todo cannot block itself.");
  getTodo(projectId, todoId);
  getTodo(projectId, blockerId);
  if (transitiveBlockers(blockerId).has(todoId)) {
    throw new Error(
      `Adding blocker ${blockerId} to todo ${todoId} would create a dependency cycle.`,
    );
  }
  db.prepare(
    "INSERT OR IGNORE INTO todo_blockers (todo_id, blocker_id) VALUES (?, ?)",
  ).run(todoId, blockerId);
}

function touch(todoId: number): void {
  db.prepare("UPDATE todos SET updated_at = datetime('now') WHERE id = ?").run(todoId);
}

export function registerTodos(server: McpServer): void {
  server.registerTool(
    "todo_create",
    {
      description:
        "Create a project-scoped todo. Optionally pass blocked_by todo ids to encode ordering. Returns a slim receipt.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional().describe("Objective, owned files, acceptance criteria."),
        priority: priorityParam.optional(),
        tags: z.array(z.string()).optional(),
        blocked_by: z.array(z.number().int()).optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        currentActor();
        const info = db
          .prepare(
            "INSERT INTO todos (project_id, title, body, priority, tags) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            projectId,
            args.title,
            args.body ?? "",
            args.priority ?? "medium",
            JSON.stringify(args.tags ?? []),
          );
        const todoId = Number(info.lastInsertRowid);
        for (const blockerId of args.blocked_by ?? []) {
          addBlocker(projectId, todoId, blockerId);
        }
        return { project_id: projectId, todo_id: todoId };
      }),
  );

  server.registerTool(
    "todo_list",
    {
      description:
        "List todo summaries. is_blocked=false finds dispatchable work. query matches title and body.",
      inputSchema: {
        status: statusParam.optional(),
        is_blocked: z.boolean().optional(),
        priority: priorityParam.optional(),
        query: z.string().optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const project = resolveProject(args.project_id);
        const result = listTodoSummaries(project.id, {
          statuses: args.status ? [args.status] : undefined,
          priority: args.priority,
          query: args.query,
          tags: args.tags,
          isBlocked: args.is_blocked,
          limit: args.limit,
          offset: args.offset,
        });
        return {
          project_id: project.id,
          project_name: project.name,
          ...result,
        };
      }),
  );

  server.registerTool(
    "todo_get",
    {
      description: "Read one todo in full: body, blockers, what it blocks, and optionally comments.",
      inputSchema: {
        todo_id: z.number().int(),
        include_comments: z.boolean().optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        return getTodoDetail(projectId, args.todo_id, args.include_comments ?? false);
      }),
  );

  server.registerTool(
    "todo_update",
    {
      description: "Update todo fields. Omitted fields are preserved. Returns a slim receipt.",
      inputSchema: {
        todo_id: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        priority: priorityParam.optional(),
        status: statusParam.optional(),
        tags: z.array(z.string()).optional(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const todo = getTodo(projectId, args.todo_id);
        currentActor();
        db.prepare(
          `UPDATE todos SET
             title = COALESCE(?, title),
             body = COALESCE(?, body),
             priority = COALESCE(?, priority),
             status = COALESCE(?, status),
             tags = COALESCE(?, tags),
             completed_at = CASE WHEN ? = 'completed' THEN datetime('now')
                                 WHEN ? IS NOT NULL THEN NULL
                                 ELSE completed_at END,
             updated_at = datetime('now')
           WHERE id = ?`,
        ).run(
          args.title ?? null,
          args.body ?? null,
          args.priority ?? null,
          args.status ?? null,
          args.tags ? JSON.stringify(args.tags) : null,
          args.status ?? null,
          args.status ?? null,
          todo.id,
        );
        return { project_id: projectId, todo_id: todo.id };
      }),
  );

  server.registerTool(
    "todo_complete",
    {
      description:
        "Mark a todo complete (or reopen with completed=false). Returns todo ids that this completion newly unblocked.",
      inputSchema: {
        todo_id: z.number().int(),
        completed: z.boolean().optional().describe("Defaults to true."),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const todo = getTodo(projectId, args.todo_id);
        const completed = args.completed ?? true;
        currentActor();
        db.prepare(
          `UPDATE todos SET status = ?,
             completed_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
             updated_at = datetime('now') WHERE id = ?`,
        ).run(completed ? "completed" : "open", completed ? 1 : 0, todo.id);
        let newlyUnblocked: number[] = [];
        if (completed) {
          newlyUnblocked = (
            db
              .prepare(
                `SELECT b.todo_id FROM todo_blockers b
                 JOIN todos t ON t.id = b.todo_id
                 WHERE b.blocker_id = ? AND t.status != 'completed'
                   AND NOT EXISTS (
                     SELECT 1 FROM todo_blockers b2 JOIN todos bt ON bt.id = b2.blocker_id
                     WHERE b2.todo_id = b.todo_id AND bt.status != 'completed'
                   )`,
              )
              .all(todo.id) as { todo_id: number }[]
          ).map((r) => r.todo_id);
        }
        return {
          project_id: projectId,
          todo_id: todo.id,
          completed,
          newly_unblocked: newlyUnblocked,
        };
      }),
  );

  server.registerTool(
    "todo_comment",
    {
      description:
        "Add a comment to a todo. Use for handoffs: changed files, tests run, decisions, remaining risk.",
      inputSchema: {
        todo_id: z.number().int(),
        body: z.string(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const todo = getTodo(projectId, args.todo_id);
        const info = db
          .prepare("INSERT INTO todo_comments (todo_id, author, body) VALUES (?, ?, ?)")
          .run(todo.id, currentActor(), args.body);
        touch(todo.id);
        return { project_id: projectId, todo_id: todo.id, comment_id: Number(info.lastInsertRowid) };
      }),
  );

  server.registerTool(
    "todo_block",
    {
      description: "Add a blocker: todo_id cannot start until blocker_id completes. Cycles are rejected.",
      inputSchema: {
        todo_id: z.number().int(),
        blocker_id: z.number().int(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        addBlocker(projectId, args.todo_id, args.blocker_id);
        touch(args.todo_id);
        return { project_id: projectId, todo_id: args.todo_id, blocker_id: args.blocker_id };
      }),
  );

  server.registerTool(
    "todo_unblock",
    {
      description: "Remove one blocker relationship from a todo.",
      inputSchema: {
        todo_id: z.number().int(),
        blocker_id: z.number().int(),
        project_id: projectIdParam,
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        getTodo(projectId, args.todo_id);
        const info = db
          .prepare("DELETE FROM todo_blockers WHERE todo_id = ? AND blocker_id = ?")
          .run(args.todo_id, args.blocker_id);
        touch(args.todo_id);
        return {
          project_id: projectId,
          todo_id: args.todo_id,
          blocker_id: args.blocker_id,
          removed: info.changes > 0,
        };
      }),
  );
}
