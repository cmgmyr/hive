import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HELP_TOPICS } from "./help.js";

// Playbooks surface as slash commands in MCP clients (Claude Code shows
// them as /mcp__hive__<name>), giving the daily rituals a first-class
// trigger instead of relying on the model noticing server instructions.
const PLAYBOOKS: { name: string; description: string; text: string }[] = [
  {
    name: "triage",
    description: "Morning ritual: load the runbook and board, report state, plan the day's lanes.",
    text: `Morning triage for this project.
1. Read the "runbook" pad if one exists (pad_read(name="runbook")). It is
   the human's standing instructions and overrides the generic steps below.
2. Read the "board" pad if one exists, then todo_list(status="in_progress")
   and todo_list(status="open").
3. Check agent_list() for workers still running and wake_list() for
   wake-ups left over from yesterday.
4. Report the state in a few lines: active lanes, dispatchable work
   (todo_list(is_blocked=false, status="open")), blocked work, and anything
   that looks stale or died overnight.
5. Propose today's lanes and confirm them with the human before dispatching
   anything. Then follow the runbook, or help(topic="workflow") if there is
   none.`,
  },
  {
    name: "orchestrate",
    description: "The lead/worker operating pattern: plan pad, todo lanes, workers, idle wake-ups.",
    text: HELP_TOPICS.workflow,
  },
  {
    name: "wrapup",
    description: "End of day: capture handoffs, close workers, rotate the board, report.",
    text: `End-of-day wrap-up for this project.
1. Read the "runbook" pad if one exists; its close-out rules override
   these generic steps.
2. For every lane finished today, make sure the handoff is captured: a
   todo comment with changed files, tests run, and remaining risk, then
   todo_complete. Record anything still in flight on the board pad with
   its worktree, todo id, and next action; that is tomorrow's recovery
   point.
3. Close idle workers (agent_close) only after their handoffs are
   recorded; terminal output is not retained.
4. Cancel wake-ups that no longer matter (wake_list, then wake_cancel).
5. Rotate the board if it has grown: pad_archive the old board and write
   a fresh "board" pad carrying forward only live work.
6. Report what shipped, what is in flight, and what comes first tomorrow.`,
  },
];

export function registerPrompts(server: McpServer): void {
  for (const p of PLAYBOOKS) {
    server.registerPrompt(p.name, { description: p.description }, () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text } }],
    }));
  }
}
