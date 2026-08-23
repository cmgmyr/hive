import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { scratchGit } from "./helpers.mjs";

const scratch = mkdtempSync(join(tmpdir(), "hive-codex-home-"));
process.env.HIVE_DATA_DIR = join(scratch, "data");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { codexHomeDir, ensureCodexHome } = await import("../dist/codexHome.js");
const { hookEntry } = await import("../dist/hooks.js");

const fakeAuth = join(scratch, "fake-auth.json");
writeFileSync(fakeAuth, JSON.stringify({ tokens: "not real" }));

const repo = join(scratch, "repo");
mkdirSync(repo, { recursive: true });
scratchGit(repo, "init", "-q");
scratchGit(repo, "commit", "-q", "--allow-empty", "-m", "init");
// gitPrimaryRoot realpathSync's the root it resolves (context.ts), so an assertion against the raw
// mkdtemp path breaks wherever os.tmpdir() itself is a symlink (macOS: /var -> /private/var).
const repoReal = realpathSync(repo);

let counter = 0;
const build = (overrides = {}) =>
  ensureCodexHome({
    key: `worker-${counter++}`,
    actorId: "agent:42",
    cwd: repo,
    brief: "hello worker",
    authSource: fakeAuth,
    ...overrides,
  });

describe("ensureCodexHome writes a real, self-contained per-worker home", () => {
  it("symlinks auth.json to the given source, never copies it", () => {
    const key = `worker-${counter}`;
    build({ key });
    assert.equal(readlinkSync(join(codexHomeDir(key), "auth.json")), fakeAuth);
  });

  it("throws, naming the missing path, rather than silently spawning a worker with no credentials", () => {
    assert.throws(
      () => build({ authSource: join(scratch, "does-not-exist.json") }),
      /no codex credentials found at .*does-not-exist\.json/,
    );
  });

  it("always returns both launch bypass flags - the guard the todo asked for, not a comment", () => {
    const { extraArgs } = build();
    assert.ok(extraArgs.includes("--dangerously-bypass-hook-trust"));
    assert.ok(extraArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  });

  it("adds --add-dir pointing at the git-common-dir when cwd is a git repo", () => {
    const { extraArgs } = build();
    const i = extraArgs.indexOf("--add-dir");
    assert.notEqual(i, -1);
    assert.equal(extraArgs[i + 1], join(repoReal, ".git"));
  });

  it("omits --add-dir, rather than pointing it at nothing useful, when cwd is not a git repo", () => {
    const notGit = join(scratch, "not-a-repo");
    mkdirSync(notGit, { recursive: true });
    const { extraArgs } = build({ cwd: notGit });
    assert.equal(extraArgs.includes("--add-dir"), false);
  });
});

describe("the generated hooks.json matches claude's exact nesting (the H1 schema trap)", () => {
  it("wires Stop and UserPromptSubmit using the identical hookEntry() shape ensureHooksFile builds for claude", () => {
    const key = `worker-${counter}`;
    build({ key });
    const written = JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8"));
    assert.deepEqual(written.hooks.Stop, [hookEntry("stop")]);
    assert.deepEqual(written.hooks.UserPromptSubmit, [hookEntry("prompt")]);
  });

  it("does not wire Notification - codex has no such event, and PermissionRequest's redesign is todo 525's, not generated speculatively here", () => {
    const key = `worker-${counter}`;
    build({ key });
    const written = JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8"));
    assert.equal("Notification" in written.hooks, false);
  });
});

describe("the generated config.toml is real, parseable TOML (the H7 ordering trap, as an outcome assertion)", () => {
  it("resolves developer_instructions at the TOP LEVEL, not nested under any table", () => {
    const key = `worker-${counter}`;
    build({ key, brief: "line one\nline two" });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.equal(typeof parsed.developer_instructions, "string");
    assert.equal(parsed.developer_instructions, "line one\nline two");
  });

  it("round-trips a brief containing quotes, backslashes and triple-quote-shaped text", () => {
    const key = `worker-${counter}`;
    const brief = 'a "quoted" word, a \\backslash\\, and a """ sequence';
    build({ key, brief });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.equal(parsed.developer_instructions, brief);
  });

  it("round-trips raw control characters instead of producing TOML the real parser rejects", () => {
    // NUL/VT/FF/BEL/DEL/bare-CR previously crashed the spawn: unescaped, they make config.toml
    // unparseable, and codex failing to parse its own config exits immediately, taking the pane
    // with it. Reachable via hive.yml's ungated `vars` landing in a worker's brief.
    const controls = ["\x00", "\x0B", "\x0C", "\x07", "\x7F", "\r", "\t"];
    for (const ch of controls) {
      const key = `worker-${counter}`;
      const brief = `before${ch}after`;
      build({ key, brief });
      const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
      assert.equal(parsed.developer_instructions, brief, `control char ${JSON.stringify(ch)} did not round-trip`);
    }
  });

  it("pre-seeds project trust against the repo root (codex's own resolution, confirmed live) so the directory-trust dialog never appears", () => {
    const key = `worker-${counter}`;
    build({ key });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.deepEqual(parsed.projects[repoReal], { trust_level: "trusted" });
  });

  it("registers hive's own MCP server with HIVE_AGENT_ID baked into its env, the same mechanism a claude worker already uses", () => {
    const key = `worker-${counter}`;
    build({ key, actorId: "agent:777" });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.equal(parsed.mcp_servers.hive.command, process.execPath);
    assert.equal(parsed.mcp_servers.hive.args.length, 1);
    assert.ok(parsed.mcp_servers.hive.args[0].endsWith("index.js"));
    assert.equal(parsed.mcp_servers.hive.env.HIVE_AGENT_ID, "agent:777");
  });
});
