import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, recordScratchTmuxSocket } from "./helpers.mjs";
import {
  DIST_DIR,
  MCP_CONFIG_FILE,
  REPO_DIR,
  SRC_DIR,
  checkAxesPresent,
  checkDistBuilt,
  checkDistFresh,
  checkNotDefaultStore,
  checkOwnsInstance,
  checkSocketPathLength,
  checkTmuxTmpDirExists,
  formatEnvBlock,
  killSocket,
  scratchPaths,
  workerProjectRoot,
  writeWorkerMcpConfig,
} from "../scripts/isolated-hive.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the isolated-hive script tests");
after(() => cleanupTmux());

const SCRIPT = new URL("../scripts/isolated-hive.mjs", import.meta.url).pathname;

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("isolated-hive guards", () => {
  it("refuses when the data dir resolves to hive's default store", async () => {
    const { isDefaultStore, DEFAULT_DATA_DIR } = await import("../dist/dataDir.js");
    assert.match(checkNotDefaultStore(DEFAULT_DATA_DIR, isDefaultStore), /resolves to hive's default store/);
    assert.equal(checkNotDefaultStore(join(tmpdir(), "some-scratch-dir"), isDefaultStore), null);
  });

  it("refuses when either isolation axis is missing", () => {
    assert.match(checkAxesPresent({ dataDir: "/x", tmuxTmpDir: undefined }), /missing TMUX_TMPDIR\b/);
    assert.match(checkAxesPresent({ dataDir: undefined, tmuxTmpDir: "/y" }), /missing HIVE_DATA_DIR\b/);
    assert.match(
      checkAxesPresent({ dataDir: undefined, tmuxTmpDir: undefined }),
      /missing HIVE_DATA_DIR and TMUX_TMPDIR/,
    );
    assert.equal(checkAxesPresent({ dataDir: "/x", tmuxTmpDir: "/y" }), null);
  });

  it("refuses a socket path over the cap, naming the measured length", async () => {
    const { tmuxSocketPath } = await import("../dist/tmux.js");

    const longDir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    const nested = join(longDir, "x".repeat(120));
    mkdirSync(nested);
    try {
      const refusal = checkSocketPathLength(nested, tmuxSocketPath, 100);
      const measured = Number(/(\d+) bytes/.exec(refusal)?.[1]);
      assert.ok(measured > 100, `expected the refusal to name a measured length over 100, got: ${refusal}`);
    } finally {
      rmSync(longDir, { recursive: true, force: true });
    }
  });

  it("accepts a socket path within the cap", async () => {
    const { tmuxSocketPath } = await import("../dist/tmux.js");
    const shortDir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      assert.equal(checkSocketPathLength(shortDir, tmuxSocketPath, 100), null);
    } finally {
      rmSync(shortDir, { recursive: true, force: true });
    }
  });

  it("refuses when TMUX_TMPDIR does not exist, rather than assuming tmux will create it", () => {
    const missing = join(tmpdir(), `hive-iso-missing-${Math.random().toString(36).slice(2)}`);
    assert.match(checkTmuxTmpDirExists(missing), /does not exist/);
  });

  it("accepts an existing TMUX_TMPDIR", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      assert.equal(checkTmuxTmpDirExists(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing build as a plain refusal, not a thrown stack", () => {
    assert.match(checkDistBuilt(join(tmpdir(), "definitely-not-a-real-dist-dir")), /no built dist at/);
  });

  it("refuses a dist/ older than src/, naming the fix", () => {
    const scratchDist = mkdtempSync(join(tmpdir(), "hive-iso-test-dist-"));
    try {
      const oldTime = new Date(0);
      for (const f of ["index.js", "cli.js", "dataDir.js", "tmux.js"]) {
        const path = join(scratchDist, f);
        writeFileSync(path, "// stale stand-in\n");
        utimesSync(path, oldTime, oldTime);
      }
      assert.match(checkDistFresh(scratchDist, SRC_DIR), /dist\/ at .* is older than src\/.*npm run build/s);
    } finally {
      rmSync(scratchDist, { recursive: true, force: true });
    }
  });

  it("accepts the real, just-built dist as fresh against its own src", () => {
    assert.equal(checkDistFresh(DIST_DIR, SRC_DIR), null);
  });

  it("names the branch's own dist in the env block, unquoted where shellQuote leaves it bare", async () => {
    const { shellQuote } = await import("../dist/tmux.js");
    const block = formatEnvBlock({ dataDir: "/scratch/data", tmuxTmpDir: "/scratch/tmux", distDir: DIST_DIR }, shellQuote);
    assert.match(block, new RegExp(reEscape(DIST_DIR)));
    assert.match(block, /unset TMUX TMUX_PANE/);
    assert.match(block, /export HIVE_DATA_DIR=\/scratch\/data/);
    assert.match(block, /export TMUX_TMPDIR=\/scratch\/tmux/);

    assert.match(block, /export HIVE_AUTO_ATTACH=0/);
  });

  it("killSocket returns null for the default socket and for a missing tmux dir, without starting a server", async () => {
    const { tmuxSocketPath, privateTmuxSocket } = await import("../dist/tmux.js");
    const deps = { tmuxSocketPath, privateTmuxSocket };
    assert.equal(killSocket({ tmuxTmpDir: "/tmp" }, deps), null, "socket path is empty");
    assert.equal(
      killSocket({ tmuxTmpDir: join(tmpdir(), `hive-iso-missing-${Math.random().toString(36).slice(2)}`) }, deps),
      null,
      "missing tmux dir",
    );
  });

  it("killSocket returns the resolved socket for a genuinely private tmux dir", async () => {
    const { tmuxSocketPath, privateTmuxSocket } = await import("../dist/tmux.js");
    const dir = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      const socket = killSocket({ tmuxTmpDir: dir }, { tmuxSocketPath, privateTmuxSocket });
      assert.equal(typeof socket, "string");
      assert.ok(socket.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance refuses a state whose paths do not match what up creates for its root", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      const state = { root, dataDir: "/somewhere/else", tmuxTmpDir: scratchPaths(root).tmuxTmpDir };
      assert.match(checkOwnsInstance(state), /paths do not match what `up` creates/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance refuses a root with matching paths but no hive-isolated marker", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    try {
      assert.match(checkOwnsInstance(scratchPaths(root)), /has no hive-isolated marker/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance refuses a root with a marker but no workerRoot named at all", () => {

    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    writeFileSync(join(root, ".hive-isolated-instance"), "test\n");
    try {
      assert.match(checkOwnsInstance(scratchPaths(root)), /names no valid worker-facing project root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance refuses a workerRoot with no hive-isolated marker of its own", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));
    writeFileSync(join(root, ".hive-isolated-instance"), "test\n");
    const workerRoot = mkdtempSync(join(tmpdir(), "hive-iso-test-worker-"));
    try {
      assert.match(
        checkOwnsInstance({ ...scratchPaths(root), workerRoot }),
        /names no valid worker-facing project root/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workerRoot, { recursive: true, force: true });
    }
  });

  it("checkOwnsInstance accepts a root and a workerRoot each carrying the marker up writes", () => {
    const root = mkdtempSync(join(tmpdir(), "hive-iso-test-"));

    writeFileSync(join(root, ".hive-isolated-instance"), "test\n");
    const workerRoot = mkdtempSync(join(tmpdir(), "hive-iso-test-worker-"));
    writeFileSync(join(workerRoot, ".hive-isolated-instance"), "test\n");
    try {
      assert.equal(checkOwnsInstance({ ...scratchPaths(root), workerRoot }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(workerRoot, { recursive: true, force: true });
    }
  });
});

describe("the worker-facing project root", () => {

  it("workerProjectRoot creates a fresh directory under the given repo dir's .claude/", () => {
    const fakeRepo = mkdtempSync(join(tmpdir(), "hive-iso-fake-repo-"));
    mkdirSync(join(fakeRepo, ".claude"));
    try {
      const root = workerProjectRoot(fakeRepo);
      try {
        assert.ok(existsSync(root));
        assert.equal(dirname(root), realpathSync(join(fakeRepo, ".claude")));
        const second = workerProjectRoot(fakeRepo);
        try {
          assert.notEqual(second, root, "two calls must never hand back the same directory");
        } finally {
          rmSync(second, { recursive: true, force: true });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  it("writeWorkerMcpConfig points --mcp-config at this branch's dist, not at the pinned `hive` shim", () => {
    const workerRoot = mkdtempSync(join(tmpdir(), "hive-iso-test-worker-"));
    try {
      const path = writeWorkerMcpConfig(workerRoot, "/some/branch/dist", "/some/pinned/node");
      assert.equal(path, join(workerRoot, MCP_CONFIG_FILE));
      const config = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(config.mcpServers["hive-iso"].command, "/some/pinned/node");
      assert.deepEqual(config.mcpServers["hive-iso"].args, ["/some/branch/dist/index.js"]);

      assert.equal(config.mcpServers["hive-iso"].env, undefined);
    } finally {
      rmSync(workerRoot, { recursive: true, force: true });
    }
  });
});

describe("isolated-hive CLI lifecycle", () => {

  const scratchTmpDir = mkdtempSync("/tmp/hi-");
  after(() => rmSync(scratchTmpDir, { recursive: true, force: true }));

  function run(args) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: scratchTmpDir },
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
  }

  after(() => run(["down"]));

  it("up creates both scratch dirs; env and down operate on the same instance; down is safe twice", () => {
    const up = run(["up"]);
    assert.equal(up.code, 0, up.stdout);

    const dataDir = /HIVE_DATA_DIR=(\S+)/.exec(up.stdout)?.[1];
    const tmuxTmpDir = /TMUX_TMPDIR=(\S+)/.exec(up.stdout)?.[1];
    assert.ok(dataDir && tmuxTmpDir, up.stdout);
    assert.ok(existsSync(dataDir), "up must create HIVE_DATA_DIR before reporting success");
    assert.ok(existsSync(tmuxTmpDir), "up must create TMUX_TMPDIR itself, never assume tmux will");

    const second = run(["up"]);
    assert.equal(second.code, 1, "a second up must refuse while an instance is already up");
    assert.match(second.stderr, /already up at/);

    const env = run(["env"]);
    assert.equal(env.code, 0, env.stdout);
    assert.match(env.stdout, new RegExp(reEscape(dataDir)));
    assert.match(env.stdout, new RegExp(reEscape(DIST_DIR)));

    const root = dirname(tmuxTmpDir);
    const down = run(["down"]);
    assert.equal(down.code, 0, down.stdout);
    assert.ok(!existsSync(root), "down must remove the whole scratch tree up created, and only that tree");

    const downAgain = run(["down"]);
    assert.equal(downAgain.code, 0, "down must be safe to run twice");
    assert.match(downAgain.stdout, /nothing to tear down/);

    const envAfter = run(["env"]);
    assert.equal(envAfter.code, 1, "env must refuse once the instance has been torn down");
    assert.match(envAfter.stderr, /no instance is up/);
  });

  it("up creates a worker-facing project root under this repo's .claude/, with an mcp-config pointing at this branch's dist; down removes it", () => {

    const up = run(["up"]);
    assert.equal(up.code, 0, up.stdout);
    const workerRootLine = /worker-facing project root \(pre-trusted, see header\): (\S+)/.exec(up.stderr);
    assert.ok(workerRootLine, up.stderr);
    const workerRoot = workerRootLine[1];

    assert.equal(dirname(workerRoot), realpathSync(join(REPO_DIR, ".claude")));
    assert.ok(existsSync(join(workerRoot, MCP_CONFIG_FILE)), "up must write the worker's --mcp-config file");
    const config = JSON.parse(readFileSync(join(workerRoot, MCP_CONFIG_FILE), "utf8"));
    assert.match(config.mcpServers["hive-iso"].args[0], new RegExp(`^${reEscape(DIST_DIR)}`));

    const down = run(["down"]);
    assert.equal(down.code, 0, down.stdout);
    assert.ok(!existsSync(workerRoot), "down must remove the worker-facing project root, not just `root`");
  });

  it("up self-heals a stale state file whose root was removed externally", () => {

    const first = run(["up"]);
    assert.equal(first.code, 0, first.stdout);
    const firstDataDir = /HIVE_DATA_DIR=(\S+)/.exec(first.stdout)?.[1];
    assert.ok(firstDataDir, first.stdout);
    const firstWorkerRoot = /worker-facing project root \(pre-trusted, see header\): (\S+)/.exec(first.stderr)?.[1];
    assert.ok(firstWorkerRoot, first.stderr);

    rmSync(dirname(firstDataDir), { recursive: true, force: true });

    try {
      const second = run(["up"]);
      assert.equal(second.code, 0, second.stdout);
      assert.match(second.stderr, /isolated hive instance up at/);

      assert.doesNotMatch(
        second.stderr,
        /claimed the instance pointer first/,
        "a stale pointer must self-heal, not be misreported as a concurrent race",
      );
      assert.ok(
        !existsSync(firstWorkerRoot),
        "the self-heal must sweep the first run's workerRoot too, or it leaks inside the repo checkout forever",
      );

      const secondDataDir = /HIVE_DATA_DIR=(\S+)/.exec(second.stdout)?.[1];
      assert.ok(secondDataDir, second.stdout);
      assert.notEqual(secondDataDir, firstDataDir, "must create a genuinely new root, not reuse the stale one");
    } finally {

      run(["down"]);
    }
  });

  it("down refuses, and deletes nothing, when the state file names a directory up never created", () => {

    const tag = createHash("sha256").update(realpathSync(REPO_DIR)).digest("hex").slice(0, 8);
    const forgedStatePath = join(scratchTmpDir, `hive-isolated-instance-${tag}.json`);
    const foreign = mkdtempSync(join(tmpdir(), "hive-iso-foreign-"));
    writeFileSync(
      forgedStatePath,
      JSON.stringify({ root: foreign, dataDir: join(foreign, "data"), tmuxTmpDir: join(foreign, "tmux"), createdAt: "now" }),
    );
    try {
      const result = run(["down"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /has no hive-isolated marker/);
      assert.ok(existsSync(foreign), "down must not delete a directory it does not own");
    } finally {
      rmSync(forgedStatePath, { force: true });
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("down refuses to delete workerRoot when root is already gone and workerRoot carries no marker", () => {
    const tag = createHash("sha256").update(realpathSync(REPO_DIR)).digest("hex").slice(0, 8);
    const forgedStatePath = join(scratchTmpDir, `hive-isolated-instance-${tag}.json`);
    const goneRoot = join(scratchTmpDir, "root-that-was-already-cleaned-up");

    const arbitraryDir = mkdtempSync(join(tmpdir(), "hive-iso-arbitrary-"));
    writeFileSync(join(arbitraryDir, "definitely-not-hive-related.txt"), "do not delete me\n");
    writeFileSync(
      forgedStatePath,
      JSON.stringify({
        root: goneRoot,
        dataDir: join(goneRoot, "data"),
        tmuxTmpDir: join(goneRoot, "tmux"),
        workerRoot: arbitraryDir,
        createdAt: "now",
      }),
    );
    try {
      const result = run(["down"]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /has no hive-isolated marker/);
      assert.ok(existsSync(arbitraryDir), "down must not delete workerRoot without proof it created it");
      assert.ok(
        existsSync(join(arbitraryDir, "definitely-not-hive-related.txt")),
        "the arbitrary directory's contents must survive untouched",
      );
    } finally {
      rmSync(forgedStatePath, { force: true });
      rmSync(arbitraryDir, { recursive: true, force: true });
    }
  });

  it("up refuses to delete workerRoot on its stale-pointer self-heal when workerRoot carries no marker", () => {
    const tag = createHash("sha256").update(realpathSync(REPO_DIR)).digest("hex").slice(0, 8);
    const forgedStatePath = join(scratchTmpDir, `hive-isolated-instance-${tag}.json`);
    const goneRoot = join(scratchTmpDir, "root-that-was-already-cleaned-up-2");
    const arbitraryDir = mkdtempSync(join(tmpdir(), "hive-iso-arbitrary-"));
    writeFileSync(join(arbitraryDir, "definitely-not-hive-related.txt"), "do not delete me\n");
    writeFileSync(
      forgedStatePath,
      JSON.stringify({
        root: goneRoot,
        dataDir: join(goneRoot, "data"),
        tmuxTmpDir: join(goneRoot, "tmux"),
        workerRoot: arbitraryDir,
        createdAt: "now",
      }),
    );
    try {
      const result = run(["up"]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /has no hive-isolated marker/);
      assert.ok(existsSync(arbitraryDir), "up's self-heal must not delete workerRoot without proof it created it");
      assert.ok(
        existsSync(join(arbitraryDir, "definitely-not-hive-related.txt")),
        "the arbitrary directory's contents must survive untouched",
      );
    } finally {
      rmSync(forgedStatePath, { force: true });
      rmSync(arbitraryDir, { recursive: true, force: true });
      run(["down"]);
    }
  });

  it("refuses an unknown subcommand, including inherited Object.prototype members", () => {

    for (const bogus of ["bogus", "toString", "constructor", "hasOwnProperty"]) {
      const result = run([bogus]);
      assert.equal(result.code, 1, `expected "${bogus}" to be refused as an unknown subcommand, got exit ${result.code}`);
    }
  });

  it("up refuses through the real wiring when the socket path is over the cap", () => {
    const longBase = mkdtempSync("/tmp/hi-long-");
    const longTmpDir = join(longBase, "x".repeat(90));
    mkdirSync(longTmpDir);
    try {
      execFileSync(process.execPath, [SCRIPT, "up"], { encoding: "utf8", env: { ...process.env, TMPDIR: longTmpDir } });
      assert.fail("expected up to refuse due to an over-cap socket path");
    } catch (e) {
      assert.equal(e.status, 1);
      assert.match(e.stderr ?? "", /socket path is \d+ bytes/);
    } finally {
      rmSync(longBase, { recursive: true, force: true });
    }
  });

  it("up refuses through the real wiring when dist is stale", () => {

    const probeFile = join(SRC_DIR, "tmux.ts");
    const before = statSync(probeFile);
    const future = new Date(Date.now() + 60_000);
    utimesSync(probeFile, future, future);
    try {
      const result = run(["up"]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /is older than src\//);
    } finally {
      utimesSync(probeFile, before.atime, before.mtime);
      run(["down"]);
    }
  });

  it("down kills only the private tmux server it created, leaving the ambient/shared one alone", async () => {

    const { tmuxSocketPath } = await import("../dist/tmux.js");
    const ambientSession = "ambient-guard";
    execFileSync("tmux", ["new-session", "-d", "-s", ambientSession]);
    try {
      const up = run(["up"]);
      assert.equal(up.code, 0, up.stdout);
      const tmuxTmpDir = /TMUX_TMPDIR=(\S+)/.exec(up.stdout)?.[1];
      assert.ok(tmuxTmpDir, up.stdout);
      const scratchSocket = tmuxSocketPath(undefined, tmuxTmpDir);

      recordScratchTmuxSocket(scratchSocket);

      execFileSync("tmux", ["new-session", "-d", "-s", "worker-under-test"], {
        env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
      });

      const beforeList = execFileSync("tmux", ["-S", scratchSocket, "list-sessions"], { encoding: "utf8" });
      assert.match(beforeList, /worker-under-test/);

      const down = run(["down", "--force"]);
      assert.equal(down.code, 0, down.stdout);

      assert.throws(
        () => execFileSync("tmux", ["-S", scratchSocket, "list-sessions"], { stdio: "pipe" }),
        /./,
        "the private server's session must be reaped, not just its directory removed",
      );

      const ambientList = execFileSync("tmux", ["list-sessions"], { encoding: "utf8" });
      assert.match(ambientList, new RegExp(ambientSession), "the ambient/shared-standin session must survive untouched");
    } finally {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${ambientSession}`], { stdio: "ignore" });
      } catch {

      }
    }
  });
});
