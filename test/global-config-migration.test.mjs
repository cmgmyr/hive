import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

import {
  clearHiveEnv,
  McpClient,
  isolateTmux,
  makeFakeClaude,
  REPO,
  runCli,
  scratchDirs,
} from "./helpers.mjs";

clearHiveEnv();
const { hasTmux, cleanup } = isolateTmux("global config migration");
const bootstrap = scratchDirs();
mkdirSync(bootstrap.dataDir, { recursive: true });
process.env.HIVE_DATA_DIR = bootstrap.dataDir;
const { migrateLegacyConfig } = await import("../dist/globalConfig.js");
const { sessionName } = await import("../dist/tmux.js");

function fixture() {
  const dirs = scratchDirs();
  mkdirSync(dirs.dataDir, { recursive: true });
  process.env.HIVE_DATA_DIR = dirs.dataDir;
  return { ...dirs, globalPath: join(dirs.dataDir, "hive.yml"), legacyPath: join(dirs.dataDir, "config.json") };
}

function artifactNames(dataDir) {
  return readdirSync(dataDir)
    .filter((name) => name === "hive.yml" || name === "config.json" || name === "config.json.migrated" ||
      (name.startsWith(".hive.yml.") && name.endsWith(".tmp")))
    .sort();
}

function originalLegacy(bytes) {
  writeFileSync(bytes.legacyPath, bytes.content);
  return readFileSync(bytes.legacyPath, "utf8");
}

describe("legacy config migration", () => {
  it("migrates legacy keys into a missing global hive.yml and archives exact bytes", () => {
    const dirs = fixture();
    const content = '{"attach":"raw","autoAttach":"on","future":{"nested":true},"review_tags":["leave archived"]}\n';
    const bytes = originalLegacy({ legacyPath: dirs.legacyPath, content });

    const result = migrateLegacyConfig();

    assert.equal(result.migrated, true);
    assert.equal(result.warnings.length, 0);
    assert.match(result.notice, /migrated .*config\.json into .*hive\.yml/);
    assert.deepEqual(parse(readFileSync(dirs.globalPath, "utf8")), {
      attach: "raw",
      autoAttach: "on",
      future: { nested: true },
    });
    assert.equal(readFileSync(`${dirs.legacyPath}.migrated`, "utf8"), bytes);
    assert.equal(existsSync(dirs.legacyPath), false);
    assert.equal(statSync(dirs.globalPath).mode & 0o777, 0o600);
    assert.deepEqual(artifactNames(dirs.dataDir), ["config.json.migrated", "hive.yml"]);
  });

  it("existing YAML keys including null win legacy conflicts", () => {
    const dirs = fixture();
    const current = "# keep current settings\nattach: null\nfuture: yaml\n";
    writeFileSync(dirs.globalPath, current);
    const content = '{"attach":"raw","autoAttach":"off","future":"legacy"}\n';
    const bytes = originalLegacy({ legacyPath: dirs.legacyPath, content });

    const result = migrateLegacyConfig();

    assert.equal(result.migrated, true);
    assert.deepEqual(parse(readFileSync(dirs.globalPath, "utf8")), {
      attach: null,
      future: "yaml",
      autoAttach: "off",
    });
    assert.equal(readFileSync(`${dirs.legacyPath}.migrated`, "utf8"), bytes);
  });

  it("migration preserves global comments ordering and unrelated keys", () => {
    const dirs = fixture();
    const original = "# user comment\nfirst: one\n# comment for future\nfuture: keep\n";
    writeFileSync(dirs.globalPath, original);
    writeFileSync(dirs.legacyPath, '{"attach":"control","future":"legacy","later":true}\n');

    const result = migrateLegacyConfig();
    const after = readFileSync(dirs.globalPath, "utf8");

    assert.equal(result.migrated, true);
    assert.ok(after.indexOf("# user comment") < after.indexOf("first: one"));
    assert.ok(after.indexOf("first: one") < after.indexOf("# comment for future"));
    assert.ok(after.indexOf("# comment for future") < after.indexOf("future: keep"));
    assert.ok(after.indexOf("future: keep") < after.indexOf("attach: control"));
    assert.ok(after.indexOf("attach: control") < after.indexOf("later: true"));
    assert.deepEqual(parse(after), { first: "one", future: "keep", attach: "control", later: true });
  });

  it("migration is a no-op after the legacy file is archived", () => {
    const dirs = fixture();
    const content = '{"attach":"raw"}\n';
    originalLegacy({ legacyPath: dirs.legacyPath, content });
    const first = migrateLegacyConfig();
    const globalBytes = readFileSync(dirs.globalPath, "utf8");
    const archiveBytes = readFileSync(`${dirs.legacyPath}.migrated`, "utf8");
    const before = artifactNames(dirs.dataDir);

    const second = migrateLegacyConfig();

    assert.equal(first.migrated, true);
    assert.deepEqual(second, { migrated: false, notice: null, warnings: [] });
    assert.equal(readFileSync(dirs.globalPath, "utf8"), globalBytes);
    assert.equal(readFileSync(`${dirs.legacyPath}.migrated`, "utf8"), archiveBytes);
    assert.deepEqual(artifactNames(dirs.dataDir), before);
  });

  it("migration refuses malformed JSON without changing either file", () => {
    const dirs = fixture();
    const bytes = "{ not json\n";
    writeFileSync(dirs.legacyPath, bytes);

    const result = migrateLegacyConfig();

    assert.equal(result.migrated, false);
    assert.equal(result.notice, null);
    assert.ok(result.warnings.some((warning) => warning.startsWith(`${dirs.legacyPath}:`) && warning.includes("not valid JSON")));
    assert.equal(readFileSync(dirs.legacyPath, "utf8"), bytes);
    assert.equal(existsSync(`${dirs.legacyPath}.migrated`), false);
    assert.equal(existsSync(dirs.globalPath), false);
  });

  it("migration refuses malformed or non-mapping YAML without archiving JSON", () => {
    for (const yaml of ["attach: [broken\n", "null\n"]) {
      const dirs = fixture();
      const legacy = '{"attach":"raw"}\n';
      writeFileSync(dirs.legacyPath, legacy);
      writeFileSync(dirs.globalPath, yaml);

      const result = migrateLegacyConfig();

      assert.equal(result.migrated, false);
      assert.equal(result.notice, null);
      assert.ok(result.warnings.some((warning) => warning.startsWith(`${dirs.globalPath}:`)));
      assert.equal(readFileSync(dirs.legacyPath, "utf8"), legacy);
      assert.equal(readFileSync(dirs.globalPath, "utf8"), yaml);
      assert.equal(existsSync(`${dirs.legacyPath}.migrated`), false);
    }
  });

  it("migration refuses an existing archive without overwriting it", () => {
    const dirs = fixture();
    const legacy = '{"attach":"raw"}\n';
    const archive = "keep this archive\n";
    writeFileSync(dirs.legacyPath, legacy);
    writeFileSync(`${dirs.legacyPath}.migrated`, archive);

    const result = migrateLegacyConfig();

    assert.equal(result.migrated, false);
    assert.ok(result.warnings.some((warning) => warning.startsWith(`${dirs.legacyPath}:`)));
    assert.equal(readFileSync(dirs.legacyPath, "utf8"), legacy);
    assert.equal(readFileSync(`${dirs.legacyPath}.migrated`, "utf8"), archive);
    assert.equal(existsSync(dirs.globalPath), false);
  });
});

describe("global attach setters", () => {
  it("setup attach edits keep comments ordering and unrelated YAML values", async () => {
    const dirs = fixture();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const original = "# keep setup comment\nfuture: keep\nattach: auto # mode comment\n";
    writeFileSync(dirs.globalPath, original, { mode: 0o640 });
    const mode = statSync(dirs.globalPath).mode & 0o777;

    const result = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--attach", "raw", "--force"], opts);
    const after = readFileSync(dirs.globalPath, "utf8");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /attach mode {2}raw/);
    assert.ok(after.indexOf("# keep setup comment") < after.indexOf("future: keep"));
    assert.ok(after.indexOf("future: keep") < after.indexOf("attach: raw"));
    assert.match(after, /# mode comment/);
    assert.deepEqual(parse(after), { future: "keep", attach: "raw" });
    assert.equal(statSync(dirs.globalPath).mode & 0o777, mode);
    assert.deepEqual(artifactNames(dirs.dataDir), ["hive.yml"]);
  });

  it("setup auto-attach edits keep comments ordering and attach", async () => {
    const dirs = fixture();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    writeFileSync(dirs.globalPath, "# keep auto comment\nattach: control\nfuture: keep\n");

    const result = await runCli(["setup", "--dir", join(dirs.tmp, "bin"), "--auto-attach", "off", "--force"], opts);
    const after = readFileSync(dirs.globalPath, "utf8");

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /auto-attach {2}off/);
    assert.ok(after.indexOf("# keep auto comment") < after.indexOf("attach: control"));
    assert.ok(after.indexOf("attach: control") < after.indexOf("future: keep"));
    assert.ok(after.indexOf("future: keep") < after.indexOf("autoAttach: off"));
    assert.deepEqual(parse(after), { attach: "control", future: "keep", autoAttach: "off" });
  });
});

describe("read-only global config consumers", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("an MCP read of unmigrated legacy settings writes no files", async () => {
    const dirs = fixture();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init", "--no-profile"], opts);
    assert.equal(init.code, 0, init.stderr);
    const legacy = '{"attach":"raw","autoAttach":"on","future":"keep"}\n';
    writeFileSync(dirs.legacyPath, legacy);
    const beforeFiles = artifactNames(dirs.dataDir);
    const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    let agentId;
    try {
      await mcp.start();
      const receipt = await mcp.call("agent_spawn", { name: "legacy-reader", command: "sleep", extra_args: ["600"] });
      agentId = receipt.agent_id;
      assert.ok(agentId > 0, `agent_spawn should reach its config reader: ${JSON.stringify(receipt)}`);
      await mcp.call("agent_close", { agent_id: agentId });
      agentId = undefined;
    } finally {
      if (agentId) {
        try {
          await mcp.call("agent_close", { agent_id: agentId });
        } catch {
        }
      }
      await mcp.close();
      cleanup(sessionName());
    }
    assert.deepEqual(artifactNames(dirs.dataDir), beforeFiles);
    assert.equal(readFileSync(dirs.legacyPath, "utf8"), legacy);
    assert.equal(existsSync(dirs.globalPath), false);
  });

  it("CLI doctor prints one migration notice on stderr only", async () => {
    const dirs = fixture();
    const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init", "--no-profile"], opts);
    assert.equal(init.code, 0, init.stderr);
    const yaml = "# pre-existing global comment\nfuture: keep\n";
    const legacy = '{"attach":"control","autoAttach":"off"}\n';
    writeFileSync(dirs.globalPath, yaml);
    writeFileSync(dirs.legacyPath, legacy);

    const result = await runCli(["doctor"], opts);
    const noticeCount = result.stderr.match(/hive: migrated .*config\.json into .*hive\.yml/g)?.length ?? 0;

    assert.equal(noticeCount, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /hive: migrated/);
    assert.equal(readFileSync(`${dirs.legacyPath}.migrated`, "utf8"), legacy);
    assert.match(readFileSync(dirs.globalPath, "utf8"), /# pre-existing global comment/);
    assert.deepEqual(parse(readFileSync(dirs.globalPath, "utf8")), {
      future: "keep",
      attach: "control",
      autoAttach: "off",
    });
  });

  it("CLI lead and setup migrate before resolving legacy settings", async () => {
    const setupDirs = fixture();
    const setupOpts = { cwd: setupDirs.projectDir, dataDir: setupDirs.dataDir, tmp: setupDirs.tmp };
    const setupLegacy = '{"attach":"raw","autoAttach":"off"}\n';
    writeFileSync(setupDirs.legacyPath, setupLegacy);
    const setup = await runCli(["setup", "--dir", join(setupDirs.tmp, "bin"), "--force"], setupOpts);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /attach mode {2}raw/);
    assert.match(setup.stdout, /auto-attach {2}off/);
    assert.equal(readFileSync(`${setupDirs.legacyPath}.migrated`, "utf8"), setupLegacy);
    assert.deepEqual(parse(readFileSync(setupDirs.globalPath, "utf8")), { attach: "raw", autoAttach: "off" });

    const dirs = fixture();
    mkdirSync(dirs.dataDir, { recursive: true });
    const session = sessionName();
    const fakeClaude = makeFakeClaude(dirs.tmp)("sleep 600");
    const opts = {
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      tmp: dirs.tmp,
      env: { PATH: `${dirname(fakeClaude)}:${process.env.PATH}` },
    };
    const leadLegacy = '{"attach":"control"}\n';
    writeFileSync(dirs.legacyPath, leadLegacy);
    try {
      const lead = await runCli(["lead", "--no-dashboard"], opts);
      assert.equal(lead.code, 0, lead.stderr);
      assert.match(lead.stdout, /Attach from a terminal with: tmux -CC/);
      assert.equal(readFileSync(`${dirs.legacyPath}.migrated`, "utf8"), leadLegacy);
      assert.deepEqual(parse(readFileSync(dirs.globalPath, "utf8")), { attach: "control" });
      assert.equal((lead.stderr.match(/hive: migrated .*config\.json into .*hive\.yml/g) ?? []).length, 1);
    } finally {
      cleanup(session);
    }
  });

  it("MCP hooks kickoff and scheduler have no migration call site", () => {
    const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
    const calls = [...cli.matchAll(/reportMigrationResult\(migrateLegacyConfig\(\)\)/g)];
    assert.equal(calls.length, 3, "only cmdLead, cmdSetup and cmdDoctor may migrate");
    assert.ok(cli.indexOf("async function cmdLead") < calls[0].index);
    assert.ok(cli.indexOf("function cmdSetup") < calls[1].index);
    assert.ok(cli.indexOf("function cmdDoctor") < calls[2].index);
    for (const file of ["src/index.ts", "src/hook.ts", "src/kickoff.ts", "src/scheduler.ts"]) {
      assert.doesNotMatch(readFileSync(join(REPO, file), "utf8"), /migrateLegacyConfig/);
    }
  });

  it("migration leaves project hive.yml bytes untouched", () => {
    const dirs = fixture();
    const projectYaml = "# project comment\nlead: claude\n";
    const projectPath = join(dirs.projectDir, "hive.yml");
    writeFileSync(projectPath, projectYaml);
    writeFileSync(dirs.legacyPath, '{"attach":"raw"}\n');

    const result = migrateLegacyConfig();

    assert.equal(result.migrated, true);
    assert.equal(readFileSync(projectPath, "utf8"), projectYaml);
  });
});
