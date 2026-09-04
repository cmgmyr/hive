import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const RUNBOOK_PROMPT = {
  name: "runbook",
  description: "Load this project's own standing process before planning or dispatching anything.",
  text: `Run \`hive runbook\` in a shell and follow what it prints. It resolves this
project's profile runbook, or its runbook pad when the project has no
profile, with hive.yml vars substituted.

If the project has neither, run help(topic="workflow") for hive's generic
lead/worker pattern and agree a process with the human before dispatching
anything.`,
};

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(RUNBOOK_PROMPT.name, { description: RUNBOOK_PROMPT.description }, () => ({
    messages: [
      { role: "user" as const, content: { type: "text" as const, text: RUNBOOK_PROMPT.text } },
    ],
  }));
}
