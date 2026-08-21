import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { currentActor, effectiveProjectId, resolveProject } from "../context.js";
import { matchesAnyTag, parseTags, run } from "../result.js";
import { findUnsafeControlChar } from "../tmux.js";
import { SLUG_MAX_LEN, fallbackSlug } from "../slug.js";
import { idParam, limitParam, offsetParam, projectIdParam } from "./params.js";

interface TodoRow {
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

const priorityParam = z.enum(["high", "medium", "low"]);

const slugParam = z
  .string()
  .trim()
  .max(SLUG_MAX_LEN)
  .refine((s) => findUnsafeControlChar(s, new Set()) === null, {

    message: "slug cannot contain control characters, including tabs or newlines",
  })
  .describe(
    `Short label, ~3-5 words (${SLUG_MAX_LEN} chars max), so this todo reads the same way everywhere it is referenced by id. Free text, not a pad-style slug. Pass "" to clear a previously-set slug back to the automatic fallback.`,
  )
  .optional();

export { SLUG_MAX_LEN, fallbackSlug };

export const TODO_STATUSES = ["open", "in_progress", "backlog", "completed"] as const;
const statusParam = z.enum(TODO_STATUSES);

export const OPEN_BLOCKERS_SQL = `SELECT 1 FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
   WHERE b.todo_id = t.id AND bt.status != 'completed'`;

const LIVE_DEPENDENTS_SQL = `SELECT t.id AS todo_id FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
   WHERE b.blocker_id = ? AND t.status != 'completed' AND t.archived_at IS NULL`;

export const COMMENT_COUNT_SQL = `(SELECT COUNT(*) FROM todo_comments c WHERE c.todo_id = t.id)`;

const SUMMARY_SQL = `
  SELECT t.*,
    (SELECT COUNT(*) FROM todo_blockers b JOIN todos bt ON bt.id = b.blocker_id
      WHERE b.todo_id = t.id AND bt.status != 'completed') AS open_blockers,
    ${COMMENT_COUNT_SQL} AS comment_count
  FROM todos t`;

function getTodo(projectId: number, todoId: number): TodoRow {
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

const addBlocker = db.transaction((projectId: number, todoId: number, blockerId: number) => {
  if (todoId === blockerId) throw new Error("A todo cannot block itself.");
  getTodo(projectId, todoId);
  const blocker = getTodo(projectId, blockerId);
  if (blocker.archived_at != null) {
    throw new Error(
      `Cannot add blocker ${blockerId} to todo ${todoId}: todo ${blockerId} is archived. Unarchive it first.`,
    );
  }
  if (transitiveBlockers(blockerId).has(todoId)) {
    throw new Error(
      `Adding blocker ${blockerId} to todo ${todoId} would create a dependency cycle.`,
    );
  }
  db.prepare(
    "INSERT OR IGNORE INTO todo_blockers (todo_id, blocker_id) VALUES (?, ?)",
  ).run(todoId, blockerId);
});

function touch(todoId: number): void {
  db.prepare("UPDATE todos SET updated_at = datetime('now') WHERE id = ?").run(todoId);
}

const archiveTodo = db.transaction((projectId: number, todoId: number, archived: boolean) => {
  const todo = getTodo(projectId, todoId);
  if ((todo.archived_at != null) === archived) {
    return { todo_id: todo.id, archived };
  }

  if (archived && todo.status !== "completed") {
    const dependents = db.prepare(LIVE_DEPENDENTS_SQL).all(todo.id) as { todo_id: number }[];
    if (dependents.length > 0) {
      const ids = dependents.map((d) => d.todo_id).join(", ");
      throw new Error(
        `Cannot archive todo ${todo.id}: it still blocks ${ids}. Complete or unblock ` +
          `${dependents.length === 1 ? "that todo" : "those todos"} first.`,
      );
    }
  }
  db.prepare(
    `UPDATE todos SET archived_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(archived ? 1 : 0, todo.id);
  return { todo_id: todo.id, archived };
});

const updateTodo = db.transaction(
  (
    projectId: number,
    todoId: number,
    patch: {
      title?: string;
      body?: string;
      priority?: string;
      status?: string;
      tags?: string[];
      slug?: string;
    },
  ) => {
    const todo = getTodo(projectId, todoId);

    if (todo.archived_at != null && todo.status === "completed" && patch.status && patch.status !== "completed") {
      throw new Error(
        `Cannot change todo ${todo.id}'s status away from completed while archived. Unarchive it first.`,
      );
    }
    currentActor();
    db.prepare(
      `UPDATE todos SET
         title = COALESCE(?, title),
         body = COALESCE(?, body),
         priority = COALESCE(?, priority),
         status = COALESCE(?, status),
         tags = COALESCE(?, tags),
         slug = COALESCE(?, slug),
         completed_at = CASE WHEN ? = 'completed' THEN datetime('now')
                             WHEN ? IS NOT NULL THEN NULL
                             ELSE completed_at END,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      patch.title ?? null,
      patch.body ?? null,
      patch.priority ?? null,
      patch.status ?? null,
      patch.tags ? JSON.stringify(patch.tags) : null,
      patch.slug ?? null,
      patch.status ?? null,
      patch.status ?? null,
      todo.id,
    );
    return { todo_id: todo.id };
  },
);

const completeTodo = db.transaction((projectId: number, todoId: number, completed: boolean) => {
  const todo = getTodo(projectId, todoId);
  if (!completed && todo.archived_at != null) {
    throw new Error(`Cannot reopen archived todo ${todo.id}. Unarchive it first.`);
  }
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
          `${LIVE_DEPENDENTS_SQL}
             AND NOT EXISTS (
               SELECT 1 FROM todo_blockers b2 JOIN todos bt ON bt.id = b2.blocker_id
               WHERE b2.todo_id = t.id AND bt.status != 'completed'
             )`,
        )
        .all(todo.id) as { todo_id: number }[]
    ).map((r) => r.todo_id);
  }
  return { todo_id: todo.id, completed, newly_unblocked: newlyUnblocked };
});

export function registerTodos(server: McpServer): void {
  server.registerTool(
    "todo_create",
    {
      description:
        "Create a project-scoped todo. Pass a short slug so it reads the same way everywhere it's referenced by id. Optionally pass blocked_by todo ids to encode ordering. Returns a slim receipt.",
      inputSchema: {
        title: z.string(),
        body: z.string().optional().describe("Objective, owned files, acceptance criteria."),
        priority: priorityParam.optional(),
        tags: z.array(z.string()).optional(),
        slug: slugParam,
        blocked_by: z.array(idParam).optional(),
        project_id: projectIdParam,
      },
      outputSchema: { project_id: idParam, todo_id: idParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        currentActor();
        const info = db
          .prepare(
            "INSERT INTO todos (project_id, title, body, priority, tags, slug) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            projectId,
            args.title,
            args.body ?? "",
            args.priority ?? "medium",
            JSON.stringify(args.tags ?? []),
            args.slug ?? "",
          );
        const todoId = Number(info.lastInsertRowid);
        for (const blockerId of args.blocked_by ?? []) {
          addBlocker.immediate(projectId, todoId, blockerId);
        }
        return { project_id: projectId, todo_id: todoId };
      }),
  );

  server.registerTool(
    "todo_list",
    {
      description:
        "List todo summaries. is_blocked=false finds dispatchable work. query matches title, body, and slug. Archived todos are excluded by default; include_archived=true retrieves them too.",
      inputSchema: {
        status: statusParam.optional(),
        is_blocked: z.boolean().optional(),
        priority: priorityParam.optional(),
        query: z.string().optional(),
        tags: z.array(z.string()).optional(),
        include_archived: z.boolean().optional(),
        limit: limitParam,
        offset: offsetParam,
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
          includeArchived: args.include_archived,
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
        todo_id: idParam,
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
        todo_id: idParam,
        title: z.string().optional(),
        body: z.string().optional(),
        priority: priorityParam.optional(),
        status: statusParam.optional(),
        tags: z.array(z.string()).optional(),
        slug: slugParam,
        project_id: projectIdParam,
      },
      outputSchema: { project_id: idParam, todo_id: idParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const result = updateTodo.immediate(projectId, args.todo_id, {
          title: args.title,
          body: args.body,
          priority: args.priority,
          status: args.status,
          tags: args.tags,
          slug: args.slug,
        });
        return { project_id: projectId, ...result };
      }),
  );

  server.registerTool(
    "todo_archive",
    {
      description:
        "Archive a todo (or unarchive with archived=false), mirroring pad_archive. Archived todos are excluded from todo_list by default; todo_get always reaches them by id. Refuses when this todo still blocks another todo that is not completed.",
      inputSchema: {
        todo_id: idParam,
        archived: z.boolean().optional().describe("Default true. Pass false to unarchive."),
        project_id: projectIdParam,
      },
      outputSchema: { project_id: idParam, todo_id: idParam, archived: z.boolean() },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const result = archiveTodo.immediate(projectId, args.todo_id, args.archived ?? true);
        return { project_id: projectId, ...result };
      }),
  );

  server.registerTool(
    "todo_complete",
    {
      description:
        "Mark a todo complete (or reopen with completed=false). Returns todo ids that this completion newly unblocked.",
      inputSchema: {
        todo_id: idParam,
        completed: z.boolean().optional().describe("Defaults to true."),
        project_id: projectIdParam,
      },
      outputSchema: {
        project_id: idParam,
        todo_id: idParam,
        completed: z.boolean(),
        newly_unblocked: z.array(idParam),
      },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        const result = completeTodo.immediate(projectId, args.todo_id, args.completed ?? true);
        return { project_id: projectId, ...result };
      }),
  );

  server.registerTool(
    "todo_comment",
    {
      description:
        "Add a comment to a todo. Use for handoffs: changed files, tests run, decisions, remaining risk.",
      inputSchema: {
        todo_id: idParam,
        body: z.string(),
        project_id: projectIdParam,
      },
      outputSchema: { project_id: idParam, todo_id: idParam, comment_id: idParam },
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
        todo_id: idParam,
        blocker_id: idParam,
        project_id: projectIdParam,
      },
      outputSchema: { project_id: idParam, todo_id: idParam, blocker_id: idParam },
    },
    (args) =>
      run(() => {
        const projectId = effectiveProjectId(args.project_id);
        addBlocker.immediate(projectId, args.todo_id, args.blocker_id);
        touch(args.todo_id);
        return { project_id: projectId, todo_id: args.todo_id, blocker_id: args.blocker_id };
      }),
  );

  server.registerTool(
    "todo_unblock",
    {
      description: "Remove one blocker relationship from a todo.",
      inputSchema: {
        todo_id: idParam,
        blocker_id: idParam,
        project_id: projectIdParam,
      },
      outputSchema: {
        project_id: idParam,
        todo_id: idParam,
        blocker_id: idParam,
        removed: z.boolean(),
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
