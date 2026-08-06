import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  assertScratchStore,
  CLI,
  classicAddonFixture,
  isolateTmux,
  runCli,
  runNode,
  scratchDirs,
  SERVER,
  writeScratchAddon,
} from "./helpers.mjs";

// doctor and status both run the janitor, which probes the tmux server; isolate
// first, or these read the one the lead and its workers are running in.
const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the interpreter and doctor tests");
after(() => cleanupTmux());

// hive lets the working directory pick its interpreter unless something stops
// it, and better-sqlite3's addon only loads under the Node that compiled it.
// These cover the diagnostic half: doctor naming the ABI, and the guard that
// turns an ERR_DLOPEN_FAILED out of an import into a sentence.
const dirs = scratchDirs();
const configDir = join(dirs.tmp, "claude-config");
mkdirSync(configDir, { recursive: true });
// Point the in-process dist imports at the scratch store before any of them
// resolve dataDir. See assertScratchStore.
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

// An absolute interpreter that is definitely not the one running the suite.
// A literal like /usr/local/bin/node is not: that is where nodejs.org's
// installer puts Node, so on such a machine the fixture would silently BE
// process.execPath and every "pins a different interpreter" assertion would
// invert. Derived from execPath, so it cannot collide with it.
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
    // THIS ASSERTION USED TO BE THE OPPOSITE, and it could not fail. It read
    // "addon built for NODE_MODULE_VERSION (\d+), matches" and checked that
    // number against the interpreter's - but checkAbi() set it BY COPYING the
    // interpreter's, so the two agreed by construction whatever the addon
    // was. Same shape as
    // dead-ends/2026-07-29-seeding-a-test-row-with-the-value-it-asserts.md.
    // The statement was also false: an N-API addon is built for no
    // NODE_MODULE_VERSION at all.
    assert.doesNotMatch(
      stdout,
      /ok {4}better-sqlite3: addon built for NODE_MODULE_VERSION/,
      "nothing in src/abi.ts reads the addon's build ABI, so success must not claim one",
    );
    // What a passing run may say is what was actually compared: the level the
    // installed package declares, against the level this Node provides. Both
    // are real reads from independent places.
    const addon = /ok {4}better-sqlite3: addon loaded; built against Node-API (\d+), this interpreter provides Node-API (\d+)/.exec(
      stdout,
    );
    assert.ok(addon, `doctor should report what the load was decided on:\n${stdout}`);
    assert.equal(addon[2], process.versions.napi, "the provided level is this interpreter's");
    assert.ok(Number(addon[2]) >= Number(addon[1]), "a passing run cannot be below the level it names");
    // better-sqlite3 13's N-API prebuilds are named by platform+arch
    // (darwin-arm64.node), not the pre-13 build/Release/better_sqlite3.node;
    // addonPath() (src/abi.ts) falls back to the old name for a platform/arch
    // with no prebuild, so both are real, current shapes.
    assert.match(stdout, /(?:better_sqlite3|[a-z0-9]+-(?:x64|arm64))\.node/, "name the file, so two checkouts can be compared");
  });

  it("reads the isolated tmux server, not whatever the ambient env points at", {
    skip: hasTmux ? false : "tmux is not installed",
  }, async () => {
    // Issue #21. Doctor is not a passive reader of the environment: its stale
    // state check runs the janitor, which probes the server, and its sessions
    // check runs `tmux ls`. Both went to whatever server the ambient env named,
    // which during development is the one the lead and its workers run in.
    //
    // One session on the isolated server, and doctor must report that one and
    // nothing else. Listing it at all proves doctor read the isolated server,
    // since it exists nowhere else. Listing ONLY it is the half that catches a
    // regression, and it is worth being honest that its power depends on the
    // developer having live hive sessions, which is exactly when this matters
    // and never on a CI runner. suite-isolation.test.mjs is what carries CI.
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
    // Null, not the running NODE_MODULE_VERSION. checkAbi() never reads the
    // addon's build ABI, so a number here would be this process's own value
    // laundered into a claim about the file.
    assert.equal(status.builtFor, null, "success must not report a build ABI nothing measured");
    assert.match(status.addon, /(?:better_sqlite3|[a-z0-9]+-(?:x64|arm64))\.node$/);

    // The lazy-binding half of this - that requiring the package does not
    // pull in the addon - is now its own test below, with a positive control.
    // It used to be an inline probe here, and that probe had gone dead: it
    // looked for a require.cache key ending "better_sqlite3.node", which is
    // the PRE-13 filename. v13's prebuild is darwin-arm64.node, so the probe
    // reported "not-loaded" whether or not the addon had loaded.
  });

  // ISSUE #105 LANE B1, ROUND 2, ITEM 4. This is the claim the whole guard
  // design rests on: db.ts's `import Database from "better-sqlite3"` runs
  // BEFORE guardAbi(), and backup.ts does the same, so if the package's
  // entrypoint ever loaded the addon itself the check would arrive after the
  // process was already dead. Nothing in the suite tested it - it is an
  // empirical fact about better-sqlite3's internals, hive declares ^13.0.3,
  // and a consumer can resolve any later 13.x.
  it("importing the package does not load the addon, which is what lets guardAbi run at all", () => {
    // One child does both halves so the two readings come from one process
    // and one resolution of the package.
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { createRequire } = await import("node:module");' +
          'const req = createRequire(process.cwd() + "/probe.mjs");' +
          'const loaded = () => Object.keys(req.cache).filter((k) => k.endsWith(".node"));' +
          "const before = loaded();" +
          // The exact form db.ts uses, not a bare require.
          'const { default: Database } = await import("better-sqlite3");' +
          "const afterImport = loaded();" +
          'new Database(":memory:").exec("create table t(a)");' +
          "const afterOpen = loaded();" +
          "console.log(JSON.stringify({ kind: typeof Database, before, afterImport, afterOpen }));",
      ],
      { cwd: REPO, encoding: "utf8" },
    );
    const r = JSON.parse(out.trim());
    // Without this the test passes when the import silently fails, which is
    // the shape that makes "nothing was loaded" meaningless.
    assert.equal(r.kind, "function", "the import has to have really happened");
    assert.deepEqual(r.before, [], "nothing native is loaded before the import");
    assert.deepEqual(
      r.afterImport,
      [],
      "better-sqlite3's entrypoint loaded a native addon - db.ts and backup.ts evaluate it above guardAbi(), " +
        "so the guard can no longer report anything and src/abi.ts's design needs revisiting",
    );
    // THE POSITIVE CONTROL, and the reason the assertion above means
    // something: the same instrument, in the same process, DOES see the addon
    // once a Database is constructed. Any probe that cannot show this is
    // reporting "not loaded" about its own blindness - which is exactly what
    // the inline probe this replaces had started doing, by matching a
    // filename that no longer exists.
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
    // This assertion used to require "npm install && npm run build", which
    // pinned a remedy that cannot work: v13 declares no install script so npm
    // invokes no build for it, and hive's `npm run build` is tsc. Neither
    // produces better_sqlite3.node. A test demanding an ineffective command
    // is what keeps it in the product.
    const missingFix = abiFixLines(missing).join("\n");
    assert.doesNotMatch(missingFix, /npm install && npm run build/, "neither half of that produces the addon");
    assert.match(missingFix, /^Install it: {2}npm install$/m, "the tarball carries the addon, so the install is the fix");
    assert.match(missingFix, /npm run build` only compiles TypeScript/, "say why the build is not part of it");
    assert.match(missingFix, /npm run build-release/, "and where the only real source build lives");

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
    // `hive setup` pins whatever Node runs it, and the `hive` on PATH is the
    // command that just failed. Advice that loops back to it is no advice.
    const bare = abiFixLines(mismatch).join("\n");
    assert.doesNotMatch(bare, /^ *hive setup$/m);
    assert.match(bare, /<the Node that built it> ".*dist\/cli\.js" setup/);
    // With a dispatcher on disk, hive knows an interpreter that works.
    assert.match(abiFixLines(mismatch, "/pinned/node").join("\n"), /"\/pinned\/node" ".*cli\.js" setup/);
  });

  it("refuses when the interpreter reports no Node-API level, instead of comparing NaN", () => {
    // `Number(undefined)` is NaN and `NaN < 10` is FALSE, so the level check
    // read as "high enough" on any runtime omitting process.versions.napi and
    // fell through to the require - a fail-open in the one comparison this
    // file exists to hold shut. Anything that cannot report a level cannot
    // load an N-API addon either, so "absent" has to mean "below".
    //
    // A child process, because the level has to be gone before checkAbi runs
    // and this one has already answered.
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

  // Issue #105 lane B1, item 4. addonPath() mirrors
  // better-sqlite3/lib/binding.js by hand, and had drifted from it twice.
  // Both drifts are silent in the direction that matters: one refuses a tree
  // that works, the other just costs.
  it("finds a debug build, which better-sqlite3's own loader tries before Release", async () => {
    const { checkAbi } = await import("../dist/abi.js");
    const real = checkAbi().addon;
    assert.ok(real, "this test needs the real, working addon");
    const root = join(dirs.tmp, "debug-build");
    mkdirSync(root, { recursive: true });
    // No prebuilds/ entry at all, addon at build/Debug only. binding.js loads
    // this tree; addonPath() used to skip straight from prebuilds/ to
    // build/Release and report "missing", so guardAbi exited 1 on a checkout
    // better-sqlite3 itself would have opened.
    const { cli } = writeScratchAddon(root, { prebuild: real, layout: "debug" });
    const { stdout } = await runNode(cli, ["doctor"], { ...doctorOpts, node: process.execPath });
    assert.match(stdout, /ok {4}better-sqlite3: addon loaded/, `a debug build is a loadable tree:\n${stdout}`);
    assert.match(stdout, /build\/Debug\/better_sqlite3\.node/, `and doctor should name the file it found:\n${stdout}`);
  });

  it("does not walk the heap to answer a question only linux asks", () => {
    // process.report.getReport() builds a full diagnostic report - heap walk,
    // libuv handle dump - and addonPath() called it unconditionally, on the
    // module-load path of every hive process and every SessionStart kickoff,
    // to read a glibc field that exists only on linux. binding.js tests the
    // platform first; so does this now.
    //
    // Counted in a child process, since checkAbi has already run in this one.
    // This can only fail off linux, which is the macOS leg's job - on linux
    // the call is correct and expected. Said out loud rather than left as a
    // test that quietly proves nothing on two of the three CI legs.
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

  // Issue #105 lane B1. The Node-API floor, which is what N-API replaced the
  // NODE_MODULE_VERSION equality with. These two tests are a pair: the first
  // pins the number hive derives its engines floor from, the second proves
  // hive refuses rather than dies when an interpreter is below it.
  it("reads the addon's Node-API level from better-sqlite3's own binding.gyp", async () => {
    const { requiredNodeApi, nodeRangeForNodeApi } = await import("../dist/abi.js");
    // 10 is not copied from anything this process knows: it is what
    // better-sqlite3 13's binding.gyp says, and the whole guard is void if
    // that read ever silently starts returning null (binding.gyp dropped from
    // the tarball, the define renamed). Then the guard would pass everything
    // through to a require that segfaults, in exactly the shape this lane was
    // opened to fix, and nothing else in the suite would notice.
    assert.equal(requiredNodeApi(), 10, "if better-sqlite3 raised NAPI_VERSION, raise engines.node with it");
    assert.equal(nodeRangeForNodeApi(10), "^22.14.0 || >=23.6.0");
    // The running side of the comparison, so a reader can see both halves are
    // real values from independent sources rather than one value twice.
    assert.ok(Number(process.versions.napi) >= 10, "this suite is running below hive's own declared floor");
  });

  it("refuses with a diagnostic when this Node is below the addon's Node-API level", async () => {
    const { checkAbi } = await import("../dist/abi.js");
    const real = checkAbi().addon;
    assert.ok(real, "this test needs the real, working addon as its control");
    const root = join(dirs.tmp, "napi-floor");
    mkdirSync(root, { recursive: true });
    // ONE variable moves: the addon installed here is the real, working one,
    // and only the DECLARED Node-API level is impossible. So the scratch tree
    // runs fine with the guard removed, which is what makes a pass mean
    // something. 99 cannot be reached by any Node, so this discriminates on
    // every machine and every CI leg without a sub-floor interpreter -
    // measured against a real one separately, see the PR body.
    const { cli } = writeScratchAddon(root, { prebuild: real, napiVersion: 99 });

    const status = await runNode(cli, ["status"], { ...doctorOpts, node: process.execPath });
    assert.equal(status.code, 1, status.stdout);
    assert.match(status.stderr, /hive: this Node is too old/);
    assert.match(status.stderr, /built against Node-API 99/);
    assert.match(status.stderr, new RegExp(`provides Node-API ${process.versions.napi}`));
    // The advice that started this: a source build reads the same binding.gyp,
    // so telling the user to build is telling them to reproduce the problem.
    assert.doesNotMatch(status.stderr, /npm install && npm run build/);
    assert.match(status.stderr, /Rebuilding does NOT help/);
    // stdout is a JSON-RPC stream for the MCP server; the diagnostic stays off it.
    assert.equal(status.stdout, "");

    const doctor = await runNode(cli, ["doctor"], { ...doctorOpts, node: process.execPath });
    assert.equal(doctor.code, 1, doctor.stdout);
    assert.match(doctor.stdout, /^hive doctor/);
    assert.match(doctor.stdout, /FAIL {2}better-sqlite3: addon is built against Node-API 99/);
    assert.match(doctor.stdout, /1 problem\(s\) found/);
  });

  // Issue #105 lane B. better-sqlite3 13's N-API prebuilds load under any
  // Node major on this platform/arch (measured: the identical darwin-arm64
  // prebuild opened a database under NODE_MODULE_VERSION 137 and 147), so
  // alternateInterpreter() can no longer make the REAL addon mismatch - both
  // of the tests below used to run the real addon under a genuinely
  // different Node and watch it refuse. There is nothing left in
  // node_modules capable of refusing that way.
  //
  // Rather than document the mismatch as unreachable, these swap in
  // test/fixtures/native-addon-abi/'s classic (pre-13, NODE_MODULE_VERSION-
  // locked) build in place of the real prebuild, in a scratch checkout that
  // does not touch the real node_modules other tests in this suite run
  // against concurrently. That reconstructs a genuine ERR_DLOPEN_FAILED from
  // Node itself - not a fabricated error string - so classifyAddonLoadError's
  // "mismatch" branch (src/abi.ts) still has something real to classify.
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
    // stdout is a JSON-RPC stream for the MCP server; the diagnostic stays off it.
    assert.equal(stdout, "");
  });

  // The other reachable failure (src/abi.ts's AbiStatus["missing"]): nothing
  // built at all. No fixture or alt interpreter needed - a scratch checkout
  // with an empty prebuilds/ reaches this on any platform.
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
    // The remedy has to be one that can actually put the file there. See the
    // unit-level assertions above: `npm run build` is tsc and v13 declares no
    // install script, so the old "npm install && npm run build" named two
    // steps, neither of which produces better_sqlite3.node.
    assert.match(stdout, /Install it: {2}npm install$/m);
    assert.doesNotMatch(stdout, /npm install && npm run build/);
    assert.match(stdout, /1 problem\(s\) found/);
  });
});

describe("hive setup writes a dispatcher", () => {
  const binDir = join(dirs.tmp, "bin");
  const dispatcher = join(binDir, "hive");
  // doctor answers "what does typing `hive` actually run" from PATH, not from
  // HIVE_BIN_DIR (reportDispatcher -> firstHiveOnPath). So HIVE_BIN_DIR alone
  // does not isolate these tests: an inherited PATH carrying a real
  // ~/.local/bin/hive wins over the scratch one, and doctor then reports the
  // developer's own dispatcher. That made two of the tests below pass only on
  // a machine that had never run `hive setup`, which is to say green on CI and
  // on any checkout whose owner had not yet followed hive's own README.
  // PATH is an input to what is under test here, so every case states it.
  // node comes from PATH too: runCli spawns a bare "node".
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
    // Derived from process.execPath, never a literal: the Node running setup
    // is the Node that built better-sqlite3, so the pin and the ABI cannot
    // disagree.
    // includes, not a regex built from a path: a checkout or a Node install
    // under a directory with a regex metacharacter in it would otherwise fail
    // here for a reason that has nothing to do with hive.
    assert.ok(stdout.includes(`interpreter  ${process.execPath}`), stdout);
    assert.match(stdout, new RegExp(`NODE_MODULE_VERSION ${process.versions.modules}`));
  });

  it("runs hive with no node on PATH at all", () => {
    // The point of the whole feature: PATH cannot pick the interpreter.
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

  // The durability paragraph has one branch per kind of interpreter, and which
  // one a machine produces says nothing about whether the others are right.
  // The version this replaced asserted "one of two texts appeared", passed on
  // a laptop whose Node is a version manager's, and broke on a CI runner whose
  // Node is in a hosted toolcache: neither branch it accepted. So each branch
  // is driven here with a path chosen by the test, and the wiring is a
  // separate assertion.
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
      assert.match(text, /npm install && npm run build && hive setup/);
    }
  });

  it("hedges instead of promising safety for an interpreter it does not recognize", async () => {
    const { durabilityLines } = await import("../dist/dispatcher.js");
    const unowned = [
      "/opt/homebrew/bin/node", // Homebrew: genuinely outside a version manager
      "/usr/local/bin/node",
      // The exact path that broke CI. A hosted toolcache is not a version
      // manager's install directory and not a system Node either.
      "/Users/runner/hostedtoolcache/node/22.23.1/arm64/bin/node",
      // A version manager hive does not know about. It lands here too, which
      // is why this branch must not claim the interpreter is safe.
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
      // The list can miss a version manager but never invent one, so the
      // claim it must never make is that nothing can remove this Node.
      assert.doesNotMatch(text, /cannot be removed|is yours to keep\b|safe/);
    }
  });

  it("prints the branch belonging to the interpreter it actually pinned", async () => {
    const { durabilityLines } = await import("../dist/dispatcher.js");
    const { stdout } = await runCli(["setup"], setupOpts);
    // Which branch that is depends on the machine, which is the point: the
    // text of each is pinned above, and this pins that setup prints the one
    // matching what it just wrote into the dispatcher.
    for (const line of durabilityLines(process.execPath)) {
      assert.ok(stdout.includes(line), `setup should print:\n${line}\ngot:\n${stdout}`);
    }
    // Regenerating is part of updating, or the pin drifts from the build.
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
    // binDir comes off PATH as well as out of HIVE_BIN_DIR: the earlier cases
    // left a real dispatcher there, and doctor would report that one rather
    // than the absence this asserts.
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

    // A registration hive cannot vouch for is not a broken install. The claim
    // is that the warning does not change doctor's verdict, so it is made by
    // comparing two runs that differ only in the registration. Asserting
    // exit 0 outright made this test a proxy for the whole environment, and
    // it failed on a runner with no `claude` binary over a check that has
    // nothing to do with registrations.
    writeUserConfig({
      mcpServers: { hive: { type: "stdio", command: process.execPath, args: [SERVER] } },
    });
    const clean = await runCli(["doctor"], doctorOpts);
    assert.doesNotMatch(clean.stdout, /warn {2}mcp registration/);
    const context = `bare:\n${bare.stdout}\nclean:\n${clean.stdout}`;
    assert.equal(bare.code, clean.code, `a registration warning must not change the exit code\n${context}`);
    // The exit code alone saturates: on a box where doctor already fails for
    // an unrelated reason, both runs are 1 and the comparison proves nothing.
    // The summary line carries the count, so it keeps its power everywhere.
    // config-warnings.test.mjs compares the same line for the same reason.
    const summary = (out) => out.trim().split("\n").pop();
    assert.equal(
      summary(bare.stdout),
      summary(clean.stdout),
      `a registration warning must not be counted as a problem\n${context}`,
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
    // Re-registering under hive's own name would leave the user with two
    // servers, so the fix keeps the name they chose.
    assert.match(stdout, /claude mcp add --scope project hive-dev --/);
  });

  it("hands over a re-register line that survives a path with a space", async () => {
    writeUserConfig({ mcpServers: { hive: { command: "node", args: [SERVER] } } });
    const { stdout } = await runCli(["doctor"], doctorOpts);
    // Unquoted, this breaks on the machine hive was written on: a version
    // manager's interpreter lives under "Application Support".
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

// Pinning the `hive` command says nothing about the MCP server: Claude Code
// starts that from its own registration. Setup is where a user is already
// acting on instructions, so it names a registration that disagrees with the
// pin it just made, and says nothing when there is nothing to fix.
describe("hive setup names the registration it cannot fix", () => {
  const binDir = join(dirs.tmp, "setup-mcp-bin");
  const setupOpts = { ...doctorOpts, env: { ...doctorOpts.env, HIVE_BIN_DIR: binDir } };

  before(() => {
    // An earlier suite leaves a project-scope registration in this directory.
    writeFileSync(join(dirs.projectDir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  });

  it("prints the re-register line when the registration is bare", async () => {
    writeUserConfig({ mcpServers: { hive: { type: "stdio", command: "node", args: [SERVER] } } });
    const { code, stdout } = await runCli(["setup"], setupOpts);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /hive setup pins the `hive` command, not the MCP server/);
    // Doctor's words, not a second description of the same problem.
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
    // Handing someone a command to run when nothing is wrong trains them to
    // ignore the times something is.
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
    // Deliberate: setup reads one config dir and at most one project's
    // .mcp.json, so it cannot tell "not registered" from "registered
    // somewhere I cannot see". The README supplies the line for a fresh
    // install; doctor reports the absence as info.
    //
    // The fixture is a config with no mcpServers block, which is the state
    // setup cannot interpret. A config that HAS the block, empty or not, is a
    // fact about a file rather than an inference, and the suite below owns it.
    writeUserConfig({ numStartups: 3 });
    const { stdout } = await runCli(["setup"], setupOpts);
    assert.doesNotMatch(stdout, /mcp registration/);
    assert.doesNotMatch(stdout, /claude mcp add/);
  });
});

// The one registration state setup can establish rather than infer: this
// config file exists, parses, lists MCP servers, and hive is not among them.
// Round 2 stays silent on "no hive registration found", which is an inference
// about the machine; this is a fact about a file hive just read.
describe("hive setup offers the registration a fresh install has not made", () => {
  const ownConfig = join(dirs.tmp, "fresh-config");
  const configFile = join(ownConfig, ".claude.json");
  // Its own config dir and bin dir so deleting the file cannot disturb, or be
  // disturbed by, the suites either side of this one.
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
    // Empty is the shape Claude Code writes for someone who has never added a
    // server, which is the fresh install this exists for.
    write({ mcpServers: {} });
    const empty = await runCli(["setup"], opts);
    assert.match(empty.stdout, OFFER);
    assert.ok(stdout.includes(ADD_LINE), `offer should be pasteable:\n${stdout}`);
    // An offer, not a fault: the "!" block is round 2's, for a registration
    // that disagrees with the pin. A fresh install has nothing wrong with it.
    // (setup's other "!" block, the version-manager caveat, is unrelated.)
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
    // The case the whole silence decision was built around. hive is correctly
    // registered project-scope, and the user config legitimately has an
    // mcpServers block without hive in it. Offering here would tell someone
    // whose setup is right to add a second, duplicate registration.
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
    // Regression pin, not a duplicate of the round 2 cases: the offer must
    // stay out of both, including the bare one where a `claude mcp add` line
    // does print for a different reason.
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
