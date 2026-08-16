import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type McpRegistration = {
  name: string;
  scope: string;
  source: string;
  command: string;
  args: string[];
};

const serverPath = (): string => fileURLToPath(new URL("./index.js", import.meta.url));

function addCommand(scope: string, name: string, pinned: string, args: string[]): string {
  return `  claude mcp add --scope ${scope} ${name} -- ${[pinned, ...args].map((a) => `"${a}"`).join(" ")}`;
}

export function registrationProblem(r: McpRegistration, pinned: string): string[] | null {
  const reRegister = [addCommand(r.scope, r.name, pinned, r.args)];
  if (!r.command.includes("/")) {
    return [
      `runs "${r.command}", which a Node version manager re-resolves per`,
      "directory, so the server can start under a Node that cannot load hive's store.",
      `Re-register with an absolute interpreter, in ${r.source}:`,
      ...reRegister,
    ];
  }
  if (r.command !== pinned) {
    return [
      `pins a different interpreter than this CLI runs (${pinned}).`,
      "That is fine only while both were built against the same ABI.",
      `Re-register with this one, in ${r.source}:`,
      ...reRegister,
    ];
  }
  return null;
}

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {

    return null;
  }
}

const userConfigPath = (): string =>
  join(resolve(process.env.CLAUDE_CONFIG_DIR || homedir()), ".claude.json");

const isHive = (name: string, raw: any): boolean =>
  name === "hive" ||
  (Array.isArray(raw?.args) &&
    raw.args.some((a: unknown) => typeof a === "string" && resolve(a) === serverPath()));

export function hiveRegistrations(projectPath: string | null): McpRegistration[] {
  const found: McpRegistration[] = [];
  const collect = (servers: unknown, scope: string, source: string) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, any>)) {
      const command = raw?.command;

      if (typeof command !== "string") continue;
      if (!isHive(name, raw)) continue;
      const args: string[] = Array.isArray(raw.args)
        ? raw.args.filter((a: unknown) => typeof a === "string")
        : [];
      found.push({ name, scope, source, command, args });
    }
  };
  const claudeJson = userConfigPath();
  const user = readJson(claudeJson);
  collect(user?.mcpServers, "user", claudeJson);
  if (projectPath) {
    collect(user?.projects?.[projectPath]?.mcpServers, "local", claudeJson);
    const projectFile = join(projectPath, ".mcp.json");
    collect(readJson(projectFile)?.mcpServers, "project", projectFile);
  }
  return found;
}

export function registrationOffer(pinned: string, found: McpRegistration[]): string[] | null {
  if (found.length > 0) return null;
  const source = userConfigPath();
  const servers = readJson(source)?.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  if (Object.entries(servers as Record<string, any>).some(([name, raw]) => isHive(name, raw))) {
    return null;
  }

  return [
    `hive's MCP tools are not registered in ${source}.`,
    "The `hive` command and the MCP server are registered separately, so this",
    "adds the server, pinned to the same interpreter:",
    addCommand("user", "hive", pinned, [serverPath()]),
  ];
}
