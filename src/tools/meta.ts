import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  addProject,
  currentActor,
  listProjects,
  resolveProject,
  selectProjectById,
  TOUCH_INTERVAL_MS,
  trySelectedProject,
} from "../context.js";
import { errorMessage, run } from "../result.js";
import { HELP_TOPICS, helpOverview } from "../help.js";
import { idParam } from "./params.js";

// PR #100. project_prune and actor_prune sweep the WHOLE store, across every
// project and actor - a lead operation. A project-locked session (every spawned
// worker, per CLAUDE.md's strict scoping) must not be able to reach past its
// own project through these, the same way agent_spawn refuses a cross-project
// cwd for one. Read the lock the same way src/tools/agents.ts already does
// (there is no exported helper for it; context.ts's own `projectLock` const is
// private to its module), rather than inventing a second way to ask.
function refuseIfLocked(tool: string): void {
  if (process.env.HIVE_PROJECT_LOCK === "1") {
    throw new Error(
      `${tool} sweeps the whole store, across every project and every actor. This session is locked to one project (HIVE_PROJECT_LOCK=1) and cannot run it. Run it from an unlocked session (a lead).`,
    );
  }
}

// No project_get, project_update, or a soft-retire state for projects
// (issue #82). project_list already returns every field on every row (id,
// name, path, created_at), and this store carries only a handful of
// projects, so a read-one tool would just filter what list already returns
// in full. A project's path or name changing is rare enough that no one has
// asked for it. Retire is accepted for the same reason removal is not: a
// dead project row is not something anyone wants to keep seeing in a
// filtered-out state, it is something that should be gone; project_prune
// below is that Remove tool.

// Issue #97. Every table that can hold a project's rows, all
// `project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
// (src/db.ts's MIGRATIONS). A cascade is exactly why this list, not a
// foreign key, has to be the safety property: SQLite deletes a project's
// whole subtree without complaint, so "the delete succeeded" proves nothing
// about whether the project was actually empty. todo_blockers and
// todo_comments carry no project_id of their own - they hang off todos.id,
// itself CASCADE - so a project with zero todos rows is transitively empty
// there too, and checking todos already covers them. agent_state_log has no
// project_id at all (deliberately, see its own migration comment) and is
// not a project-owned table.
// Exported so test/prune.test.mjs can iterate this list itself, rather than
// keeping its own copy that could silently drop an entry with nothing to notice
// (PR #100).
export const PROJECT_OWNER_TABLES = [
  "scratchpads",
  "todos",
  "kv",
  "locks",
  "agents",
  "timers",
  "command_trust",
] as const;

// Shared by projectOwnsRows and actorOwnsRows below: both are "does any row
// in a fixed list of (table, column) locations match this id", differing
// only in which list and which id.
function existsWhere(table: string, column: string, value: string | number): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value) !== undefined;
}

function projectOwnsRows(projectId: number): boolean {
  return PROJECT_OWNER_TABLES.some((table) => existsWhere(table, "project_id", projectId));
}

// PR #100's CI gate (inline on this file): the ownership check and the
// DELETE were two separate statements with no transaction between them, so
// another session's write could land in the gap and get silently cascaded
// away with the project - the exact failure the check exists to prevent,
// reached through a timing window instead of a missed column. CLAUDE.md's
// "concurrency is guarded, not assumed", same shape as renameAgent's
// check-then-write in src/spawn.ts.
//
// .immediate() specifically, not a plain (deferred) db.transaction(): a
// deferred transaction only takes the write lock at its first write, so the
// check would still run unlocked and the race would just move one line
// later, surfacing as SQLITE_BUSY_SNAPSHOT under WAL instead of being
// excluded outright. IMMEDIATE takes the write lock at BEGIN, before the
// check runs, so no other writer can commit into this project between the
// check and the delete. Verified against the better-sqlite3 in this repo's
// node_modules (12.11.1): db.transaction(fn).immediate is the exact idiom
// src/db.ts's own migrate() already uses (applyPending.immediate()).
//
// One transaction PER ROW, not one wrapping the whole sweep: this closes
// the race for the row it covers, which is all the CI finding needs, without
// holding the store's single write lock for however long the full scan
// takes against a store other live sessions are writing to throughout.
const pruneProjectIfEmpty = db.transaction((projectId: number): boolean => {
  if (projectOwnsRows(projectId)) return false;
  return db.prepare("DELETE FROM projects WHERE id = ?").run(projectId).changes > 0;
});

// Every column that can hold an actor id, verified against src/db.ts as part of
// #97. Only todos.locked_by and locks.owner carry a foreign key at all; the
// other eight are plain TEXT with no referential integrity,
// todo_comments.author most notably - deleting an actor that wrote comments
// would silently orphan the only record of what a worker did, with nothing to
// stop it. Exported for the same reason as PROJECT_OWNER_TABLES above.
export const ACTOR_OWNER_COLUMNS: readonly [string, string][] = [
  ["agents", "actor_id"],
  ["agents", "parent_actor_id"],
  ["todos", "locked_by"],
  ["todo_comments", "author"],
  ["kv", "updated_by"],
  ["locks", "owner"],
  ["scratchpads", "updated_by"],
  ["timers", "owner"],
  ["timers", "deliver_actor"],
  ["agent_state_log", "actor_id"],
];

function actorOwnsRows(actorId: string): boolean {
  return ACTOR_OWNER_COLUMNS.some(([table, column]) => existsWhere(table, column, actorId));
}

// PR #100. Ownership is not the whole liveness question: a session identified
// by a manual HIVE_AGENT_ID (the documented identity mechanism in context.ts,
// claimable without ever being spawned or getting a backing agents row) is
// "inert" by actorOwnsRows the moment it exists, before it has written anything
// at all. currentActor() caches its id for the rest of the process and never
// revalidates it, so a session pruned in that window keeps writing the deleted
// id into columns like todo_comments.author, which has no foreign key to catch
// it - silent orphaning, the exact failure this whole tool exists to prevent,
// reached through a liveness gap in the check rather than a missing column.
//
// actors.last_seen_at is the fact hive already keeps for this: currentActor()
// stamps it at creation and refreshes it at most once per TOUCH_INTERVAL_MS
// while a session keeps calling tools. A continuously-active session's
// staleness is therefore bounded by TOUCH_INTERVAL_MS, not by how long ago
// it happened to last touch - doubled here for margin against a prune
// landing in the moments just before the next touch would have posted, not
// because TOUCH_INTERVAL_MS itself is unsafe.
//
// This does not fully close the gap: a session that made exactly one call
// and then went genuinely idle (no further tool calls, but still about to
// write something) is indistinguishable from one that never will, once the
// window elapses. Accepted, not fixed here, same shape as project_prune's
// own documented residual below - the alternative (never trusting the
// ownership check on its own) defeats the point of having one.
const ACTOR_LIVENESS_WINDOW_MS = TOUCH_INTERVAL_MS * 2;

function actorRecentlySeen(actorId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM actors WHERE id = ? AND last_seen_at >= datetime('now', ?) LIMIT 1")
      .get(actorId, `-${Math.ceil(ACTOR_LIVENESS_WINDOW_MS / 1000)} seconds`) !== undefined
  );
}

type ActorPruneOutcome = "deleted" | "live" | "kept";

// Same race, same fix, as pruneProjectIfEmpty above - worse here, since most
// ACTOR_OWNER_COLUMNS carry no foreign key at all, so a write landing in an
// unguarded gap would not even cascade or reject, it would silently orphan.
// The liveness check lives inside this same transaction too, not as a
// separate step before it: it needs the same protection against a touch
// landing in a gap as the ownership check does.
const pruneActorIfInert = db.transaction((actorId: string): ActorPruneOutcome => {
  if (actorRecentlySeen(actorId)) return "live";
  if (actorOwnsRows(actorId)) return "kept";
  return db.prepare("DELETE FROM actors WHERE id = ?").run(actorId).changes > 0 ? "deleted" : "kept";
});

export function registerMeta(server: McpServer): void {
  server.registerTool(
    "whoami",
    {
      description:
        "Show this session's actor identity and effective project scope. Call this first in a new session.",
      inputSchema: {},
    },
    () =>
      run(() => {
        const actorId = currentActor();
        const actor = db.prepare("SELECT * FROM actors WHERE id = ?").get(actorId) as {
          id: string;
          name: string;
          kind: string;
        };
        // Not trySelectedProject: that swallows the resolution error into a
        // bare null, indistinguishable from "no project here". A worker
        // bricked by a bad project pin (src/context.ts's agentProjectPin)
        // keeps sending hook rows, so the lead sees a healthy worker while
        // every OTHER tool call fails - whoami is the one call that must
        // not collapse the same failure, since it is how a worker (or the
        // lead reading its output) would actually find out.
        let project = null;
        let projectError;
        try {
          project = resolveProject();
        } catch (e) {
          projectError = e instanceof Error ? e.message : String(e);
        }
        return {
          actor_id: actor.id,
          actor_name: actor.name,
          kind: actor.kind,
          project: project ? { id: project.id, name: project.name, path: project.path } : null,
          ...(projectError ? { project_error: projectError } : {}),
          cwd: process.cwd(),
        };
      }),
  );

  server.registerTool(
    "help",
    {
      description: `Hive usage guidance. Omit topic for an overview, or pass one of: ${Object.keys(HELP_TOPICS).join(", ")}.`,
      inputSchema: { topic: z.string().optional() },
    },
    ({ topic }) =>
      run(() => {
        if (!topic) return helpOverview();
        const text = HELP_TOPICS[topic.toLowerCase()];
        if (!text) {
          throw new Error(`Unknown topic "${topic}". Topics: ${Object.keys(HELP_TOPICS).join(", ")}`);
        }
        return text;
      }),
  );

  server.registerTool(
    "project_list",
    {
      description: "List registered projects and the currently selected one.",
      inputSchema: {},
    },
    () =>
      run(() => ({
        projects: listProjects(),
        selected_project_id: trySelectedProject()?.id ?? null,
      })),
  );

  server.registerTool(
    "project_add",
    {
      description:
        "Register a directory as a project. Defaults to the current working directory. Returns the existing project if the path is already registered.",
      inputSchema: {
        path: z.string().optional(),
        name: z.string().optional(),
      },
    },
    ({ path, name }) => run(() => addProject(path, name)),
  );

  server.registerTool(
    "project_select",
    {
      description: "Set which project later tools act on in this session.",
      inputSchema: { project_id: idParam },
    },
    ({ project_id }) => run(() => selectProjectById(project_id)),
  );

  server.registerTool(
    "project_prune",
    {
      description:
        "Delete every registered project that owns no rows anywhere in the store (scratchpads, todos, kv, locks, agents, timers, command_trust), verified individually before each delete. Never prunes the caller's own project. Refuses under HIVE_PROJECT_LOCK=1: this is a whole-store sweep, and a project-locked session may only touch its own project. Immediate, permanent: no dry-run mode.",
      inputSchema: {},
    },
    () =>
      run(() => {
        refuseIfLocked("project_prune");
        // The caller's own project is held back even if it owns nothing
        // yet: the session is using it right now, mid-turn, and a project
        // that has not written anything is not evidence it never will.
        //
        // What this cannot see: some OTHER live session that has merely
        // resolved to (not yet written into) this same empty project -
        // resolveHomeProject's selectedId lives in that session's process
        // memory, never on a row, so there is nothing here to check it
        // against. Two DIFFERENT things happen next, depending on whether
        // that session had already resolved before this prune ran -
        // corrected here after both were traced through (PR #100; the
        // prior version of this comment claimed both cases fail loudly,
        // which is only true for the first):
        //   Already resolved (selectedId cached in that session's memory):
        //   its next project-scoped write hits SQLite's own "FOREIGN KEY
        //   constraint failed" - loud, but it does NOT name the missing
        //   project or table, so whoever reads it has to already suspect
        //   their project got swept to make sense of it.
        //   Not yet resolved (a fresh process, or one that has not called a
        //   project-scoped tool yet): resolveHomeProject's registration
        //   fallback (src/context.ts) finds nothing registered at that cwd
        //   anymore and SILENTLY re-registers the same path under a NEW
        //   project id. No error at all; the session just keeps going.
        // Neither case corrupts anything: a genuinely empty project had
        // nothing to lose, so the first is loud-but-unhelpful and the
        // second is silent-but-harmless, not silent-and-damaging. The
        // alternative - refusing to prune any project that merely COULD be
        // selected somewhere - would mean the ownership check, which
        // already proves a project has never been written to, could never
        // be trusted on its own, defeating the point of it.
        const homeId = resolveProject().id;
        const deleted: { id: number; name: string }[] = [];
        const errors: { id: number; name: string; error: string }[] = [];
        for (const project of listProjects()) {
          if (project.id === homeId) continue;
          // PR #100. A per-row transaction can still throw
          // (SQLITE_BUSY_SNAPSHOT under real contention, most plausibly), and a
          // destructive tool must report what it actually did rather than let
          // one row's failure erase every deletion that already committed
          // before it. Caught here, kept going: the remaining candidates are
          // independent of this one's failure, and a partial sweep is more
          // useful reported than discarded.
          try {
            if (pruneProjectIfEmpty.immediate(project.id)) {
              deleted.push({ id: project.id, name: project.name });
            }
          } catch (e) {
            errors.push({ id: project.id, name: project.name, error: errorMessage(e) });
          }
        }
        return {
          deleted,
          held_back: { project_id: homeId, reason: "caller's own project" },
          ...(errors.length > 0 ? { errors } : {}),
        };
      }),
  );

  server.registerTool(
    "actor_prune",
    {
      description:
        "Delete every actor that owns no rows anywhere in the store and has not been active in the last minute: agents.actor_id, agents.parent_actor_id, todos.locked_by, todo_comments.author, kv.updated_by, locks.owner, scratchpads.updated_by, timers.owner, timers.deliver_actor, agent_state_log.actor_id. The scan is global across every project, never scoped to the caller's: actors carry no project_id, so an actor can own rows in a project the caller cannot see, and a project-scoped scan would misread that actor as inert and delete it. Never prunes the caller's own actor. Refuses under HIVE_PROJECT_LOCK=1: this is a whole-store sweep. Run this after project_prune when sweeping the store: an empty project owns no agents rows either, so today the order cannot orphan an actor, but that stops being true the day project deletion ever covers a non-empty project, and this ordering is the one that stays safe if it does. Immediate, permanent: no dry-run mode.",
      inputSchema: {},
    },
    () =>
      run(() => {
        refuseIfLocked("actor_prune");
        const homeActor = currentActor();
        const actors = db.prepare("SELECT id, name, kind FROM actors").all() as {
          id: string;
          name: string;
          kind: string;
        }[];
        const deleted: { id: string; name: string }[] = [];
        const heldBackLive: { id: string; name: string }[] = [];
        const errors: { id: string; name: string; error: string }[] = [];
        for (const actor of actors) {
          if (actor.id === homeActor) continue;
          // Same reasoning as project_prune's own try/catch above (PR #100):
          // a per-row throw must not erase every
          // deletion that already committed.
          try {
            const outcome = pruneActorIfInert.immediate(actor.id);
            if (outcome === "deleted") deleted.push({ id: actor.id, name: actor.name });
            else if (outcome === "live") heldBackLive.push({ id: actor.id, name: actor.name });
          } catch (e) {
            errors.push({ id: actor.id, name: actor.name, error: errorMessage(e) });
          }
        }
        return {
          deleted,
          held_back: { actor_id: homeActor, reason: "caller's own actor" },
          held_back_live: heldBackLive,
          ...(errors.length > 0 ? { errors } : {}),
        };
      }),
  );
}
