import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pluginDir = join(repoRoot, "claude-plugin");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

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
    // The trap this plugin exists to avoid. ${CLAUDE_PLUGIN_ROOT} is the path
    // the plugin was FOUND at, which for the documented symlink install is
    // ~/.claude/skills/hive. node normalizes ".." lexically before touching
    // the filesystem, so "<root>/../dist/kickoff.js" collapses to
    // ~/.claude/skills/dist/kickoff.js and dies with MODULE_NOT_FOUND.
    const raw = readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8");
    assert.doesNotMatch(raw, /\.\./, "a '..' in the hook command breaks the symlink install");
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
    // Exactly the documented install: a symlink whose target is the checkout.
    // Running the shim through it is what proves the path resolution above.
    const skills = mkdtempSync(join(tmpdir(), "hive-skills-"));
    const link = join(skills, "hive");
    symlinkSync(pluginDir, link);
    after(() => rmSync(skills, { recursive: true, force: true }));

    const elsewhere = mkdtempSync(join(tmpdir(), "hive-elsewhere-"));
    after(() => rmSync(elsewhere, { recursive: true, force: true }));

    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
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

    // The literal string the hook would have carried, unnormalized: node is
    // what collapses it, not the kernel. `test -f` on this same path succeeds.
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
