import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseToml } from "smol-toml";
import { assertScratchStore, clearHiveEnv, isolateTmux, scratchDirs, CLI, REPO } from "./helpers.mjs";

const { cleanup } = isolateTmux("project-move tests");
clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
migrate();

const root = dirs.projectDir;
const home = join(dirs.tmp, "home");
const configHome = join(dirs.tmp, "claude-config");
const codexHome = join(dirs.tmp, "codex-home");
const binHome = join(dirs.tmp, "bin");
for (const path of [home, configHome, codexHome, binHome]) mkdirSync(path, { recursive: true });

function env(overrides = {}) {
  return {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configHome,
    CODEX_HOME: codexHome,
    HIVE_BIN_DIR: binHome,
    HIVE_DATA_DIR: dirs.dataDir,
    ...overrides,
  };
}

function project(name, path) {
  mkdirSync(path, { recursive: true });
  return db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get(name, realpathSync(path)).id;
}

function agent(projectId, { cwd, transcript = "", codexHomeKey = "", status = "closed", kind = "agent" } = {}) {
  return db.prepare(
    "INSERT INTO agents (project_id, name, kind, command, cwd, transcript_path, codex_home, status) VALUES (?, 'fixture', ?, 'codex', ?, ?, ?, ?) RETURNING id",
  ).get(projectId, kind, cwd, transcript, codexHomeKey, status).id;
}

function cli(cwd, args, overrides = {}) {
  return spawnSync(process.execPath, [CLI, "project", "mv", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: env(overrides),
  });
}

function assertOk(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function c1(path) {
  const clean = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (clean.length <= 200) return clean;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash << 5) - hash + path.charCodeAt(i) | 0;
  return `${clean.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function sha(path) {
  return readFileSync(path).toString("hex");
}

function git(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initGit(path) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", path, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "initial"], { stdio: "ignore" });
}

after(() => {
  cleanup();
  rmSync(dirs.projectDir, { recursive: true, force: true });
  rmSync(dirs.tmp, { recursive: true, force: true });
  rmSync(dirs.dataDir, { recursive: true, force: true });
});

describe("hive project mv", () => {
  it("project mv preview writes nothing and apply is explicit", () => {
    const old = join(root, "preview-old");
    const next = join(root, "preview-new");
    const id = project("preview", old);
    db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'start', 'kept')").run(id);
    const previewClaude = join(dirs.tmp, "preview-claude");
    const previewCodex = join(dirs.tmp, "preview-codex");
    mkdirSync(previewClaude, { recursive: true });
    mkdirSync(previewCodex, { recursive: true });
    const claudeFile = join(previewClaude, ".claude.json");
    const claudeStorage = join(previewClaude, "projects", c1(realpathSync(old)));
    const codexFile = join(previewCodex, "config.toml");
    mkdirSync(claudeStorage, { recursive: true });
    writeFileSync(join(claudeStorage, "marker"), "kept");
    writeFileSync(claudeFile, JSON.stringify({ projects: { [realpathSync(old)]: { trusted: true } } }, null, 2));
    writeFileSync(codexFile, `[projects.${JSON.stringify(realpathSync(old))}]\ntrust_level = "trusted"\n`);
    const claudeBefore = sha(claudeFile);
    const codexBefore = sha(codexFile);
    const previewEnv = { CLAUDE_CONFIG_DIR: previewClaude, CODEX_HOME: previewCodex };
    const preview = cli(old, [next], previewEnv);
    const output = assertOk(preview);
    assert.match(output, /Preview only/);
    assert.match(output, /exit Claude Code and Codex/);
    assert.match(output, /codex resume --all/);
    assert.ok(existsSync(old));
    assert.equal(existsSync(next), false);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, realpathSync(old));
    assert.equal(sha(claudeFile), claudeBefore);
    assert.equal(sha(codexFile), codexBefore);
    assert.equal(existsSync(join(claudeStorage, "marker")), true);
    assert.equal(readdirSync(previewClaude).some((name) => name.endsWith(".bak")), false);
    assert.match(assertOk(cli(old, [next, "--dry-run"], previewEnv)), /Preview only/);
    assert.ok(existsSync(old));
    assert.equal(existsSync(next), false);
    assert.equal(sha(claudeFile), claudeBefore);
    assert.equal(sha(codexFile), codexBefore);

    const applied = assertOk(cli(old, [next, "--apply"], previewEnv));
    assert.match(applied, /Project .* now resolves/);
    assert.equal(existsSync(old), false);
    assert.ok(existsSync(next));
    assert.equal(JSON.parse(readFileSync(claudeFile, "utf8")).projects[realpathSync(next)].trusted, true);
    assert.ok(readFileSync(codexFile, "utf8").includes(realpathSync(next)));
    assert.equal(readFileSync(join(previewClaude, "projects", c1(realpathSync(next)), "marker"), "utf8"), "kept");
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, realpathSync(next));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM command_trust WHERE project_id = ? AND config_hash = 'kept'").get(id).n, 1);
    assert.match(assertOk(cli(next, [next, "--apply"], previewEnv)), /No changes\./);
  });

  it("project mv repairs a hand move without registration", () => {
    const projectsBefore = db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
    const old = join(root, "hand-old");
    const next = join(root, "hand-new");
    const id = project("hand", old);
    execFileSync("mv", [old, next]);
    const out = assertOk(cli(root, [next, "--project-id", String(id), "--apply"]));
    assert.match(out, /Checkout already moved/);
    assert.equal(db.prepare("SELECT id, path FROM projects WHERE id = ?").get(id).path, realpathSync(next));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE path = ?").get(realpathSync(next)).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n, projectsBefore + 1);
  });

  it("project mv reruns observed partial states and then no-ops", () => {
    const old = join(root, "partial-old");
    const next = join(root, "partial-new");
    const id = project("partial", old);
    const oldPath = realpathSync(old);
    execFileSync("mv", [old, next]);
    const newPath = realpathSync(next);
    const config = join(configHome, ".claude.json");
    const oldStorage = join(configHome, "projects", c1(oldPath));
    const newStorage = join(configHome, "projects", c1(newPath));
    mkdirSync(newStorage, { recursive: true });
    writeFileSync(join(newStorage, "session.jsonl"), "unchanged\n");
    writeFileSync(config, JSON.stringify({ projects: { [newPath]: { trust: true } } }));
    const row = agent(id, { cwd: oldPath, transcript: join(oldStorage, "session.jsonl") });
    const contentBefore = sha(join(newStorage, "session.jsonl"));

    const output = assertOk(cli(root, [next, "--project-id", String(id), "--apply"]));
    assert.match(output, /Claude storage: no directory rename needed/);
    assert.equal(existsSync(oldStorage), false);
    assert.equal(sha(join(newStorage, "session.jsonl")), contentBefore);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, newPath);
    assert.equal(db.prepare("SELECT transcript_path FROM agents WHERE id = ?").get(row).transcript_path, join(newStorage, "session.jsonl"));
    assert.match(assertOk(cli(next, [next, "--project-id", String(id), "--apply"])), /No changes\./);
  });

  it("project mv renames checkout and refuses EXDEV", () => {
    const old = join(root, "exdev old $HOME 'quoted'");
    const next = join(root, "exdev-new");
    const id = project("exdev", old);
    const preloader = join(dirs.tmp, "block-rename.mjs");
    writeFileSync(preloader, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const rename = fs.renameSync; fs.renameSync = (from, to, ...rest) => { if (from === ${JSON.stringify(old)}) { const error = new Error("cross device"); error.code = "EXDEV"; throw error; } return rename(from, to, ...rest); }; syncBuiltinESMExports();\n`);
    const result = cli(old, [next, "--apply"], { NODE_OPTIONS: `--import=${preloader}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /crosses filesystems/);
    assert.match(result.stdout, /Move it by hand/);
    const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
    assert.ok(result.stdout.includes(`cd ${quote(next)} && hive project mv ${quote(next)} --project-id ${id} --apply`));
    assert.ok(existsSync(old));
    assert.equal(existsSync(next), false);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, realpathSync(old));
    const validOld = join(root, "exdev-control-old");
    const validNew = join(root, "exdev-control-new");
    const validId = project("exdev-control", validOld);
    assertOk(cli(validOld, [validNew, "--apply"]));
    assert.equal(existsSync(validOld), false);
    assert.ok(existsSync(validNew));
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(validId).path, realpathSync(validNew));
  });

  it("project mv refuses running agents and prints offline rule", () => {
    const old = join(root, "guard-old");
    const next = join(root, "guard-new");
    const id = project("guard", old);
    let result = cli(old, [next, "--dry-run", "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /either --dry-run or --apply/);
    assert.ok(existsSync(old));

    const projectsBeforeMissing = db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;
    result = cli(root, [next]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /exact checkout path/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get().n, projectsBeforeMissing);

    agent(id, { cwd: old, status: "running", kind: "lead" });
    result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /running hive agents/);
    assert.ok(existsSync(old));
    assert.equal(existsSync(next), false);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, realpathSync(old));
  });

  it("project mv refuses all collisions and ambiguous layouts", () => {
    const old = join(root, "collision-old");
    const next = join(root, "collision-new");
    const id = project("collision", old);
    const other = project("occupied", join(next, "child"));
    let result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /overlaps registered project/);
    assert.ok(existsSync(old));
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, realpathSync(old));
    assert.ok(other > id);

    const nestedTarget = join(old, "nested-target");
    result = cli(old, [nestedTarget, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /paths overlap/);
    assert.ok(existsSync(old));

    const sibling = join(root, "collision-sibling");
    mkdirSync(sibling);
    result = cli(old, [sibling, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Both source and destination checkouts exist/);
    assert.ok(existsSync(old));
  });

  it("project mv repoints owned rows and Claude transcript paths", () => {
    const old = join(root, "rows-old");
    const next = join(root, "rows-new");
    const id = project("rows", old);
    const oldPath = realpathSync(old);
    const claudeProjects = join(configHome, "projects");
    const storage = join(claudeProjects, c1(oldPath));
    mkdirSync(storage, { recursive: true });
    const transcript = join(storage, "session.jsonl");
    writeFileSync(join(configHome, ".claude.json"), JSON.stringify({ projects: { [oldPath]: { trusted: true } } }));
    writeFileSync(transcript, "unchanged transcript\n");
    const worker = agent(id, { cwd: join(old, "nested", "worktree"), transcript });
    const siblingTranscript = join(claudeProjects, c1(`${oldPath}-extra`), "session.jsonl");
    agent(id, { cwd: `${old}-extra/worktree`, transcript: siblingTranscript });
    db.prepare("INSERT INTO lead_turn_state (agent_id, transcript_path) VALUES (?, ?)").run(worker, transcript);
    const transcriptBefore = sha(transcript);

    assertOk(cli(old, [next, "--apply"]));
    const rows = db.prepare("SELECT cwd, transcript_path FROM agents WHERE project_id = ? ORDER BY id").all(id);
    assert.equal(rows[0].cwd, join(realpathSync(next), "nested", "worktree"));
    assert.equal(rows[0].transcript_path, join(configHome, "projects", c1(realpathSync(next)), "session.jsonl"));
    assert.equal(rows[1].cwd, `${oldPath}-extra/worktree`);
    assert.equal(rows[1].transcript_path, siblingTranscript);
    assert.equal(db.prepare("SELECT transcript_path FROM lead_turn_state WHERE agent_id = ?").get(worker).transcript_path, rows[0].transcript_path);
    assert.equal(sha(join(configHome, "projects", c1(realpathSync(next)), "session.jsonl")), transcriptBefore);

    const absentOld = join(root, "rows-absent-old");
    const absentNext = join(root, "rows-absent-new");
    const absentId = project("rows-absent", absentOld);
    const absentTranscript = join(configHome, "projects", c1(realpathSync(absentOld)), "missing-session.jsonl");
    const absentAgent = agent(absentId, { cwd: absentOld, transcript: absentTranscript });
    assertOk(cli(absentOld, [absentNext, "--apply"]));
    assert.equal(db.prepare("SELECT transcript_path FROM agents WHERE id = ?").get(absentAgent).transcript_path, join(configHome, "projects", c1(realpathSync(absentNext)), "missing-session.jsonl"));
    assert.equal(existsSync(join(configHome, "projects", c1(realpathSync(absentNext)))), false);
  });

  it("project mv moves Claude storage and scoped config keys", () => {
    const deepBase = join(root, "long-path");
    mkdirSync(deepBase, { recursive: true });
    let parent = deepBase;
    for (let i = 0; i < 7; i++) { parent = join(parent, `${String(i).repeat(35)}-${i}`); mkdirSync(parent); }
    const old = join(parent, "old");
    const next = join(parent, "new");
    const id = project("claude-keys", old);
    const oldPath = realpathSync(old);
    const descendantOld = join(oldPath, "child");
    const descendantNew = join(realpathSync(parent), "new", "child");
    const configFile = join(configHome, ".claude.json");
    const unrelatedValue = { hasTrustDialogAccepted: true, mcpServers: { local: { command: "/usr/bin/true" } } };
    const configText = ` {\n  "other": {"keep": 1},\n  "projects": {\n    ${JSON.stringify(oldPath)}: ${JSON.stringify(unrelatedValue)},\n    ${JSON.stringify(descendantOld)}: {"trusted": 2},\n    "/unrelated/project": {"keep": 3}\n  },\n  "tail": [1, 2]\n}\n`;
    writeFileSync(configFile, configText);
    const history = join(configHome, "history.jsonl");
    const pluginState = join(configHome, "plugins", "installed_plugins.json");
    mkdirSync(dirname(pluginState), { recursive: true });
    writeFileSync(history, "history stays byte-identical\n");
    writeFileSync(pluginState, "plugin state stays byte-identical\n");
    const historyBefore = sha(history);
    const pluginStateBefore = sha(pluginState);
    const storageRoot = join(configHome, "projects");
    const storage = join(storageRoot, c1(oldPath));
    const descendantStorage = join(storageRoot, c1(descendantOld));
    mkdirSync(storage, { recursive: true });
    mkdirSync(descendantStorage, { recursive: true });
    writeFileSync(join(storage, "marker"), "same");
    writeFileSync(join(descendantStorage, "marker"), "same child");

    assertOk(cli(old, [next, "--apply"]));
    const after = readFileSync(configFile, "utf8");
    const parsed = JSON.parse(after);
    assert.deepEqual(parsed.projects[realpathSync(next)], unrelatedValue);
    assert.deepEqual(parsed.projects[descendantNew], { trusted: 2 });
    assert.deepEqual(parsed.projects["/unrelated/project"], { keep: 3 });
    assert.match(after, /"other": \{"keep": 1\}/);
    assert.match(after, /"tail": \[1, 2\]/);
    assert.equal(readFileSync(join(storageRoot, c1(realpathSync(next)), "marker"), "utf8"), "same");
    assert.equal(readFileSync(join(storageRoot, c1(descendantNew), "marker"), "utf8"), "same child");
    assert.equal(sha(history), historyBefore);
    assert.equal(sha(pluginState), pluginStateBefore);
    assert.equal(c1(oldPath).length, 200 + 1 + Math.abs((() => { let h = 0; for (let i = 0; i < oldPath.length; i++) h = (h << 5) - h + oldPath.charCodeAt(i) | 0; return h; })()).toString(36).length);
    assert.equal(existsSync(storage), false);
    assert.equal(existsSync(descendantStorage), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM command_trust WHERE project_id = ?").get(id).n, 0);
  });

  it("project mv keeps same-key Claude storage in place and refuses storage or key collisions", () => {
    const old = join(root, "same-key", "a.b");
    const next = join(root, "same-key", "a-b");
    mkdirSync(dirname(old), { recursive: true });
    const id = project("same-key", old);
    const storage = join(configHome, "projects", c1(realpathSync(old)));
    mkdirSync(storage, { recursive: true });
    writeFileSync(join(storage, "marker"), "kept");
    const config = join(configHome, ".claude.json");
    writeFileSync(config, JSON.stringify({ projects: { [realpathSync(old)]: { trust: true } } }));
    assert.equal(c1(realpathSync(old)), c1(next));
    assertOk(cli(old, [next, "--apply"]));
    assert.equal(readFileSync(join(storage, "marker"), "utf8"), "kept");
    assert.equal(JSON.parse(readFileSync(config, "utf8")).projects[realpathSync(next)].trust, true);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, realpathSync(next));

    const collisionOld = join(root, "storage-collision-old");
    const collisionNew = join(root, "storage-collision-new");
    const collisionId = project("storage-collision", collisionOld);
    writeFileSync(config, JSON.stringify({ projects: { [realpathSync(collisionOld)]: { trust: true } } }));
    mkdirSync(join(configHome, "projects", c1(realpathSync(collisionOld))), { recursive: true });
    mkdirSync(join(configHome, "projects", c1(collisionNew)), { recursive: true });
    const refused = cli(collisionOld, [collisionNew, "--apply"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /Both Claude storage directories exist/);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(collisionId).path, realpathSync(collisionOld));
    assert.ok(existsSync(collisionOld));

    const linkOld = join(root, "storage-link-old");
    const linkNext = join(root, "storage-link-new");
    const linkId = project("storage-link", linkOld);
    const foreignStorage = join(configHome, "projects", "foreign-owner");
    const linkedStorage = join(configHome, "projects", c1(realpathSync(linkOld)));
    mkdirSync(foreignStorage, { recursive: true });
    writeFileSync(join(foreignStorage, "marker"), "owned by another path");
    symlinkSync(foreignStorage, linkedStorage);
    writeFileSync(config, JSON.stringify({ projects: { [realpathSync(linkOld)]: { trust: true } } }));
    const symlinkRefused = cli(linkOld, [linkNext, "--apply"]);
    assert.notEqual(symlinkRefused.status, 0);
    assert.match(symlinkRefused.stdout, /Claude storage is not a directory/);
    assert.ok(existsSync(linkOld));
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(linkId).path, realpathSync(linkOld));
    assert.equal(readFileSync(join(foreignStorage, "marker"), "utf8"), "owned by another path");
    rmSync(linkedStorage);

    const keyOld = join(root, "key-collision-old");
    const keyNew = join(root, "key-collision-new");
    project("key-collision", keyOld);
    writeFileSync(config, JSON.stringify({ projects: { [realpathSync(keyOld)]: { trusted: true }, [keyNew]: { other: true } } }));
    const keyRefused = cli(keyOld, [keyNew, "--apply"]);
    assert.notEqual(keyRefused.status, 0);
    assert.match(keyRefused.stdout, /Claude project key collision/);
    assert.ok(existsSync(keyOld));

    const codexOld = join(root, "codex-collision-old");
    const codexNew = join(root, "codex-collision-new");
    project("codex-collision", codexOld);
    writeFileSync(config, "{}");
    writeFileSync(join(codexHome, "config.toml"), `[projects.${JSON.stringify(realpathSync(codexOld))}]\ntrust_level = "trusted"\n\n[projects.${JSON.stringify(codexNew)}]\ntrust_level = "trusted"\n`);
    const codexRefused = cli(codexOld, [codexNew, "--apply"]);
    assert.notEqual(codexRefused.status, 0);
    assert.match(codexRefused.stdout, /Codex project key collision/);
    assert.ok(existsSync(codexOld));
  });

  it("project mv moves only Codex trust keys and prints resume all", () => {
    const old = join(root, "codex-old");
    const next = join(root, "codex-new");
    const id = project("codex", old);
    const key = "worker-key";
    const workerHome = join(dirs.dataDir, "codex-homes", key);
    mkdirSync(workerHome, { recursive: true });
    const oldRoot = realpathSync(old);
    const globalConfig = join(codexHome, "config.toml");
    const workerConfig = join(workerHome, "config.toml");
    const unrelatedConfig = join(dirs.tmp, "other-codex", "config.toml");
    mkdirSync(dirname(unrelatedConfig), { recursive: true });
    const unrelatedProject = project("unrelated-codex", join(root, "unrelated-codex"));
    const unrelatedHome = join(dirs.dataDir, "codex-homes", "unrelated-key");
    mkdirSync(unrelatedHome, { recursive: true });
    const unrelatedWorkerConfig = join(unrelatedHome, "config.toml");
    const globalBefore = `# global comment\n[projects.${JSON.stringify(oldRoot)}]\ntrust_level = "trusted"\n\n[projects."/unrelated"]\ntrust_level = "trusted"\n`;
    const workerBefore = `[projects.${JSON.stringify(oldRoot)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(oldRoot)}.tui]\nresume_cwd = true\n[notice]\nvalue = "keep"\n`;
    writeFileSync(globalConfig, globalBefore);
    writeFileSync(workerConfig, workerBefore);
    writeFileSync(unrelatedConfig, globalBefore);
    writeFileSync(unrelatedWorkerConfig, workerBefore);
    agent(unrelatedProject, { cwd: join(root, "unrelated-codex"), codexHomeKey: "unrelated-key" });
    const rollout = join(dirs.dataDir, "codex-rollouts", key, "session.jsonl");
    mkdirSync(dirname(rollout), { recursive: true });
    writeFileSync(rollout, `{"cwd":${JSON.stringify(old)}}\n`);
    const rolloutBefore = sha(rollout);
    const codexIndex = join(workerHome, "state.sqlite");
    writeFileSync(codexIndex, Buffer.from([0, 1, 2, 3, 4, 5]));
    const codexIndexBefore = sha(codexIndex);
    agent(id, { cwd: old, codexHomeKey: key });

    const output = assertOk(cli(old, [next, "--apply"]));
    assert.match(output, /codex resume --all/);
    const globalAfter = readFileSync(globalConfig, "utf8");
    const workerAfter = readFileSync(workerConfig, "utf8");
    assert.ok(globalAfter.includes(`[projects.${JSON.stringify(realpathSync(next))}]`));
    assert.ok(workerAfter.includes(`[projects.${JSON.stringify(realpathSync(next))}]`));
    assert.ok(workerAfter.includes(`[projects.${JSON.stringify(realpathSync(next))}.tui]`));
    assert.equal(globalAfter.includes(`[projects.${JSON.stringify(oldRoot)}]`), false);
    assert.equal(workerAfter.includes(`[projects.${JSON.stringify(oldRoot)}]`), false);
    assert.match(globalAfter, /# global comment/);
    assert.match(globalAfter, /\[projects\."\/unrelated"\]/);
    assert.match(workerAfter, /trust_level = "trusted"/);
    assert.match(workerAfter, /resume_cwd = true/);
    assert.match(workerAfter, /value = "keep"/);
    assert.equal(readFileSync(unrelatedConfig, "utf8"), globalBefore);
    assert.equal(readFileSync(unrelatedWorkerConfig, "utf8"), workerBefore);
    assert.equal(sha(rollout), rolloutBefore);
    assert.equal(sha(codexIndex), codexIndexBefore);
    assert.doesNotThrow(() => parseToml(globalAfter));
  });

  it("project mv refuses malformed Claude and Codex config and stranded executable registrations", () => {
    const old = join(root, "malformed-old");
    const next = join(root, "malformed-new");
    project("malformed", old);
    const claude = join(configHome, ".claude.json");
    writeFileSync(claude, "{ broken");
    let result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /malformed JSON/);
    assert.ok(existsSync(old));
    writeFileSync(claude, "{}");
    writeFileSync(join(codexHome, "config.toml"), "[projects.\"/broken\"\n");
    result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /malformed TOML/);
    assert.ok(existsSync(old));
    writeFileSync(join(codexHome, "config.toml"), "");
    writeFileSync(claude, JSON.stringify({ mcpServers: { hive: { command: "/usr/bin/node", args: [join(old, "dist", "index.js")] } } }));
    result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /MCP registration hive.*old project root/);
    assert.ok(existsSync(old));
    const linkedConfig = join(configHome, "linked-config.json");
    writeFileSync(linkedConfig, "{}");
    rmSync(claude);
    symlinkSync(linkedConfig, claude);
    result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Claude config is not a regular file/);
    assert.ok(existsSync(old));
    rmSync(claude);
    writeFileSync(claude, "{}");
  });

  it("project mv refuses hive checkout and stranded registrations", () => {
    const selfTarget = join(root, "self-target");
    const selfId = project("self", REPO);
    let result = cli(REPO, [selfTarget, "--project-id", String(selfId), "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /own checkout/);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(selfId).path, realpathSync(REPO));
    assert.equal(existsSync(selfTarget), false);

    const old = join(root, "hook-old");
    const next = join(root, "hook-new");
    project("hook", old);
    writeFileSync(join(configHome, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: `${old}/bin/hook` }] }] } }));
    result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Claude hook registration/);
    assert.ok(existsSync(old));
    rmSync(join(configHome, "settings.json"));
    writeFileSync(join(binHome, "hive"), `#!/bin/sh\n# hive dispatcher\nexec '/usr/bin/node' '${old}/dist/cli.js' "$@"\n`);
    result = cli(old, [next, "--apply"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /dispatcher .*points under the old project root/);
    assert.ok(existsSync(old));
    rmSync(join(binHome, "hive"));
  });

  it("project mv refuses an external config changed after preflight", () => {
    const old = join(root, "changed-old");
    const next = join(root, "changed-new");
    const id = project("changed", old);
    const config = join(configHome, ".claude.json");
    writeFileSync(config, JSON.stringify({ projects: { [realpathSync(old)]: { trusted: true } } }));
    const preloader = join(dirs.tmp, "change-config-on-plan.mjs");
    writeFileSync(preloader, `import fs from "node:fs"; const write = process.stdout.write.bind(process.stdout); let changed = false; process.stdout.write = (chunk, ...args) => { if (!changed && String(chunk).includes("Recovery command:")) { changed = true; fs.writeFileSync(${JSON.stringify(config)}, "{\\"manual\\":true}\\n"); } return write(chunk, ...args); };\n`);
    const result = cli(old, [next, "--apply"], { NODE_OPTIONS: `--import=${preloader}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Input changed since preview/);
    assert.match(result.stdout, new RegExp(`--project-id ${id} --apply`));
    assert.ok(existsSync(next), "the earlier checkout rename is reported as completed");
    assert.equal(readFileSync(config, "utf8"), "{\"manual\":true}\n");
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(id).path, old);
  });

  it("project mv backs up external files and stops on conflict", () => {
    const old = join(root, "backup-old");
    const next = join(root, "backup-new");
    project("backup", old);
    const backupConfigHome = join(dirs.tmp, "backup-config-home");
    mkdirSync(backupConfigHome, { recursive: true });
    const config = join(backupConfigHome, ".claude.json");
    const original = JSON.stringify({ projects: { [realpathSync(old)]: { trusted: true } } }, null, 2);
    writeFileSync(config, original);
    const orderPreloader = join(dirs.tmp, "assert-backup-before-config-write.mjs");
    writeFileSync(orderPreloader, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const rename = fs.renameSync; fs.renameSync = (from, to, ...rest) => { if (to === ${JSON.stringify(config)} && !fs.readdirSync(${JSON.stringify(backupConfigHome)}).some((name) => name.endsWith(".bak"))) throw new Error("config write preceded backup"); return rename(from, to, ...rest); }; syncBuiltinESMExports();\n`);
    const output = assertOk(cli(old, [next, "--apply"], { CLAUDE_CONFIG_DIR: backupConfigHome, NODE_OPTIONS: `--import=${orderPreloader}` }));
    const backup = /Backup: (.+\.hive-mv-[^\n]+\.bak)/.exec(output)?.[1];
    assert.ok(backup);
    assert.equal(readFileSync(backup, "utf8"), original);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.ok(output.indexOf(`Backup: ${backup}`) < output.indexOf(`Updated config: ${config}`));

    const failOld = join(root, "backup-fail-old");
    const failNext = join(root, "backup-fail-new");
    const failId = project("backup-fail", failOld);
    const failConfig = join(configHome, ".claude.json");
    writeFileSync(failConfig, JSON.stringify({ projects: { [realpathSync(failOld)]: { trusted: true } } }));
    const preloader = join(dirs.tmp, "block-copy.mjs");
    writeFileSync(preloader, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const write = fs.writeFileSync; fs.writeFileSync = (path, ...args) => { if (String(path).endsWith(".bak")) throw new Error("blocked backup"); return write(path, ...args); }; syncBuiltinESMExports();\n`);
    const failed = cli(failOld, [failNext, "--apply"], { NODE_OPTIONS: `--import=${preloader}` });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /Could not create a private backup/);
    assert.match(failed.stdout, /Recovery: .*--project-id .*--apply/);
    assert.ok(existsSync(failNext), "checkout rename is a completed step");
    assert.equal(readFileSync(failConfig, "utf8").includes(failOld), true);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(failId).path, failOld);
    const repaired = assertOk(cli(root, [failNext, "--project-id", String(failId), "--apply"]));
    assert.match(repaired, /now resolves/);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(failId).path, realpathSync(failNext));
  });

  it("project mv repairs mapped nested and external worktrees", () => {
    const unreadable = join(root, "git-unreadable");
    const unreadableTarget = join(root, "git-unreadable-moved");
    const unreadableId = project("git-unreadable", unreadable);
    mkdirSync(join(unreadable, ".git"));
    const noGitPath = join(dirs.tmp, "no-git-bin");
    mkdirSync(noGitPath);
    const unavailable = cli(unreadable, [unreadableTarget, "--apply"], { PATH: noGitPath });
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stdout, /Git metadata exists but cannot be read safely/);
    assert.ok(existsSync(unreadable));
    assert.equal(existsSync(unreadableTarget), false);
    assert.equal(db.prepare("SELECT path FROM projects WHERE id = ?").get(unreadableId).path, realpathSync(unreadable));

    const old = join(root, "git-old");
    const next = join(root, "git-new");
    const nested = join(old, ".agents", "worktrees", "nested");
    const external = join(root, "git-external");
    initGit(old);
    execFileSync("git", ["-C", old, "worktree", "add", "-q", "-b", "nested-branch", nested], { stdio: "ignore" });
    execFileSync("git", ["-C", old, "worktree", "add", "-q", "-b", "external-branch", external], { stdio: "ignore" });
    const projectId = project("git-move", old);
    const nestedLead = agent(projectId, { cwd: nested, status: "closed", kind: "lead" });
    const externalWorker = agent(projectId, { cwd: external, status: "closed" });
    const movedNested = join(next, ".agents", "worktrees", "nested");
    assertOk(cli(old, [next, "--apply"]));
    for (const tree of [next, movedNested, external]) {
      assert.doesNotThrow(() => git(["status", "--short"], tree));
      assert.ok(git(["rev-parse", "--git-common-dir"], tree).includes(".git"));
    }
    const oldCommon = realpathSync(join(next, ".git"));
    assert.equal(realpathSync(resolve(next, git(["rev-parse", "--git-common-dir"], next))), oldCommon);
    assert.equal(realpathSync(resolve(movedNested, git(["rev-parse", "--git-common-dir"], movedNested))), oldCommon);
    assert.equal(db.prepare("SELECT cwd FROM agents WHERE id = ?").get(nestedLead).cwd, movedNested);
    assert.equal(db.prepare("SELECT cwd FROM agents WHERE id = ?").get(externalWorker).cwd, external);
    assert.ok(existsSync(external));
  });
});
