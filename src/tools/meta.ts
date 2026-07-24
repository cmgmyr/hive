import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db.js";
import {
  addProject,
  currentActor,
  listProjects,
  selectProjectById,
  trySelectedProject,
} from "../context.js";
import { run } from "../result.js";
import { HELP_TOPICS, helpOverview } from "../help.js";

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
        const project = trySelectedProject();
        return {
          actor_id: actor.id,
          actor_name: actor.name,
          kind: actor.kind,
          project: project ? { id: project.id, name: project.name, path: project.path } : null,
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
