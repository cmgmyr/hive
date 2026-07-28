#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrate } from "./db.js";
import { registerAgents } from "./tools/agents.js";
import { registerMeta } from "./tools/meta.js";
import { registerPads } from "./tools/pads.js";
import { registerTodos } from "./tools/todos.js";
import { registerKv } from "./tools/kv.js";
import { registerLeases } from "./tools/leases.js";
import { registerWakes } from "./tools/wakes.js";
import { registerPrompts } from "./prompts.js";
import { startScheduler } from "./scheduler.js";

const server = new McpServer(
  { name: "hive", version: "0.1.0" },
  {
    instructions: `Hive: shared memory and coordination across Claude Code sessions.
Getting started:
1. Call whoami to see your actor identity and effective project scope.
2. Call help for an overview, or help(topic="workflow") for the lead/worker playbook.
3. Pads hold shared plans and findings. Todos coordinate work with blockers and comments. KV holds small shared values; leases claim shared work areas and expire on their own.
4. Before triaging or orchestrating work, read the standing process: run \`hive runbook\` in a shell. It prints the project's profile runbook, or its runbook pad when the project has no profile. Do not read the pad first; most projects with a profile have no runbook pad at all.
Scope discipline: all state is project-scoped, and the current project is the working directory's. An empty result means there is nothing IN THIS PROJECT; report that and stop. Never browse other projects' state (project_id overrides, project_select) unless the user explicitly names another project and asks for it.`,
  },
);

migrate();
registerMeta(server);
registerAgents(server);
registerPads(server);
registerTodos(server);
registerKv(server);
registerLeases(server);
registerWakes(server);
registerPrompts(server);
startScheduler();

await server.connect(new StdioServerTransport());
