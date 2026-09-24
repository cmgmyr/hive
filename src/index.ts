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
import { schedulerIntervalMs, startScheduler } from "./scheduler.js";
import { enforceStrictInput } from "./strictInput.js";

const server = enforceStrictInput(
  new McpServer(
    { name: "hive", version: "0.1.0" },
    {
      instructions: `Hive gives Claude Code sessions shared, persistent state for coordinating work on a project: pads for plans and findings, todos for tracked work with blockers, kv for small shared values, leases for claiming shared work areas, agents for spawning and directing other sessions, and wake-ups for scheduled or idle-triggered check-ins. Search for these tools when a task needs to persist past this conversation, hand off to or watch another session, or track multi-step work with dependencies.
Getting started:
1. Call whoami to see your actor identity and effective project scope.
2. Call help for an overview, or help(topic="workflow") for the lead/worker playbook.
3. Pads hold shared plans and findings. Todos coordinate work with blockers and comments. KV holds small shared values; leases claim shared work areas and expire on their own.
4. Before triaging or orchestrating work, read the standing process: run \`hive runbook\` in a shell. It prints the project's profile runbook, or its runbook pad when the project has no profile. Do not read the pad first; most projects with a profile have no runbook pad at all.
Scope discipline: all state is project-scoped, and the current project is the working directory's. An empty result means there is nothing IN THIS PROJECT; report that and stop. Never browse other projects' state (project_id overrides, project_select) unless the user explicitly names another project and asks for it.`,
    },
  ),
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
startScheduler(schedulerIntervalMs());

await server.connect(new StdioServerTransport());
