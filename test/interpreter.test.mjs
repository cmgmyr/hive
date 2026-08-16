import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertScratchStore,
  CLI,
  classicAddonFixture,
  failureCount,
  isolateTmux,
  runCli,
  runNode,
  scratchDirs,
  SERVER,
  warningCount,
  writeScratchAddon,
} from "./helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the interpreter and doctor tests");
after(() => cleanupTmux());

const dirs = scratchDirs();
const configDir = join(dirs.tmp, "claude-config");
mkdirSync(configDir, { recursive: true });

process.env.HIVE_DATA_DIR = dirs.dataDir;

const REPO = new URL("..", import.meta.url).pathname;

const doctorOpts = {
  cwd: dirs.projectDir,
  dataDir: dirs.dataDir,
  tmp: dirs.tmp,
  env: { CLAUDE_CONFIG_DIR: configDir },
};

function writeUserConfig(config) {
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify(config, null, 1));
}

const OTHER_NODE = `${process.execPath}-some-other-build`;

describe("interpreter and ABI", () => {
  before(async () => {
    const init = await runCli(["init"], doctorOpts);
    assert.equal(init.code, 0, init.stderr);
    writeUserConfig({ mcpServers: {} });
  });

  it("doctor names the interpreter, and does not invent an ABI for the addon", async () => {
    const { stdout } = await runCli(["doctor"], doctorOpts);
    const node = /ok {4}node: (v[\d.]+) \(NODE_MODULE_VERSION (\d+)\) at (\/\S+)/.exec(stdout);
    assert.ok(node, `doctor should report the running interpreter:\n${stdout}`);

    assert.doesNotMatch(
      stdout,
      /ok {4}better-sqlite3: addon built for NODE_MODULE_VERSION/,
      "nothing in src/abi.ts reads the addon's build ABI, so success must not claim one",
    );

    const addon = /ok {4}better-sqlite3: addon loaded; built against Node-API (\d+), this interpreter provides Node-API (\d+)/.exec(
      stdout,
    );
    assert.ok(addon, `doctor should report what the load was decided on:\n${stdout}`);
    assert.equal(addon[2], process.versions.napi, "the provided level is this interpreter's");
    assert.ok(Number(addon[2]) >= Number(addon[1]), "a passing run cannot be below the level it names");

    assert.match(stdout, /(?:better_sqlite3|[a-z0-9]+-(?:x64|arm64))\.node/, "name the file, so two checkouts can be compared");
  });

  it("reads the isolated tmux server, not whatever the ambient env points at", {
    skip: hasTmux ? false : "tmux is not installed",
  }, async () => {

    const probe = `hive-doctor-probe-${process.pid}`;
    execFileSync("tmux", ["new-session", "-d", "-s", probe, "sleep 600"], { stdio: "ignore" });
    try {
      const { stdout } = await runCli(["doctor"], doctorOpts);
      const line = /^ *(?:ok|info|warn) +sessions: (.*)$/m.exec(stdout);
      assert.ok(line, `doctor should report sessions:\n${stdout}`);
      assert.deepEqual(line[1].split(", "), [probe], `doctor reached another tmux server:\n${stdout}`);
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${probe}`], { stdio: "ignore" });
    }
  });

  it("checks the ABI by loading the addon, which require() alone does not do", async () => {
    await assertScratchStore();
    const { checkAbi } = await import("../dist/abi.js");
    const status = checkAbi();
    assert.equal(status.ok, true, status.error ?? "");

    assert.equal(status.builtFor, null, "success must not report a build ABI nothing measured");
    assert.match(status.addon, /(?:better_sqlite3|[a-z0-9]+-(?:x64|arm64))\.node$/);

  });

  it("importing the package does not load the addon, which is what lets guardAbi run at all", () => {

    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { createRequire } = await import("node:module");' +
          'const req = createRequire(process.cwd() + "/probe.mjs");' +
          'const loaded = () => Object.keys(req.cache).filter((k) => k.endsWith(".node"));' +
          "const before = loaded();" +

          'const { default: Database } = await import("better-sqlite3");' +
          "const afterImport = loaded();" +
          'new Database(":memory:").exec("create table t(a)");' +
          "const afterOpen = loaded();" +
          "console.log(JSON.stringify({ kind: typeof Database, before, afterImport, afterOpen }));",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    const r = JSON.parse(out.trim());

    assert.equal(r.kind, "function", "the import has to have really happened");
    assert.deepEqual(r.before, [], "nothing native is loaded before the import");
    assert.deepEqual(
      r.afterImport,
      [],
      "better-sqlite3's entrypoint loaded a native addon - db.ts and backup.ts evaluate it above guardAbi(), " +
        "so the guard can no longer report anything and src/abi.ts's design needs revisiting",
    );

    assert.equal(r.afterOpen.length, 1, `opening a Database must load exactly one addon, got ${r.afterOpen}`);
    assert.match(r.afterOpen[0], /better-sqlite3.*\.node$/);
  });

  it("explains a mismatch in terms of both interpreters", async () => {
    const { classifyAddonLoadError, describeAbi, abiFixLines } = await import("../dist/abi.js");
    const mismatch = {
      addon: "/x/better_sqlite3.node",
      running: 147,
      builtFor: 137,
      failure: "mismatch",
      ok: false,
      error: null,
    };
    assert.match(describeAbi(mismatch), /built for NODE_MODULE_VERSION 137/);
    assert.match(describeAbi(mismatch), /needs 147/);
    assert.match(abiFixLines(mismatch).join("\n"), /npm install && npm run build/);

    const missing = {
      addon: null,
      running: 137,
      builtFor: null,
      failure: "missing",
      ok: false,
      error: "not built",
    };
    assert.match(describeAbi(missing), /not built/);

    const missingFix = abiFixLines(missing).join("\n");
    assert.doesNotMatch(missingFix, /npm install && npm run build/, "neither half of that produces the addon");
    assert.match(
      missingFix,
      /^Reinstall the package: {2}rm -rf node_modules\/better-sqlite3 && npm install$/m,
      "removing the package is what makes npm fetch the tarball again",
    );
    assert.match(missingFix, /A plain `npm install` will NOT bring it back/, "and say why the obvious command is not it");
    assert.match(missingFix, /npm run build` only compiles TypeScript/, "say why hive's build is not part of it");
    assert.match(missingFix, /npm run build-release/, "and where the source build lives when there is no prebuild");

    assert.equal(classifyAddonLoadError("Module did not self-register: '/x/better_sqlite3.node'"), "mismatch");
    const linuxMismatch = {
      addon: "/x/better_sqlite3.node",
      running: 137,
      builtFor: null,
      failure: "mismatch",
      ok: false,
      error: "Module did not self-register",
    };
    assert.match(describeAbi(linuxMismatch), /built-for version is not reported/);
    assert.match(abiFixLines(linuxMismatch).join("\n"), /Run hive under the Node it was built for/);
  });

  it("does not tell a broken interpreter to run `hive setup`", async () => {
    const { abiFixLines } = await import("../dist/abi.js");
    const mismatch = {
      addon: "/x/better_sqlite3.node",
      running: 147,
      builtFor: 137,
      failure: "mismatch",
      ok: false,
      error: null,
    };

    const bare = abiFixLines(mismatch).join("\n");
    assert.doesNotMatch(bare, /^ *hive setup$/m);
    assert.match(bare, /<the Node that built it> ".*dist\/cli\.js" setup/);

    assert.match(abiFixLines(mismatch, "/pinned/node").join("\n"), /"\/pinned\/node" ".*cli\.js" setup/);
  });

  it("refuses when the interpreter reports no Node-API level, instead of comparing NaN", () => {

    const abi = new URL("../dist/abi.js", import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "delete process.versions.napi;" +
          `const { checkAbi, describeAbi } = await import(${JSON.stringify(abi)});` +
          "const s = checkAbi();" +
          "console.log(JSON.stringify({ failure: s.failure, ok: s.ok, nodeApi: s.nodeApi, text: describeAbi(s) }));",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    const status = JSON.parse(out.trim());
    assert.equal(status.ok, false, "an interpreter with no Node-API level must not reach the require");
    assert.equal(status.failure, "napi");
    assert.equal(status.nodeApi, null);
    assert.match(status.text, /none reported/);
    assert.doesNotMatch(status.text, /NaN/, "NaN in a diagnostic is the missing check leaking into the message");
  });

  it("finds a debug build, which better-sqlite3's own loader tries before Release", async () => {
    const { checkAbi } = await import("../dist/abi.js");
    const real = checkAbi().addon;
    assert.ok(real, "this test needs the real, working addon");
    const root = join(dirs.tmp, "debug-build");
    mkdirSync(root, { recursive: true });

    const { cli } = writeScratchAddon(root, { prebuild: real, layout: "debug" });
    const { stdout } = await runNode(cli, ["doctor"], { ...doctorOpts, node: process.execPath });
    assert.match(stdout, /ok {4}better-sqlite3: addon loaded/, `a debug build is a loadable tree:\n${stdout}`);
    assert.match(stdout, /build\/Debug\/better_sqlite3\.node/, `and doctor should name the file it found:\n${stdout}`);
  });

  it("does not walk the heap to answer a question only linux asks", () => {

    const abi = new URL("../dist/abi.js", import.meta.url).href;
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "let calls = 0;" +
          "const real = process.report.getReport.bind(process.report);" +
          "process.report.getReport = () => { calls++; return real(); };" +
          `const { checkAbi } = await import(${JSON.stringify(abi)});` +
          "checkAbi();" +
          "console.log(JSON.stringify({ calls, platform: process.platform }));",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    const { calls } = JSON.parse(out.trim());
    assert.equal(calls, process.platform === "linux" ? 1 : 0, "getReport() belongs behind the linux test");
  });

  it("reads the addon's Node-API level from better-sqlite3's own binding.gyp", async () => {
    const { requiredNodeApi, nodeRangeForNodeApi } = await import("../dist/abi.js");

    assert.equal(requiredNodeApi(), 10, "if better-sqlite3 raised NAPI_VERSION, raise engines.node with it");
    assert.equal(nodeRangeForNodeApi(10), "^22.14.0 || >=23.6.0");

    assert.ok(Number(process.versions.napi) >= 10, "this suite is running below hive's own declared floor");
  });

  it("refuses with a diagnostic when this Node is below the addon's Node-API level", async () => {
    const { checkAbi } = await import("../dist/abi.js");
    const real = checkAbi().addon;
    assert.ok(real, "this test needs the real, working addon as its control");
    const root = join(dirs.tmp, "napi-floor");
    mkdirSync(root, { recursive: true });

    const { cli } = writeScratchAddon(root, { prebuild: real, napiVersion: 99 });

    const status = await runNode(cli, ["status"], { ...doctorOpts, node: process.execPath });
    assert.equal(status.code, 1, status.stdout);
    assert.match(status.stderr, /hive: this Node is too old/);
    assert.match(status.stderr, /built against Node-API 99/);
    assert.match(status.stderr, new RegExp(`provides Node-API ${process.versions.napi}`));

    assert.doesNotMatch(status.stderr, /npm install && npm run build/);
    assert.match(status.stderr, /Rebuilding does NOT help/);

    assert.equal(status.stdout, "");

    const doctor = await runNode(cli, ["doctor"], { ...doctorOpts, node: process.execPath });
    assert.equal(doctor.code, 1, doctor.stdout);
    assert.match(doctor.stdout, /^hive doctor/);
    assert.match(doctor.stdout, /FAIL {2}better-sqlite3: addon is built against Node-API 99/);
    assert.match(doctor.stdout, /1 problem\(s\) found/);
  });

  it("fails doctor when the addon is present but built for a different Node ABI", {
    skip: classicAddonFixture({ matches: false }) ? false : `no pre-N-API better-sqlite3 fixture for ${process.platform}-${process.arch} ABI ${process.versions.modules} - add one (see test/fixtures/native-addon-abi/README.md) or this coverage is silently gone`,
  }, async () => {
    const root = join(dirs.tmp, "wrong-abi-doctor");
    mkdirSync(root, { recursive: true });
    const { cli } = writeScratchAddon(root, { prebuild: classicAddonFixture({ matches: false }) });
    const { code, stdout } = await runNode(cli, ["doctor"], { ...doctorOpts, node: process.execPath });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^hive doctor/);
    assert.match(stdout, new RegExp(`FAIL {2}node: .*NODE_MODULE_VERSION ${process.versions.modules}`));
    assert.match(
      stdout,
      /FAIL {2}better-sqlite3: addon built for NODE_MODULE_VERSION \d+, this interpreter needs/,
    );
    assert.match(stdout, /1 problem\(s\) found/);
  });

  it("names the interpreter on any other command too, without a stack trace", {
    skip: classicAddonFixture({ matches: false }) ? false : `no pre-N-API better-sqlite3 fixture for ${process.platform}-${process.arch} ABI ${process.versions.modules} - add one (see test/fixtures/native-addon-abi/README.md) or this coverage is silently gone`,
  }, async () => {
    const root = join(dirs.tmp, "wrong-abi-status");
    mkdirSync(root, { recursive: true });
    const { cli } = writeScratchAddon(root, { prebuild: classicAddonFixture({ matches: false }) });
    const { code, stdout, stderr } = await runNode(cli, ["status"], { ...doctorOpts, node: process.execPath });
    assert.equal(code, 1);
    assert.match(stderr, /hive: cannot run under this Node/);

    assert.doesNotMatch(stderr, /ERR_DLOPEN_FAILED/, "the raw dlopen error is what this replaces");

    assert.equal(stdout, "");
  });

  it("fails doctor and names the remedy when the addon has not been built at all", async () => {
    const root = join(dirs.tmp, "missing-addon");
    mkdirSync(root, { recursive: true });
    const { cli } = writeScratchAddon(root);
    const { code, stdout } = await runNode(cli, ["doctor"], { ...doctorOpts, node: process.execPath });
    assert.equal(code, 1, stdout);
    assert.match(
      stdout,
      /FAIL {2}better-sqlite3: better-sqlite3's native addon is missing; it has not been built here/,
    );

    assert.match(stdout, /Reinstall the package: {2}rm -rf node_modules\/better-sqlite3 && npm install$/m);
    assert.doesNotMatch(stdout, /npm install && npm run build/);
    assert.doesNotMatch(stdout, /^Install it: {2}npm install$/m, "the bare install does not restore a missing addon");
    assert.match(stdout, /1 problem\(s\) found/);
  });
});

describe("hive setup writes a dispatcher", () => {
  const binDir = join(dirs.tmp, "bin");
  const dispatcher = join(binDir, "hive");

  const hivelessPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const setupOpts = {
    ...doctorOpts,
    env: { ...doctorOpts.env, HIVE_BIN_DIR: binDir, PATH: `${binDir}:${hivelessPath}` },
  };

  it("pins the interpreter that built this checkout", async () => {
    const { code, stdout } = await runCli(["setup"], setupOpts);
    assert.equal(code, 0, stdout);
    const script = readFileSync(dispatcher, "utf8");
    assert.match(script, /^#!\/bin\/sh$/m);
    assert.ok(
      script.includes(`exec '${process.execPath}' '${CLI}' "$@"`),
      `dispatcher should exec this interpreter, got:\n${script}`,
    );

    assert.ok(stdout.includes(`interpreter  ${process.execPath}`), stdout);
    assert.match(stdout, new RegExp(`NODE_MODULE_VERSION ${process.versions.modules}`));
  });

  it("runs hive with no node on PATH at all", () => {

    const stdout = execFileSync(dispatcher, ["status"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: dirs.tmp, HIVE_DATA_DIR: dirs.dataDir, HIVE_AUTO_ATTACH: "0" },
    });
    assert.match(stdout, /agent|todo|Nothing running/);
  });

  it("survives a directory with a space in it", async () => {
    const spaced = join(dirs.tmp, "bin dir");
    const { code, stdout } = await runCli(["setup", "--dir", spaced], setupOpts);
    assert.equal(code, 0, stdout);
    const out = execFileSync(join(spaced, "hive"), ["status"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: dirs.tmp, HIVE_DATA_DIR: dirs.dataDir, HIVE_AUTO_ATTACH: "0" },
    });
    assert.match(out, /agent|todo|Nothing running/);
  });

  it("names the version manager that can take the pinned interpreter away", async () => {
    const { durabilityLines } = await import("../dist/dispatcher.js");
    const owned = [
      ["/Users/x/.asdf/installs/nodejs/24.7.0/bin/node", "asdf"],
      ["/Users/x/.nvm/versions/node/v22.0.0/bin/node", "nvm"],
      ["/Users/x/.volta/tools/image/node/20.0.0/bin/node", "volta"],
      ["/Users/x/.fnm/node-versions/v22.0.0/installation/bin/node", "fnm"],
      ["/Users/x/.local/state/fnm_multishells/1234/bin/node", "fnm"],
      ["/Users/x/.local/share/mise/installs/node/22.0.0/bin/node", "mise"],
      ["/Users/x/Library/Application Support/Herd/config/nvm/versions/node/v24.18.0/bin/node", "Herd"],
      ["/usr/local/n/versions/node/20.0.0/bin/node", "n"],
    ];
    for (const [path, manager] of owned) {
      const text = durabilityLines(path).join("\n");
      assert.ok(
        text.startsWith(`! This Node lives inside ${manager}'s install directory.`),
        `${path} should be named as ${manager}'s, got:\n${text}`,
      );
      assert.match(text, /The pin is stable until\n {2}that version is removed/);
      assert.match(text, new RegExp(`uninstalling it through ${manager} later breaks the`));

      assert.match(text, /\/opt\/homebrew\/bin\/node "[^"]*dist\/cli\.js" setup/);
      assert.doesNotMatch(text, /(^|[^/\w])hive setup/, `the fix must not route through the pinned hive:\n${text}`);
    }
  });

  it("hedges instead of promising safety for an interpreter it does not recognize", async () => {
    const { durabilityLines } = await import("../dist/dispatcher.js");
    const unowned = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",

      "/Users/runner/hostedtoolcache/node/22.23.1/arm64/bin/node",

      "/Users/x/.nodenv/versions/22.0.0/bin/node",
    ];
    for (const path of unowned) {
      const text = durabilityLines(path).join("\n");
      assert.equal(
        text,
        "This Node is not in any install directory hive recognizes as a version\n" +
          "manager's, so it is probably yours to keep. Check before relying on that.",
        `${path} should get the hedge, got:\n${text}`,
      );

      assert.doesNotMatch(text, /cannot be removed|is yours to keep\b|safe/);
    }
  });

  it("prints the branch belonging to the interpreter it actually pinned", async () => {
    const { durabilityLines } = await import("../dist/dispatcher.js");
    const { stdout } = await runCli(["setup"], setupOpts);

    for (const line of durabilityLines(process.execPath)) {
      assert.ok(stdout.includes(line), `setup should print:\n${line}\ngot:\n${stdout}`);
    }

    assert.match(stdout, /npm install && npm run build && hive setup/);
  });

  it("re-pins a stale dispatcher and says what it replaced", async () => {
    writeFileSync(
      dispatcher,
      `#!/bin/sh\n# hive dispatcher\nexec '/gone/node' '/gone/cli.js' "$@"\n`,
      { mode: 0o755 },
    );
    const { code, stdout } = await runCli(["setup"], setupOpts);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^Re-pinned /m);
    assert.match(stdout, /was {10}\/gone\/node \/gone\/cli\.js/);
  });

  it("refuses to overwrite a dispatcher it did not write", async () => {
    const otherDir = join(dirs.tmp, "other-bin");
    mkdirSync(otherDir, { recursive: true });
    const foreign = join(otherDir, "hive");
    writeFileSync(foreign, "#!/bin/sh\necho not mine\n");
    chmodSync(foreign, 0o755);

    const refused = await runCli(["setup", "--dir", otherDir], setupOpts);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /was not written by hive setup; refusing to overwrite/);
    assert.match(readFileSync(foreign, "utf8"), /not mine/);

    const forced = await runCli(["setup", "--dir", otherDir, "--force"], setupOpts);
    assert.equal(forced.code, 0, forced.stdout);
    assert.match(readFileSync(foreign, "utf8"), /# hive dispatcher/);
  });

  it("doctor warns when the dispatcher is shadowed, and stays quiet when it wins", async () => {
    await runCli(["setup"], setupOpts);
    const shadowDir = join(dirs.tmp, "shadow");
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, "hive"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(join(shadowDir, "hive"), 0o755);

    const shadowed = await runCli(["doctor"], {
      ...setupOpts,
      env: { ...setupOpts.env, PATH: `${shadowDir}:${binDir}:${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    assert.match(shadowed.stdout, /warn {2}dispatcher: .*shadow\/hive comes first on PATH/);

    const winning = await runCli(["doctor"], {
      ...setupOpts,
      env: { ...setupOpts.env, PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    assert.match(winning.stdout, /info {2}dispatcher: /);
    assert.doesNotMatch(winning.stdout, /warn {2}dispatcher/);
  });

  it("doctor warns when the dispatcher points at a build this is not", async () => {
    writeFileSync(
      dispatcher,
      `#!/bin/sh\n# hive dispatcher\nexec '${process.execPath}' '/some/other/checkout/dist/cli.js' "$@"\n`,
      { mode: 0o755 },
    );
    const { stdout } = await runCli(["doctor"], setupOpts);
    assert.match(stdout, /warn {2}dispatcher: pinned to a different build/);
    assert.match(stdout, /npm run build && hive setup/);
  });

  it("doctor points at setup when there is no dispatcher", async () => {

    const { stdout } = await runCli(["doctor"], {
      ...setupOpts,
      env: { ...setupOpts.env, HIVE_BIN_DIR: join(dirs.tmp, "absent"), PATH: hivelessPath },
    });
    assert.match(stdout, /info {2}dispatcher: none at .*absent\/hive; `hive setup` writes one/);
  });
});

describe("doctor reads the MCP registration", () => {
  before(async () => {
    const init = await runCli(["init"], doctorOpts);
    assert.equal(init.code, 0, init.stderr);
  });

  it("warns when the registration runs a bare command", async () => {
    writeUserConfig({ mcpServers: { hive: { type: "stdio", command: "node", args: [SERVER] } } });
    const bare = await runCli(["doctor"], doctorOpts);
    assert.match(bare.stdout, /warn {2}mcp registration \(user scope\): runs "node"/);
    assert.match(bare.stdout, /claude mcp add --scope user hive --/);

    writeUserConfig({
      mcpServers: { hive: { type: "stdio", command: process.execPath, args: [SERVER] } },
    });
    const clean = await runCli(["doctor"], doctorOpts);
    assert.doesNotMatch(clean.stdout, /warn {2}mcp registration/);
    const context = `bare:\n${bare.stdout}\nclean:\n${clean.stdout}`;
    assert.equal(bare.code, clean.code, `a registration warning must not change the exit code\n${context}`);

    assert.equal(
      failureCount(bare.stdout),
      failureCount(clean.stdout),
      `a registration warning must not be counted as a problem\n${context}`,
    );

    assert.equal(
      warningCount(bare.stdout) - warningCount(clean.stdout),
      1,
      `the bare registration should have produced exactly one extra warning\n${context}`,
    );
  });

  it("accepts an absolute interpreter without a warning", async () => {
    writeUserConfig({
      mcpServers: { hive: { type: "stdio", command: process.execPath, args: [SERVER] } },
    });
    const { stdout } = await runCli(["doctor"], doctorOpts);
    assert.match(stdout, /info {2}mcp registration \(user scope\)/);
    assert.doesNotMatch(stdout, /warn {2}mcp registration/);
  });

  it("warns when the registration pins a different interpreter than this CLI", async () => {
    writeUserConfig({
      mcpServers: { hive: { type: "stdio", command: OTHER_NODE, args: [SERVER] } },
    });
    const { stdout } = await runCli(["doctor"], doctorOpts);
    assert.match(stdout, /warn {2}mcp registration \(user scope\): pins a different interpreter/);
  });

  it("finds a project-scope registration and a renamed one", async () => {
    writeUserConfig({ mcpServers: {} });
    writeFileSync(
      join(dirs.projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "hive-dev": { command: "node", args: [SERVER] } } }),
    );
    const { stdout } = await runCli(["doctor"], doctorOpts);
    assert.match(stdout, /warn {2}mcp registration \(project scope\): runs "node"/);

    assert.match(stdout, /claude mcp add --scope project hive-dev --/);
  });

  it("hands over a re-register line that survives a path with a space", async () => {
    writeUserConfig({ mcpServers: { hive: { command: "node", args: [SERVER] } } });
    const { stdout } = await runCli(["doctor"], doctorOpts);

    assert.ok(
      stdout.includes(`hive -- "${process.execPath}" "${SERVER}"`),
      `re-register line should be pasteable:\n${stdout}`,
    );
  });

  it("says nothing is registered rather than nothing at all", async () => {
    writeUserConfig({ mcpServers: { other: { command: "node", args: ["/somewhere/else.js"] } } });
    const { stdout } = await runCli(["doctor"], { ...doctorOpts, cwd: dirs.tmp });
    assert.match(stdout, /info {2}mcp registration: none found for hive/);
  });
});

describe("hive setup names the registration it cannot fix", () => {
  const binDir = join(dirs.tmp, "setup-mcp-bin");
  const setupOpts = { ...doctorOpts, env: { ...doctorOpts.env, HIVE_BIN_DIR: binDir } };

  before(() => {

    writeFileSync(join(dirs.projectDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  });

  it("prints the re-register line when the registration is bare", async () => {
    writeUserConfig({ mcpServers: { hive: { type: "stdio", command: "node", args: [SERVER] } } });
    const { code, stdout } = await runCli(["setup"], setupOpts);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /hive setup pins the `hive` command, not the MCP server/);

    assert.match(stdout, /mcp registration \(user scope\): runs "node", which a Node version manager/);
    assert.ok(
      stdout.includes(`hive -- "${process.execPath}" "${SERVER}"`),
      `setup should offer the interpreter it just pinned:\n${stdout}`,
    );
  });

  it("stays silent when the registration already runs the pinned interpreter", async () => {
    writeUserConfig({
      mcpServers: { hive: { type: "stdio", command: process.execPath, args: [SERVER] } },
    });
    const { code, stdout } = await runCli(["setup"], setupOpts);
    assert.equal(code, 0, stdout);

    assert.doesNotMatch(stdout, /mcp registration/);
    assert.doesNotMatch(stdout, /claude mcp add/);
  });

  it("prints when the registration pins some other interpreter", async () => {
    writeUserConfig({
      mcpServers: { hive: { type: "stdio", command: OTHER_NODE, args: [SERVER] } },
    });
    const { stdout } = await runCli(["setup"], setupOpts);
    assert.match(stdout, /mcp registration \(user scope\): pins a different interpreter/);
    assert.match(stdout, /claude mcp add --scope user hive --/);
  });

  it("stays silent when it finds no registration at all", async () => {

    writeUserConfig({ numStartups: 3 });
    const { stdout } = await runCli(["setup"], setupOpts);
    assert.doesNotMatch(stdout, /mcp registration/);
    assert.doesNotMatch(stdout, /claude mcp add/);
  });
});

describe("hive setup offers the registration a fresh install has not made", () => {
  const ownConfig = join(dirs.tmp, "fresh-config");
  const configFile = join(ownConfig, ".claude.json");

  const opts = {
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    tmp: dirs.tmp,
    env: { CLAUDE_CONFIG_DIR: ownConfig, HIVE_BIN_DIR: join(dirs.tmp, "fresh-bin") },
  };
  const write = (config) => writeFileSync(configFile, JSON.stringify(config, null, 1));
  const OFFER = /hive's MCP tools are not registered in .*\.claude\.json/;
  const ADD_LINE = `claude mcp add --scope user hive -- "${process.execPath}" "${SERVER}"`;

  before(() => mkdirSync(ownConfig, { recursive: true }));

  it("offers the add line when the config has the block and hive is not in it", async () => {
    write({ mcpServers: { other: { command: "node", args: ["/somewhere/else.js"] } } });
    const { code, stdout } = await runCli(["setup"], opts);
    assert.equal(code, 0, stdout);
    assert.match(stdout, OFFER);

    write({ mcpServers: {} });
    const empty = await runCli(["setup"], opts);
    assert.match(empty.stdout, OFFER);
    assert.ok(stdout.includes(ADD_LINE), `offer should be pasteable:\n${stdout}`);

    assert.doesNotMatch(stdout, /^! hive setup pins the `hive` command/m);
  });

  it("says it in doctor with the same words, from the same helper", async () => {
    write({ mcpServers: { other: { command: "node", args: ["/somewhere/else.js"] } } });
    const { stdout } = await runCli(["doctor"], { ...opts, cwd: dirs.tmp });
    assert.match(stdout, /info {2}mcp registration: none found for hive/);
    assert.match(stdout, OFFER);
    assert.ok(stdout.includes(ADD_LINE), stdout);
  });

  it("stays silent when the config file is not there", async () => {
    rmSync(configFile, { force: true });
    const { stdout } = await runCli(["setup"], opts);
    assert.doesNotMatch(stdout, OFFER);
    assert.doesNotMatch(stdout, /claude mcp add/);
  });

  it("stays silent when the config has no mcpServers block", async () => {
    write({ numStartups: 3 });
    const { stdout } = await runCli(["setup"], opts);
    assert.doesNotMatch(stdout, OFFER);
    assert.doesNotMatch(stdout, /claude mcp add/);
  });

  it("stays silent when the config does not parse", async () => {
    writeFileSync(configFile, "{ not json");
    const { stdout } = await runCli(["setup"], opts);
    assert.doesNotMatch(stdout, OFFER);
    assert.doesNotMatch(stdout, /claude mcp add/);
  });

  it("stays silent when hive is registered in another scope entirely", async () => {

    write({ mcpServers: { other: { command: "node", args: ["/somewhere/else.js"] } } });
    const projectMcp = join(dirs.projectDir, ".mcp.json");
    writeFileSync(
      projectMcp,
      JSON.stringify({ mcpServers: { hive: { command: process.execPath, args: [SERVER] } } }),
    );
    try {
      const { stdout } = await runCli(["setup"], opts);
      assert.doesNotMatch(stdout, OFFER);
      assert.doesNotMatch(stdout, /claude mcp add/);
    } finally {
      writeFileSync(projectMcp, JSON.stringify({ mcpServers: {} }));
    }
  });

  it("leaves round 2 alone when hive is registered", async () => {

    write({ mcpServers: { hive: { command: "node", args: [SERVER] } } });
    const bare = await runCli(["setup"], opts);
    assert.match(bare.stdout, /^! hive setup pins the `hive` command/m);
    assert.match(bare.stdout, /mcp registration \(user scope\): runs "node"/);
    assert.doesNotMatch(bare.stdout, OFFER);

    write({ mcpServers: { hive: { command: process.execPath, args: [SERVER] } } });
    const matching = await runCli(["setup"], opts);
    assert.doesNotMatch(matching.stdout, OFFER);
    assert.doesNotMatch(matching.stdout, /mcp registration/);
    assert.doesNotMatch(matching.stdout, /claude mcp add/);
  });
});
