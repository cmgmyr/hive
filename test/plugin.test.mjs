import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pluginDir = join(repoRoot, "claude-plugin");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.notEqual(match, null, "SKILL.md must open with a --- frontmatter block");
  return Object.fromEntries(
    match[1]
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(":");
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      }),
  );
}

// Every backticked relative path in a skill's own body, resolved from the skill's directory -
// the same way a symlinked plugin install resolves them at read time.
function relativeReferencesIn(markdown) {
  const found = new Set();
  for (const m of markdown.matchAll(/`(references\/[\w./-]+\.md)`/g)) found.add(m[1]);
  return [...found];
}

describe("claude-plugin manifest", () => {
  it("declares a loadable plugin", () => {
    const manifest = readJson(join(pluginDir, ".claude-plugin", "plugin.json"));
    assert.equal(manifest.name, "hive");
    assert.equal(typeof manifest.description, "string");
  });

  it("registers exactly one SessionStart hook, pointing at the shim", () => {
    const hooks = readJson(join(pluginDir, "hooks", "hooks.json")).hooks;
    assert.deepEqual(Object.keys(hooks), ["SessionStart"]);
    const commands = hooks.SessionStart.flatMap((entry) => entry.hooks.map((h) => h.command));
    assert.equal(commands.length, 1);
    assert.match(commands[0], /\$\{CLAUDE_PLUGIN_ROOT\}\/kickoff\.mjs/);
  });

  it("keeps '..' out of the hook command", () => {

    const raw = readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8");
    assert.doesNotMatch(raw, /\.\./, "a '..' in the hook command breaks the symlink install");
  });
});

describe("claude-plugin skills", () => {
  it("ships a cleanup skill with parseable frontmatter matching its directory name", () => {
    const skillPath = join(pluginDir, "skills", "cleanup", "SKILL.md");
    assert.equal(existsSync(skillPath), true);
    const frontmatter = parseFrontmatter(readFileSync(skillPath, "utf8"));
    assert.equal(frontmatter.name, "cleanup");
    assert.equal(typeof frontmatter.description, "string");
    assert.notEqual(frontmatter.description.length, 0);
  });

  it("ships a profile skill with parseable frontmatter matching its directory name", () => {
    const skillPath = join(pluginDir, "skills", "profile", "SKILL.md");
    assert.equal(existsSync(skillPath), true);
    const raw = readFileSync(skillPath, "utf8");
    const frontmatter = parseFrontmatter(raw);
    assert.equal(frontmatter.name, "profile");
    assert.equal(typeof frontmatter.description, "string");
    assert.notEqual(frontmatter.description.length, 0);
  });

  it("resolves every relative reference the profile skill's body links, from its installed directory", () => {
    const skillDir = join(pluginDir, "skills", "profile");
    const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const refs = relativeReferencesIn(body);
    assert.ok(refs.length > 0, "SKILL.md should link at least one reference");
    for (const ref of refs) {
      assert.equal(existsSync(join(skillDir, ref)), true, `SKILL.md links ${ref}, which does not exist`);
    }
  });

  it("resolves every relative reference the profile skill links through a symlinked install, same as the cleanup skill's shim", () => {
    const skills = mkdtempSync(join(tmpdir(), "hive-skills-profile-"));
    const link = join(skills, "hive");
    symlinkSync(pluginDir, link);
    after(() => rmSync(skills, { recursive: true, force: true }));

    const skillDir = join(link, "skills", "profile");
    const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    for (const ref of relativeReferencesIn(body)) {
      assert.equal(existsSync(join(skillDir, ref)), true, `via the symlink, ${ref} does not resolve`);
    }
  });

  it("keeps the profile skill's reference and recipe directories free of stray files npm pack would skip silently", () => {
    const refsDir = join(pluginDir, "skills", "profile", "references");
    for (const dir of [refsDir, join(refsDir, "recipes")]) {
      const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
      assert.ok(files.length > 0, `${dir} should not be empty`);
      for (const f of files) assert.match(f.name, /\.md$/, `${join(dir, f.name)} is not a .md reference file`);
    }
  });
});

describe("claude-plugin shim", () => {
  it("resolves hive's built kickoff from inside the checkout", async () => {
    const shim = readFileSync(join(pluginDir, "kickoff.mjs"), "utf8");
    assert.match(shim, /\.\.\/dist\/kickoff\.js/);
    assert.equal(existsSync(join(repoRoot, "dist", "kickoff.js")), true);
    const { runKickoff } = await import("../dist/kickoff.js");
    assert.equal(typeof runKickoff, "function");
  });

  it("runs through a symlinked plugin directory", () => {

    const skills = mkdtempSync(join(tmpdir(), "hive-skills-"));
    const link = join(skills, "hive");
    symlinkSync(pluginDir, link);
    after(() => rmSync(skills, { recursive: true, force: true }));

    const elsewhere = mkdtempSync(join(tmpdir(), "hive-elsewhere-"));
    after(() => rmSync(elsewhere, { recursive: true, force: true }));

    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
    env.HIVE_DATA_DIR = join(elsewhere, "data");
    const out = execFileSync("node", [join(link, "kickoff.mjs"), "--explain"], {
      cwd: elsewhere,
      encoding: "utf8",
      env,
    });
    assert.match(out, /silent \(no hive\.yml here\)/);
  });

  it("would fail with the '..' form, which is why the shim exists", () => {
    const skills = mkdtempSync(join(tmpdir(), "hive-skills-dotdot-"));
    const link = join(skills, "hive");
    symlinkSync(pluginDir, link);
    after(() => rmSync(skills, { recursive: true, force: true }));

    const dotdot = `${link}/../dist/kickoff.js`;
    assert.equal(existsSync(dotdot), true, "the kernel resolves this path fine");

    let failed = false;
    try {
      execFileSync("node", [dotdot], { stdio: "ignore" });
    } catch {
      failed = true;
    }
    assert.equal(failed, true, "if this ever passes, node stopped normalizing '..' lexically");
  });
});
