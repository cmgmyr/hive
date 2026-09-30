import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listQueenAudit } from "../queenAudit.js";
import { run } from "../result.js";
import { idParam, limitParam } from "./params.js";

export function registerQueenAudit(server: McpServer): void {
  server.registerTool(
    "queen_audit_list",
    {
      description: "List confirmed queen writes into other projects, newest first. The queen may read all targets; other callers see only their own project. Default 20, maximum 100 entries. History is retained for 30 days with a 20,000 id-range backstop. A crash between a completed terminal send and its audit insert can leave that send unrecorded.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        project_id: idParam.optional().describe("Filter by the target project id. Only the queen may name another project."),
        limit: limitParam,
      },
    },
    (args) => run(() => listQueenAudit(args)),
  );
}
