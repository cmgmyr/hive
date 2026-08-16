import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function isBuiltSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && ("_zod" in value || "_def" in value);
}

function strictSchemaFor(toolName: string, inputSchema: unknown): unknown {
  if (inputSchema === undefined) return undefined;
  if (isBuiltSchema(inputSchema)) {
    throw new Error(
      `Tool "${toolName}" passed a built Zod schema as its inputSchema. hive registers tools with a ` +
        "raw shape so src/strictInput.ts can make every tool strict in one place. Pass the shape, or " +
        "make your schema strict yourself and widen this check deliberately.",
    );
  }
  return z.strictObject(inputSchema as z.ZodRawShape);
}

export function enforceStrictInput(server: McpServer): McpServer {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name, config, cb) =>
    register(name, { ...config, inputSchema: strictSchemaFor(name, config.inputSchema) as never }, cb)) as
    McpServer["registerTool"];
  return server;
}
