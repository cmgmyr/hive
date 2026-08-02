import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  addProject,
  currentActor,
  listProjects,
  resolveProject,
  selectProjectById,
  trySelectedProject,
} from "../context.js";
import { run } from "../result.js";
import { HELP_TOPICS, helpOverview } from "../help.js";

// No project_get, project_update, or a soft-retire state for projects
// (issue #82). project_list already returns every field on every row (id,
// name, path, created_at), and this store carries only a handful of
// projects, so a read-one tool would just filter what list already returns
// in full. A project's path or name changing is rare enough that no one has
// asked for it. Retire is accepted for the same reason removal is not: a
// dead project row is not something anyone wants to keep seeing in a
// filtered-out state, it is something that should be gone. That is a
// project_prune gap, not a project_archive one; see the issue-82-drafts pad.
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
      inputSchema: { project_id: z.number().int() },
    },
    ({ project_id }) => run(() => selectProjectById(project_id)),
  );
}
