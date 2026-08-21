import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

type ToolCallback = (...args: unknown[]) => unknown;

// The SDK requires structuredContent whenever outputSchema is declared but never populates it itself,
// so this stays scoped to declaring tools rather than attached blanket in src/result.ts's ok().
function withStructuredContent(name: string, cb: ToolCallback): ToolCallback {
  return async (...args: unknown[]) => {
    const result = (await cb(...args)) as CallToolResult;
    if (result.isError || result.structuredContent) return result;
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : undefined;
    let parsed: unknown;
    try {
      parsed = text !== undefined ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      result.structuredContent = parsed as Record<string, unknown>;
      return result;
    }
    return {
      content: [
        {
          type: "text",
          text:
            `hive: tool "${name}" declares outputSchema but its result was not a JSON object, so ` +
            "src/strictInput.ts's withStructuredContent could not build structuredContent from it. This " +
            "is a bug in the tool's handler, not in this call's input.",
        },
      ],
      isError: true,
    };
  };
}

export function enforceStrictInput(server: McpServer): McpServer {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name, config, cb) =>
    register(
      name,
      { ...config, inputSchema: strictSchemaFor(name, config.inputSchema) as never },
      (config.outputSchema ? withStructuredContent(name, cb as ToolCallback) : cb) as never,
    )) as McpServer["registerTool"];
  return server;
}
