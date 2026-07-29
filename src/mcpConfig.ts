// Reading Claude Code's MCP registrations. hive never writes them; it reports
// what is there, because a registration that runs a bare `node` is one `cd`
// away from starting hive's server under an interpreter that cannot open the
// store.
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

// fileURLToPath, not URL.pathname: a checkout under "Application Support"
// comes back percent-encoded and matches nothing.
const serverPath = (): string => fileURLToPath(new URL("./index.js", import.meta.url));

// The one place a `claude mcp add` line is written. Paths are quoted because
// the line is meant to be pasted, and the interpreter a version manager
// installs is routinely under a directory with a space in it ("Application
// Support" on this author's machine).
function addCommand(scope: string, name: string, pinned: string, args: string[]): string {
  return `  claude mcp add --scope ${scope} ${name} -- ${[pinned, ...args].map((a) => `"${a}"`).join(" ")}`;
}

// What is wrong with one registration, given the interpreter hive wants the
// server to run under, or null when nothing is. Both surfaces that report this
// (hive doctor and hive setup) call it, so one problem never gets two
// descriptions; each wraps the lines in its own prefix.
//
// The first line completes "<label>: ", the rest are continuations.
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
    // Absent, or a shape hive does not get to have an opinion about.
    return null;
  }
}

// Claude Code's own config, holding user scope and local scope both.
// CLAUDE_CONFIG_DIR moves it.
const userConfigPath = (): string =>
  join(resolve(process.env.CLAUDE_CONFIG_DIR || homedir()), ".claude.json");

// A registration is hive's if it is named hive, or if it is named something
// else and points at this checkout's server. Shared, so the offer below cannot
// disagree with what the scan counts as already registered.
const isHive = (name: string, raw: any): boolean =>
  name === "hive" ||
  (Array.isArray(raw?.args) &&
    raw.args.some((a: unknown) => typeof a === "string" && resolve(a) === serverPath()));

// Where Claude Code keeps them. User and local scope share ~/.claude.json
// (local hangs off the project's entry); project scope is a .mcp.json in the
// repo.
export function hiveRegistrations(projectPath: string | null): McpRegistration[] {
  const found: McpRegistration[] = [];
  const collect = (servers: unknown, scope: string, source: string) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, any>)) {
      const command = raw?.command;
      // Remote servers (http, sse) have no command and cannot have this bug.
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

// The one registration state setup can establish rather than infer: this
// config file exists, it parses, it lists MCP servers, and hive is not among
// them. Everything else stays silent, including the case that looks the most
// like it. "No hive registration found anywhere" is an inference about the
// machine, and hive reads one config dir and at most one project's .mcp.json,
// so a user registered project-scope elsewhere would be told they have no
// registration on every single update.
//
// The three silent states are silent for the same reason: a missing file, an
// unreadable one, and one with no mcpServers block are each a state hive
// cannot interpret. Only the shape above supports a sentence.
//
// Offered, not warned. A fresh install with no hive registration yet is doing
// the right thing in the right order; the README hands over this same line one
// step below `hive setup`. Both doctor and setup print it, from here, so the
// two surfaces keep the single voice they got in round 2.
export function registrationOffer(pinned: string, found: McpRegistration[]): string[] | null {
  if (found.length > 0) return null;
  const source = userConfigPath();
  const servers = readJson(source)?.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  if (Object.entries(servers as Record<string, any>).some(([name, raw]) => isHive(name, raw))) {
    return null;
  }
  // --scope user because that is the file just read, and the scope the README
  // installs with.
  // Says only what the file shows. An mcpServers block can be present and
  // empty, which is what Claude Code writes for someone who has never added a
  // server, so "lists MCP servers" would be false exactly where this is most
  // useful. "Not registered in this file" is true either way, and is the
  // whole of the claim.
  return [
    `hive's MCP tools are not registered in ${source}.`,
    "The `hive` command and the MCP server are registered separately, so this",
    "adds the server, pinned to the same interpreter:",
    addCommand("user", "hive", pinned, [serverPath()]),
  ];
}
