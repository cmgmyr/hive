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

function refuseIfLocked(tool: string): void {
  if (process.env.HIVE_PROJECT_LOCK === "1") {
    throw new Error(
      `${tool} sweeps the whole store, across every project and every actor. This session is locked to one project (HIVE_PROJECT_LOCK=1) and cannot run it. Run it from an unlocked session (a lead).`,
    );
  }
}

export const PROJECT_OWNER_TABLES = [
  "scratchpads",
  "todos",
  "kv",
  "locks",
  "agents",
  "timers",
  "command_trust",
] as const;

function existsWhere(table: string, column: string, value: string | number): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value) !== undefined;
}

function projectOwnsRows(projectId: number): boolean {
  return PROJECT_OWNER_TABLES.some((table) => existsWhere(table, "project_id", projectId));
}

const pruneProjectIfEmpty = db.transaction((projectId: number): boolean => {
  if (projectOwnsRows(projectId)) return false;
  return db.prepare("DELETE FROM projects WHERE id = ?").run(projectId).changes > 0;
});

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

const ACTOR_LIVENESS_WINDOW_MS = TOUCH_INTERVAL_MS * 2;

function actorRecentlySeen(actorId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM actors WHERE id = ? AND last_seen_at >= datetime('now', ?) LIMIT 1")
      .get(actorId, `-${Math.ceil(ACTOR_LIVENESS_WINDOW_MS / 1000)} seconds`) !== undefined
  );
}

type ActorPruneOutcome = "deleted" | "live" | "kept";

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
      outputSchema: { id: idParam, name: z.string(), path: z.string(), created_at: z.string() },
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
      outputSchema: {
        deleted: z.array(z.object({ id: idParam, name: z.string() })),
        held_back: z.object({ project_id: idParam, reason: z.string() }),
        errors: z.array(z.object({ id: idParam, name: z.string(), error: z.string() })).optional(),
      },
    },
    () =>
      run(() => {
        refuseIfLocked("project_prune");

        const homeId = resolveProject().id;
        const deleted: { id: number; name: string }[] = [];
        const errors: { id: number; name: string; error: string }[] = [];
        for (const project of listProjects()) {
          if (project.id === homeId) continue;

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
      outputSchema: {
        deleted: z.array(z.object({ id: z.string(), name: z.string() })),
        held_back: z.object({ actor_id: z.string(), reason: z.string() }),
        held_back_live: z.array(z.object({ id: z.string(), name: z.string() })),
        errors: z.array(z.object({ id: z.string(), name: z.string(), error: z.string() })).optional(),
      },
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
