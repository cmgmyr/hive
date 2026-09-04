import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { scratchGit } from "./helpers.mjs";

// todo 787: a codex session gets the same three instruction layers a claude session does - GLOBAL
// (~/.codex/AGENTS.md), REPO (unchanged, codex's own AGENTS.md/CLAUDE.md walk), and REPO-LOCAL
// OVERRIDE (CLAUDE.local.md/AGENTS.local.md, which codex has no native equivalent for).

const scratch = mkdtempSync(join(tmpdir(), "hive-codex-home-layers-"));
process.env.HIVE_DATA_DIR = join(scratch, "data");
after(() => rmSync(scratch, { recursive: true, force: true }));

const { codexHomeDir, ensureCodexHome, reapCodexHome, codexInstructionsPhrase } = await import("../dist/codexHome.js");

// authSource's own directory doubles as the fixture $CODEX_HOME the GLOBAL layer reads AGENTS.md
// beside, per DEFAULT SHAPE step 1: globalSource = join(dirname(authSource), "AGENTS.md").
const homeFixtureWithGlobal = join(scratch, "fixture-codex-home-with-global");
mkdirSync(homeFixtureWithGlobal, { recursive: true });
const fakeAuthWithGlobal = join(homeFixtureWithGlobal, "auth.json");
writeFileSync(fakeAuthWithGlobal, JSON.stringify({ tokens: "not real" }));
const fixtureGlobalAgents = join(homeFixtureWithGlobal, "AGENTS.md");
writeFileSync(fixtureGlobalAgents, "GLOBAL AGENTS SENTINEL");

const homeFixtureNoGlobal = join(scratch, "fixture-codex-home-no-global");
mkdirSync(homeFixtureNoGlobal, { recursive: true });
const fakeAuthNoGlobal = join(homeFixtureNoGlobal, "auth.json");
writeFileSync(fakeAuthNoGlobal, JSON.stringify({ tokens: "not real" }));

const primaryRepo = join(scratch, "primary-repo");
mkdirSync(primaryRepo, { recursive: true });
scratchGit(primaryRepo, "init", "-q");
scratchGit(primaryRepo, "config", "user.email", "test@example.com");
scratchGit(primaryRepo, "config", "user.name", "Test");
scratchGit(primaryRepo, "commit", "-q", "--allow-empty", "-m", "init");
const primaryRepoReal = realpathSync(primaryRepo);

const worktree = join(scratch, "primary-repo-worktree");
scratchGit(primaryRepo, "worktree", "add", "-q", worktree, "-b", "todo-787-fixture-branch");
const worktreeReal = realpathSync(worktree);

let counter = 0;
const build = (overrides = {}) =>
  ensureCodexHome({
    key: `worker-${counter++}`,
    actorId: "agent:42",
    cwd: primaryRepo,
    brief: "hello worker",
    authSource: fakeAuthNoGlobal,
    ...overrides,
  });

describe("GLOBAL layer: ~/.codex/AGENTS.md is symlinked beside auth.json", () => {
  it("links <home>/AGENTS.md to the global file when it exists beside authSource", () => {
    const key = `worker-${counter}`;
    build({ key, authSource: fakeAuthWithGlobal });
    assert.equal(readlinkSync(join(codexHomeDir(key), "AGENTS.md")), fixtureGlobalAgents);
  });

  it("writes no AGENTS.md link at all when no global file sits beside authSource", () => {
    const key = `worker-${counter}`;
    build({ key, authSource: fakeAuthNoGlobal });
    assert.equal(existsSync(join(codexHomeDir(key), "AGENTS.md")), false);
  });

  it("a re-run against an existing home removes a stale AGENTS.md link once the global file is gone", () => {
    const key = `worker-${counter}`;
    build({ key, authSource: fakeAuthWithGlobal });
    assert.ok(existsSync(join(codexHomeDir(key), "AGENTS.md")), "the link must exist after the first build");

    build({ key, authSource: fakeAuthNoGlobal });
    assert.equal(existsSync(join(codexHomeDir(key), "AGENTS.md")), false, "the stale link must be removed, not left pointing at a now-irrelevant target");
  });

  it("reapCodexHome removes the AGENTS.md link without ever following it - the real global file survives untouched", () => {
    const key = `worker-${counter}`;
    build({ key, authSource: fakeAuthWithGlobal });
    assert.ok(existsSync(codexHomeDir(key)));
    const before = readFileSync(fixtureGlobalAgents, "utf8");

    reapCodexHome(key);

    assert.equal(existsSync(codexHomeDir(key)), false, "the home directory itself must be gone");
    assert.equal(existsSync(fixtureGlobalAgents), true, "the symlink's real target must survive - it lives outside the home");
    assert.equal(readFileSync(fixtureGlobalAgents, "utf8"), before, "the target's content must be untouched, not just present");
  });
});

describe("REPO-LOCAL OVERRIDE layer: CLAUDE.local.md/AGENTS.local.md from the primary checkout appended to developer_instructions", () => {
  it("developer_instructions is exactly the brief when neither local file exists", () => {
    const key = `worker-${counter}`;
    build({ key, brief: "hello worker" });
    const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
    assert.equal(parsed.developer_instructions, "hello worker");
  });

  it("appends CLAUDE.local.md from the PRIMARY root, under a heading naming its path, when cwd is a WORKTREE", () => {
    const localPath = join(primaryRepo, "CLAUDE.local.md");
    writeFileSync(localPath, "LOCAL OVERRIDE SENTINEL");
    try {
      const key = `worker-${counter}`;
      build({ key, cwd: worktree, brief: "hello worker" });
      const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
      const localPathReal = join(primaryRepoReal, "CLAUDE.local.md");
      assert.equal(
        parsed.developer_instructions,
        `hello worker\n\n# Repo-local instructions from ${localPathReal} (the primary checkout's gitignored file; a worktree cwd has no copy, so do not look for it under your own path)\n\nLOCAL OVERRIDE SENTINEL`,
      );
    } finally {
      rmSync(localPath, { force: true });
    }
  });

  it("AGENTS.local.md wins over CLAUDE.local.md when both exist in the primary root", () => {
    const agentsLocal = join(primaryRepo, "AGENTS.local.md");
    const claudeLocal = join(primaryRepo, "CLAUDE.local.md");
    writeFileSync(agentsLocal, "AGENTS-LOCAL WINS");
    writeFileSync(claudeLocal, "CLAUDE-LOCAL LOSES");
    try {
      const key = `worker-${counter}`;
      build({ key, brief: "hello worker" });
      const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
      assert.match(parsed.developer_instructions, /AGENTS-LOCAL WINS/);
      assert.doesNotMatch(parsed.developer_instructions, /CLAUDE-LOCAL LOSES/);
      assert.match(parsed.developer_instructions, /# Repo-local instructions from .*AGENTS\.local\.md/);
    } finally {
      rmSync(agentsLocal, { force: true });
      rmSync(claudeLocal, { force: true });
    }
  });

  it("developer_instructions still resolves at the TOP LEVEL of the TOML with a local override appended (the H7 ordering trap, reproduced with the new content)", () => {
    const localPath = join(primaryRepo, "CLAUDE.local.md");
    writeFileSync(localPath, "local text");
    try {
      const key = `worker-${counter}`;
      build({ key, brief: "hello worker" });
      const raw = readFileSync(join(codexHomeDir(key), "config.toml"), "utf8");
      assert.ok(
        raw.trimStart().startsWith("developer_instructions ="),
        "developer_instructions must still be written before any [section] header",
      );
      const parsed = parseToml(raw);
      assert.equal(typeof parsed.developer_instructions, "string");
    } finally {
      rmSync(localPath, { force: true });
    }
  });

  it("round-trips a local override file containing quotes, backslashes and control characters", () => {
    const localPath = join(primaryRepo, "CLAUDE.local.md");
    const localText = 'a "quoted" line, a \\backslash\\, a\tcontrol\x07char';
    writeFileSync(localPath, localText);
    try {
      const key = `worker-${counter}`;
      build({ key, brief: "brief" });
      const parsed = parseToml(readFileSync(join(codexHomeDir(key), "config.toml"), "utf8"));
      assert.ok(parsed.developer_instructions.endsWith(localText), parsed.developer_instructions);
    } finally {
      rmSync(localPath, { force: true });
    }
  });

  it("throws on a local-override read error other than ENOENT, before writing anything to the home directory", () => {
    // A directory named CLAUDE.local.md makes readFileSync throw EISDIR, not ENOENT - the one
    // real-world shape of "exists but unreadable" this fixture can produce portably.
    const asADirectory = join(primaryRepo, "CLAUDE.local.md");
    mkdirSync(asADirectory);
    try {
      const key = `worker-${counter}`;
      assert.throws(() => build({ key }));
      assert.equal(existsSync(codexHomeDir(key)), false, "a guard that fires must leave no partial home on disk");
    } finally {
      rmSync(asADirectory, { recursive: true, force: true });
    }
  });
});

describe("the receipt phrase names which instruction layers were found", () => {
  it("names both when global and local are present: 'instructions: global, local'", () => {
    const localPath = join(primaryRepo, "CLAUDE.local.md");
    writeFileSync(localPath, "local");
    try {
      const key = `worker-${counter}`;
      const { instructionLayers } = build({ key, authSource: fakeAuthWithGlobal });
      assert.deepEqual(instructionLayers, ["global", "local"]);
      assert.equal(codexInstructionsPhrase(instructionLayers), "instructions: global, local");
    } finally {
      rmSync(localPath, { force: true });
    }
  });

  it("names only global when no local override file exists", () => {
    const key = `worker-${counter}`;
    const { instructionLayers } = build({ key, authSource: fakeAuthWithGlobal });
    assert.deepEqual(instructionLayers, ["global"]);
    assert.equal(codexInstructionsPhrase(instructionLayers), "instructions: global");
  });

  it("names only local when no global file exists", () => {
    const localPath = join(primaryRepo, "CLAUDE.local.md");
    writeFileSync(localPath, "local");
    try {
      const key = `worker-${counter}`;
      const { instructionLayers } = build({ key, authSource: fakeAuthNoGlobal });
      assert.deepEqual(instructionLayers, ["local"]);
      assert.equal(codexInstructionsPhrase(instructionLayers), "instructions: local");
    } finally {
      rmSync(localPath, { force: true });
    }
  });

  it("is undefined (omitted, not an empty phrase) when neither layer is present", () => {
    const key = `worker-${counter}`;
    const { instructionLayers } = build({ key, authSource: fakeAuthNoGlobal });
    assert.deepEqual(instructionLayers, []);
    assert.equal(codexInstructionsPhrase(instructionLayers), undefined);
  });
});
