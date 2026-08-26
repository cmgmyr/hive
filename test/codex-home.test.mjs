import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { scratchGit } from "./helpers.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "hive-codex-home-"));
process.env.HIVE_DATA_DIR = join(scratch, "data");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { codexHomeDir, ensureCodexHome, reapCodexHome } = await import("../dist/codexHome.js");
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

let hasCodex = true;
try {
  execFileSync("codex", ["--version"], { stdio: "ignore" });
} catch {
  hasCodex = false;
}

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

  it("wires SubagentStart and SubagentStop, the events todo 525 rekeys the subagent latch to since codex's Stop payload carries no background_tasks array", () => {
    const key = `worker-${counter}`;
    build({ key });
    const written = JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8"));
    assert.deepEqual(written.hooks.SubagentStart, [hookEntry("subagent_start")]);
    assert.deepEqual(written.hooks.SubagentStop, [hookEntry("subagent_stop")]);
  });

  it("does not wire Notification - codex has no such event, and the notify branch is proven unreachable for codex on purpose (test/codex-notify-unreachable.test.mjs)", () => {
    const key = `worker-${counter}`;
    build({ key });
    const written = JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8"));
    assert.equal("Notification" in written.hooks, false);
  });

  it("omits SessionStart for an ordinary worker home - only a lead home should ever poll `hive kickoff`", () => {
    const key = `worker-${counter}`;
    build({ key });
    const written = JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8"));
    assert.equal("SessionStart" in written.hooks, false);
  });

  it("wires SessionStart to kickoff.js --codex, and only when `lead: true` is passed (todo 575)", () => {
    const key = `lead-${counter}`;
    build({ key, lead: true });
    const written = JSON.parse(readFileSync(join(codexHomeDir(key), "hooks.json"), "utf8"));
    const command = written.hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /kickoff\.js/, "must point at kickoff.js directly, not rely on `hive` resolving on PATH");
    assert.match(command, /--codex\b/, "must pass --codex, or kickoff would emit the claude-only initialUserMessage key");
    // Same worker-state events as an ordinary home, unaffected by the extra SessionStart entry.
    assert.deepEqual(written.hooks.Stop, [hookEntry("stop")]);
    assert.deepEqual(written.hooks.UserPromptSubmit, [hookEntry("prompt")]);
  });
});

describe("the cleanup skill ships with a lead home (todo 575 requirement 3)", () => {
  it("symlinks claude-plugin/skills/cleanup into skills/cleanup, only for a lead home", () => {
    const key = `lead-${counter}`;
    build({ key, lead: true });
    const link = join(codexHomeDir(key), "skills", "cleanup");
    assert.equal(realpathSync(link), realpathSync(join(REPO_ROOT, "claude-plugin", "skills", "cleanup")));
  });

  it("an ordinary worker home gets no skills/ directory at all", () => {
    const key = `worker-${counter}`;
    build({ key });
    assert.equal(existsSync(join(codexHomeDir(key), "skills")), false);
  });

  it("regenerating a home (same key) replaces the cleanup symlink without disturbing a pre-existing skills/.system entry", () => {
    const key = `lead-${counter}`;
    build({ key, lead: true });
    const systemDir = join(codexHomeDir(key), "skills", ".system");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, "marker"), "codex-owned");

    build({ key, lead: true });

    assert.equal(readFileSync(join(systemDir, "marker"), "utf8"), "codex-owned");
    assert.equal(realpathSync(join(codexHomeDir(key), "skills", "cleanup")), realpathSync(join(REPO_ROOT, "claude-plugin", "skills", "cleanup")));
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

describe("todo 560: status_line and project_doc_fallback_filenames reach the generated config", () => {
  it("always emits project_doc_fallback_filenames = [\"CLAUDE.md\"] at the top level, regardless of the real config", () => {
    const key = `worker-${counter}`;
    build({ key });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.deepEqual(parsed.project_doc_fallback_filenames, ["CLAUDE.md"]);
  });

  it("copies [tui].status_line from the real config when the real config has one", () => {
    const realConfig = join(scratch, "real-config-with-status-line.toml");
    writeFileSync(realConfig, ['[tui]', 'status_line = ["project-name", "context-used"]', ""].join("\n"));
    const key = `worker-${counter}`;
    build({ key, realConfigSource: realConfig });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.deepEqual(parsed.tui.status_line, ["project-name", "context-used"]);
  });

  it("falls back to hive's own default status_line, including context-used, when the real config has no [tui] table", () => {
    const realConfig = join(scratch, "real-config-no-tui.toml");
    writeFileSync(realConfig, 'model = "gpt-5.6-sol"\n');
    const key = `worker-${counter}`;
    build({ key, realConfigSource: realConfig });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.ok(parsed.tui.status_line.includes("context-used"), "hive's default must include context-used - the operational point of the lane");
  });

  it("falls back to hive's own default status_line when the real config file does not exist at all", () => {
    const key = `worker-${counter}`;
    build({ key, realConfigSource: join(scratch, "does-not-exist-config.toml") });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.ok(parsed.tui.status_line.includes("context-used"));
  });

  it("copies only status_line out of the real config's [tui] table - never [hooks], never any other top-level key (the never-merge guard)", () => {
    const realConfig = join(scratch, "real-config-guard.toml");
    writeFileSync(
      realConfig,
      [
        "[tui]",
        'status_line = ["context-used", "model-with-reasoning"]',
        "",
        "[hooks.state]",
        'command = "/bin/whoami-hook"',
        "",
        'unrelated_top_level_key = "should never appear"',
        "",
      ].join("\n"),
    );
    const key = `worker-${counter}`;
    build({ key, realConfigSource: realConfig });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.deepEqual(
      parsed.tui.status_line,
      ["context-used", "model-with-reasoning"],
      "status_line itself must still be copied - this is not just a negative assertion",
    );
    assert.equal(
      "hooks" in parsed,
      false,
      "the real config's [hooks] table must never cross into a worker's config - that is the whole reason per-worker homes exist (decisions/2026-08-23-per-worker-codex-home-stays.md)",
    );
    assert.equal("unrelated_top_level_key" in parsed, false, "no unrelated top-level key from the real config may cross over");
  });
});

// Same env gate as test/codex-live-spawn.test.mjs's real-spawn case, for the same reason: this
// shells out to the real codex binary, which no CI runner has or should be given. The network-cost
// half of that file's rationale does not apply here (see noNetworkEnv below), but "runs the real
// binary at all" is kept opt-in on principle rather than firing on every dev machine that happens to
// have codex on PATH.
const REAL_CODEX_ENV = "HIVE_TEST_REAL_CODEX";
const strictConfigSkip = !hasCodex
  ? "codex is not installed on PATH"
  : process.env[REAL_CODEX_ENV] !== "1"
    ? `set ${REAL_CODEX_ENV}=1 to run this - it shells out to the real codex binary`
    : false;

describe(`the generated config.toml passes codex's own --strict-config check against the real binary (env-gated: ${REAL_CODEX_ENV})`, () => {
    // `codex exec` is the only subcommand --strict-config works on (mcp/debug/features all refuse
    // it), and a config that parses proceeds straight into real network calls (a websocket to
    // OpenAI, plus a plugin-marketplace git clone) before this process ever gets a chance to kill
    // it. Routing http(s)_proxy at an address nothing listens on makes every one of those calls fail
    // in milliseconds with ECONNREFUSED, well before config parsing would ever be in question - a
    // config codex rejects fails during load, before any network attempt exists to redirect. Proven
    // live: with the proxy set, a good config reaches its "session id:" banner and a config carrying
    // top-level status_line still fails instantly with "unknown configuration field".
    const noNetworkEnv = {
      ...process.env,
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    };

    function runStrictConfig(home) {
      const result = spawnSync("codex", ["exec", "--strict-config", "hello"], {
        cwd: repo,
        env: { ...noNetworkEnv, CODEX_HOME: home },
        input: "",
        timeout: 2000,
        killSignal: "SIGKILL",
        detached: true,
        encoding: "utf8",
      });
      // detached:true makes codex the leader of a new process group, so -pid reaches any child it
      // spawned (the hive MCP server, a plugin-sync git clone) that spawnSync's own timeout kill
      // would otherwise leave orphaned - the exact leaked-process shape test/CLAUDE.md warns about.
      if (result.pid) {
        try {
          process.kill(-result.pid, "SIGKILL");
        } catch {
          // Group already gone - nothing survived to reap.
        }
      }
      return result;
    }

    it("accepts every field in a real generated worker config - no \"unknown configuration field\" error", { skip: strictConfigSkip }, () => {
      const key = `worker-${counter}`;
      build({ key });
      const result = runStrictConfig(codexHomeDir(key));
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.equal(/unknown configuration field/.test(output), false, `codex rejected the generated config:\n${output}`);
      assert.match(output, /session id:/, "must reach session startup - proves config load actually completed rather than the run failing before it got there");
    });

    it("rejects a top-level status_line the way the todo body's original (wrong) claim would have shipped it - the regression this lane exists to prevent", { skip: strictConfigSkip }, () => {
      const key = `worker-${counter}`;
      build({ key });
      const home = codexHomeDir(key);
      // Overwrite with the exact shape the todo body's uncorrected claim would have produced:
      // status_line at the top level instead of under [tui].
      writeFileSync(join(home, "config.toml"), 'status_line = ["context-used"]\n');
      const result = runStrictConfig(home);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.match(output, /unknown configuration field `status_line`/, `expected a top-level status_line to be rejected; got:\n${output}`);
    });
});

describe("reapCodexHome removes the home directory without ever following the auth.json symlink", () => {
  it("the real credential file behind the symlink survives the reap, unmodified", () => {
    const key = `worker-${counter}`;
    build({ key });
    assert.ok(existsSync(codexHomeDir(key)), "the home must exist before it can prove anything by disappearing");
    assert.ok(existsSync(fakeAuth));
    const before = readFileSync(fakeAuth, "utf8");

    reapCodexHome(key);

    assert.equal(existsSync(codexHomeDir(key)), false, "the home directory itself must be gone");
    assert.equal(existsSync(fakeAuth), true, "the symlink's real target must survive - it lives outside the home");
    assert.equal(readFileSync(fakeAuth, "utf8"), before, "the target's content must be untouched, not just present");
  });

  it("is a safe no-op against a home that was already removed", () => {
    assert.doesNotThrow(() => reapCodexHome("never-existed-key"));
  });
});
