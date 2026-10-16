import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import { COMMENT_COUNT_SQL, getTodo, getTodoDetail, listTodoSummaries, type TodoDetail, type TodoListFilter, type TodoRow, type TodoSummary } from "../todos.js";
import { TODO_STATUSES } from "../todoScope.js";
export { COMMENT_COUNT_SQL, getTodo, getTodoDetail, listTodoSummaries, type TodoDetail, type TodoListFilter, type TodoRow, type TodoSummary } from "../todos.js";
export { TODO_STATUSES } from "../todoScope.js";
import { commitQueenStateWrite } from "../queenAudit.js";
import { currentActor, effectiveProjectId, resolveProject } from "../context.js";
import { matchesAnyTag, parseTags, run } from "../result.js";
import { findUnsafeControlChar } from "../tmux.js";
import { SLUG_MAX_LEN, fallbackSlug } from "../slug.js";
import { idParam, limitParam, offsetParam, projectIdParam } from "./params.js";
import { NOT_COMPLETED_TODO_SQL, OPEN_BLOCKERS_FROM_WHERE, OPEN_BLOCKERS_SQL } from "../todoScope.js";

const priorityParam = z.enum(["high", "medium", "low"]);

const slugParam = z
  .string()
  .trim()
  .max(SLUG_MAX_LEN)
  .refine((s) => findUnsafeControlChar(s, new Set()) === null, {

    message: "slug cannot contain control characters, including tabs or newlines",
  })
  .describe(
    `Short label, ~3-5 words (${SLUG_MAX_LEN} chars max). When set, it renders beside the id: bracketed in \`hive todos\`, \`hive todo <id>\`, and the session-start digest, and as the row's whole label in the dashboard. Left unset, those surfaces fall back to the title - shown in full in \`hive todos\`/\`hive todo <id>\`/the digest, truncated to this same length in the dashboard. Free text, not a pad-style slug. Pass "" to clear a previously-set slug back to unset.`,
  )
  .optional();

export { SLUG_MAX_LEN, fallbackSlug };

const statusParam = z.enum(TODO_STATUSES);

const LIVE_DEPENDENTS_SQL = `SELECT t.id AS todo_id FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
   WHERE b.blocker_id = ? AND t.${NOT_COMPLETED_TODO_SQL} AND t.archived_at IS NULL`;

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
             AND NOT EXISTS (${OPEN_BLOCKERS_SQL})`,
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
        "Create a project-scoped todo. Pass a short slug to have it render beside the id wherever this todo is listed; left unset, those surfaces fall back to the title instead (truncated in the dashboard). Optionally pass blocked_by todo ids to encode ordering. Returns a slim receipt.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
        return commitQueenStateWrite("todo_create", projectId, args, () => {
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
        });
      }),
  );

  server.registerTool(
    "todo_list",
    {
      description:
        "List todo summaries. is_blocked=false finds dispatchable work. query matches title, body, and slug. Archived todos are excluded by default; include_archived=true retrieves them too.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
        return commitQueenStateWrite("todo_comment", projectId, args, () => {
          const info = db
            .prepare("INSERT INTO todo_comments (todo_id, author, body) VALUES (?, ?, ?)")
            .run(todo.id, currentActor(), args.body);
          touch(todo.id);
          return { project_id: projectId, todo_id: todo.id, comment_id: Number(info.lastInsertRowid) };
        });
      }),
  );

  server.registerTool(
    "todo_block",
    {
      description: "Add a blocker: todo_id cannot start until blocker_id completes. Cycles are rejected.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
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
