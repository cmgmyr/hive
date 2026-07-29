import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { assertScratchStore, CLI, runCli, scratchDirs, SERVER } from "./helpers.mjs";

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

// A second interpreter whose ABI differs from the one that built the addon.
// Nothing guarantees a machine has one, so the test that needs it says why it
// skipped rather than passing quietly.
function alternateInterpreter() {
  const candidates = [
    process.env.HIVE_TEST_ALT_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter((c) => c && existsSync(c));
  for (const candidate of candidates) {
    try {
      const modules = execFileSync(candidate, ["-p", "process.versions.modules"], {
        encoding: "utf8",
      }).trim();
      if (modules !== process.versions.modules) return { path: candidate, modules };
    } catch {
      // Not a working interpreter; try the next.
    }
  }
  return null;
}

describe("interpreter and ABI", () => {
  const alt = alternateInterpreter();

  before(async () => {
    const init = await runCli(["init"], doctorOpts);
    assert.equal(init.code, 0, init.stderr);
    writeUserConfig({ mcpServers: {} });
  });

  it("doctor names the interpreter and the ABI the addon was built for", async () => {
    const { stdout } = await runCli(["doctor"], doctorOpts);
    const node = /ok {4}node: (v[\d.]+) \(NODE_MODULE_VERSION (\d+)\) at (\/\S+)/.exec(stdout);
    assert.ok(node, `doctor should report the running interpreter:\n${stdout}`);
    const addon = /ok {4}better-sqlite3: addon built for NODE_MODULE_VERSION (\d+), matches/.exec(stdout);
    assert.ok(addon, `doctor should report the addon's ABI:\n${stdout}`);
    assert.equal(node[2], addon[1], "a passing run must agree on one NODE_MODULE_VERSION");
    assert.match(stdout, /better_sqlite3\.node/, "name the file, so two checkouts can be compared");
  });

  it("checks the ABI by loading the addon, which require() alone does not do", async () => {
    await assertScratchStore();
    const { checkAbi } = await import("../dist/abi.js");
    const status = checkAbi();
    assert.equal(status.ok, true, status.error ?? "");
    assert.equal(status.builtFor, Number(process.versions.modules));
    assert.match(status.addon, /better_sqlite3\.node$/);

    // The trap this whole guard exists for: requiring better-sqlite3 does not
    // pull in the native addon, so a passing require proves nothing about
    // whether hive can open its store. Checked in a child process because
    // checkAbi has already loaded the addon into this one.
    const probe = execFileSync(
      process.execPath,
      [
        "-e",
        'require("better-sqlite3");' +
          'console.log(Object.keys(require.cache).some((k) => k.endsWith("better_sqlite3.node")) ? "loaded" : "not-loaded");',
      ],
      { cwd: REPO, encoding: "utf8" },
    ).trim();
    assert.equal(probe, "not-loaded", "if this ever says loaded, the lazy-binding reasoning is stale");
  });

  it("explains a mismatch in terms of both interpreters", async () => {
    const { describeAbi, abiFixLines } = await import("../dist/abi.js");
    const mismatch = { addon: "/x/better_sqlite3.node", running: 147, builtFor: 137, ok: false, error: null };
    assert.match(describeAbi(mismatch), /built for NODE_MODULE_VERSION 137/);
    assert.match(describeAbi(mismatch), /needs 147/);
    assert.match(abiFixLines(mismatch).join("\n"), /npm install && npm run build/);

    const missing = { addon: null, running: 137, builtFor: null, ok: false, error: "not built" };
    assert.match(describeAbi(missing), /not built/);
    assert.match(abiFixLines(missing).join("\n"), /npm install && npm run build/);
  });

  it("does not tell a broken interpreter to run `hive setup`", async () => {
    const { abiFixLines } = await import("../dist/abi.js");
    const mismatch = { addon: "/x/better_sqlite3.node", running: 147, builtFor: 137, ok: false, error: null };
    // `hive setup` pins whatever Node runs it, and the `hive` on PATH is the
    // command that just failed. Advice that loops back to it is no advice.
    const bare = abiFixLines(mismatch).join("\n");
    assert.doesNotMatch(bare, /^ *hive setup$/m);
    assert.match(bare, /<the Node that built it> ".*dist\/cli\.js" setup/);
    // With a dispatcher on disk, hive knows an interpreter that works.
    assert.match(abiFixLines(mismatch, "/pinned/node").join("\n"), /"\/pinned\/node" ".*cli\.js" setup/);
  });

  it("fails doctor under an interpreter that cannot load the addon", {
    skip: alt ? false : "no second Node with a different ABI on this machine",
  }, async () => {
    const { code, stdout } = await runCli(["doctor"], { ...doctorOpts, node: alt.path });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^hive doctor/);
    assert.match(stdout, new RegExp(`FAIL {2}node: .*NODE_MODULE_VERSION ${alt.modules}`));
    assert.match(
      stdout,
      new RegExp(`FAIL {2}better-sqlite3: addon built for NODE_MODULE_VERSION ${process.versions.modules}`),
    );
    assert.match(stdout, /1 problem\(s\) found/);
  });

  it("names the interpreter on any other command too, without a stack trace", {
    skip: alt ? false : "no second Node with a different ABI on this machine",
  }, async () => {
    const { code, stdout, stderr } = await runCli(["status"], { ...doctorOpts, node: alt.path });
    assert.equal(code, 1);
    assert.match(stderr, /hive: cannot run under this Node/);
    assert.doesNotMatch(stderr, /ERR_DLOPEN_FAILED/, "the raw dlopen error is what this replaces");
    // stdout is a JSON-RPC stream for the MCP server; the diagnostic stays off it.
    assert.equal(stdout, "");
  });
});

describe("hive setup writes a dispatcher", () => {
  const binDir = join(dirs.tmp, "bin");
  const dispatcher = join(binDir, "hive");
  const setupOpts = { ...doctorOpts, env: { ...doctorOpts.env, HIVE_BIN_DIR: binDir } };

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
    const { stdout } = await runCli(["doctor"], {
      ...setupOpts,
      env: { ...setupOpts.env, HIVE_BIN_DIR: join(dirs.tmp, "absent") },
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
