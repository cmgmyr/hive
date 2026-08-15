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

// Full rationale (free text vs kebab-case, the character bound,
// why a fallback rather than a backfill) is in the migration's own comment
// in src/db.ts; not repeated at each site below.
//
// No .min(1): the codebase's own precedent for "clear a
// text field back to its default" is passing "" (this file's own `body` has
// no min(1) either), and slug had no way to do that at all - COALESCE(?,
// slug) plus a min(1) meant no value could ever reset the column. "" now
// round-trips: on todo_update it clears the stored slug back to the
// computed fallback (see summarize() below); on todo_create it is
// equivalent to omitting the argument.
const slugParam = z
  .string()
  .trim()
  .max(SLUG_MAX_LEN)
  .refine((s) => findUnsafeControlChar(s, new Set()) === null, {
    // Same detector and no-exceptions policy as normalizeAgentName
    // (src/tools/agents.ts): a slug is a short label, not prose, and it
    // reaches a pane through a wake body the same way a name does.
    message: "slug cannot contain control characters, including tabs or newlines",
  })
  .describe(
    `Short label, ~3-5 words (${SLUG_MAX_LEN} chars max), so this todo reads the same way everywhere it is referenced by id. Free text, not a pad-style slug. Pass "" to clear a previously-set slug back to the automatic fallback.`,
  )
  .optional();

// fallbackSlug and SLUG_MAX_LEN live in src/slug.ts now -
// re-exported here so nothing that imports them from this file breaks.
export { SLUG_MAX_LEN, fallbackSlug };

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

// The mirror of OPEN_BLOCKERS_SQL, addressed from the blocker's own id
// (a `?` parameter) rather than a correlated t.id: todos that currently
// depend on ? and are not yet completed. todo_complete's newly-unblocked
// check and todo_archive's refusal both need exactly this join; extracted
// so the two cannot drift on what "still depends on this one" means.
//
// archived_at IS NULL (#15): an archived dependent
// is not something anyone is waiting on - it is already invisible from
// every default list, same as the blocker it would otherwise strand.
// Without this, archiving a blocked dependent first and then its blocker
// second was refused forever, with no way out but falsely completing the
// dependent or destroying the edge.
const LIVE_DEPENDENTS_SQL = `SELECT t.id AS todo_id FROM todo_blockers b JOIN todos t ON t.id = b.todo_id
   WHERE b.blocker_id = ? AND t.status != 'completed' AND t.archived_at IS NULL`;

// Shared with the CLI (hive doctor's review-findings check): the
// same "does this todo have a comment" subquery SUMMARY_SQL embeds below, so
// the two cannot drift on what counts as commented-on.
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

// Shared with the CLI: the list-row shape both `hive todos` and `hive todo
// <id>` build on.
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
    // '' means no slug was set (this table's DEFAULT) or was explicitly
    // cleared back to it; fall back to a truncation of the title. That can
    // itself read '' for a title that is all whitespace/control characters
    // (fallbackSlug strips both before checking), so the last resort names
    // the row by id - a synthetic label, never blank, and always well under
    // SLUG_MAX_LEN so it round-trips through todo_update like any other slug.
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
    // slug is the field's whole purpose - a lead who knows a todo as "pane
    // steal" and searches that gets zero results without it, since that
    // string may appear nowhere in title or body at all.
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

// #15 (found by the CI gate): the archived-blocker check
// and the INSERT were two separate statements, so a concurrent todo_archive
// could land in the gap - archiving the blocker AFTER this check passed and
// BEFORE the edge was written, recreating the exact invisible-active-blocker
// bug this check exists to prevent. Same .immediate() treatment as
// archiveTodo below, for the identical reason: the write lock has to be held
// from BEGIN, before the archived_at read runs.
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

// #15: the blocker check and the UPDATE were two
// separate statements, so another session's todo_block/todo_create could
// insert a live blocker edge in the gap between them - the same shape #97's
// CI gate caught in src/tools/meta.ts, whose own comment has the fuller
// argument for .immediate() over a plain (deferred) transaction: a deferred
// transaction only takes the write lock at its first write, so the read
// below would still run unlocked and the race would just move one line
// later. IMMEDIATE takes the write lock at BEGIN, before getTodo's read
// runs, so no other writer can commit a new blocker into this project
// between the check and the write.
const archiveTodo = db.transaction((projectId: number, todoId: number, archived: boolean) => {
  const todo = getTodo(projectId, todoId);
  if ((todo.archived_at != null) === archived) {
    return { todo_id: todo.id, archived };
  }
  // Archiving is refused, not silently allowed, when this todo still
  // blocks live work: a dependent's blocker would go invisible from
  // todo_list's default view while still active. Two separate
  // conditions, both from the pad's own wording:
  //   - the dependent (t below) is not completed - the same status
  //     check OPEN_BLOCKERS_SQL uses to decide whether a blocker
  //     counts at all.
  //   - THIS todo is not completed. That is not implied by the
  //     dependents query, which reads the dependent's status, not
  //     this one's - conflating the two was a bug caught by a smoke
  //     test before this landed. When this todo IS completed,
  //     OPEN_BLOCKERS_SQL already excludes it from every dependent's
  //     open_blockers (verified for #15), so archiving it changes
  //     nothing and must be allowed unconditionally.
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

// #15 (found by the CI gate): the un-completing guard
// below read todo.archived_at/status through an earlier getTodo and wrote
// later, with nothing between - the same gap as addBlocker above, reached
// through todo_update instead. A concurrent todo_archive could archive this
// todo (unconditionally allowed once it is completed and has no open
// dependents) after the guard's read and before its own UPDATE, letting a
// reactivating status change land on a todo that is now archived. Wrapped
// with the same .immediate() treatment.
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
    // Moving TO completed, or changing status on a todo that was never
    // completed, carries no reactivation hazard and is left alone.
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

// Same gap as updateTodo above, reached through todo_complete's reopen path
// instead: the reactivation guard read archived_at through an earlier
// getTodo and wrote later, with a concurrent todo_archive able to land
// between. Same .immediate() treatment; also folds in the newly-unblocked
// query so that read is consistent with the write that produced it, not
// just the reactivation guard.
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

// No todo_delete (issue #82, and #15 before it). A todo's comments are the
// only durable record of a worker's reasoning once its pane is gone, and
// this project has already leaned on that record more than once. pad_delete
// exists because a pad can be genuinely disposable; a todo carrying a
// worker's handoff is not. #15 asks for todo_archive instead, to hide a
// closed lane's scaffolding without destroying it.
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
