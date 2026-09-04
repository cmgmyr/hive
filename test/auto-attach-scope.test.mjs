import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DIST, isolateTmux, scratchDirs, withEnv } from "./helpers.mjs";

const { hasTmux } = isolateTmux("auto-attach scope");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

delete process.env.HIVE_AUTO_ATTACH;

const state = join(dirs.tmp, "auto-attach-state");
const bin = join(dirs.tmp, "auto-attach-bin");
mkdirSync(state, { recursive: true });
mkdirSync(bin, { recursive: true });

const PROBES = join(state, "probes.log");
const ATTACHED = join(state, "attached.log");
const SESSION_CLIENTS = join(state, "session-clients");
const SERVER_CLIENTS = join(state, "server-clients");

writeFileSync(
  join(bin, "tmux"),
  `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(PROBES)}
if [ "$1" = "list-clients" ]; then
  if [ "$2" = "-t" ]; then cat ${JSON.stringify(SESSION_CLIENTS)} 2>/dev/null
  else cat ${JSON.stringify(SERVER_CLIENTS)} 2>/dev/null
  fi
fi
# freeViewSessionName (issue #117, review finding F1) probes has-session before
# naming a view - this fixture creates no real sessions, so every candidate
# name must read as free (exit nonzero) or the probe loops through all 1000
# and throws. An unconditional "exit 0" below answered has-session as "found"
# for every name, which is wrong for a fixture with nothing on the server.
# HIVE_TEST_HANG_HAS_SESSION is todo 375's case (review round 2, F7): the
# client probe ANSWERS and the server wedges before the has-session that
# follows it, which is the only window in which ensureAttached could throw
# over a worker that is already live. Logged above before hanging, so the
# record still shows which call it was.
if [ "$1" = "has-session" ]; then
  if [ -n "$HIVE_TEST_HANG_HAS_SESSION" ]; then exec sleep 30; fi
  exit 1
fi
exit 0
`,
);
chmodSync(join(bin, "tmux"), 0o755);

writeFileSync(
  join(bin, "osascript"),
  `#!/bin/sh
printf 'fired\\n' >> ${JSON.stringify(ATTACHED)}
exit 0
`,
);
chmodSync(join(bin, "osascript"), 0o755);

process.env.PATH = `${bin}:${process.env.PATH}`;

const { setAutoAttach } = await import("../dist/config.js");
const { autoAttachProbe, defaultTmuxSocketPath, ensureAttached, privateTmuxSocket } = await import("../dist/tmux.js");

const ON_DEFAULT_SOCKET = { TMUX: `${defaultTmuxSocketPath()},1,0` };

const ON_PRIVATE_TMPDIR = { TMUX: undefined };

const ON_PRIVATE_L_SOCKET = {
  TMUX: `${defaultTmuxSocketPath().replace(/default$/, "hivespike")},12936,0`,
  TMUX_TMPDIR: undefined,
};

const NO_TMUX_ENV = { TMUX: undefined, TMUX_TMPDIR: undefined };

const CLIENT = "/dev/ttys004: hive-1 [80x24 xterm-256color] (attached)\n";

function world({ mode, sessionClients, serverClients }) {
  rmSync(PROBES, { force: true });
  rmSync(ATTACHED, { force: true });
  writeFileSync(SESSION_CLIENTS, sessionClients ? CLIENT : "");
  writeFileSync(SERVER_CLIENTS, serverClients ? CLIENT : "");
  setAutoAttach(mode);
}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
const openedAWindow = () => read(ATTACHED).includes("fired");
const probes = () => read(PROBES).trim().split("\n").filter(Boolean);

const attachFrom = (socket, session) => withEnv(socket, () => ensureAttached(session));

// todo 368 finding E: scratchStoreOnSharedSocket() exempts a real product entry point outside a test
// runner, so ensureAttached()'s probe can be reached without touching HIVE_DATA_DIR at all - keeping
// this file's own scratch store in place, which is what resolvedAutoAttach()/resolvedAttachMode()/
// dataDirTag() need to succeed (none of them refuse a non-default path, under a test runner or not).
// underTestRunner() checks NODE_TEST_CONTEXT first; this node's own --test invocation does not put a
// literal "--test" in process.execArgv (measured), so deleting the env var alone is enough here. If a
// future node version changes that, this fails LOUD (the guard refuses again) rather than silently.
function asProductEntryPoint(fn) {
  const savedArgv1 = process.argv[1];
  const savedNodeTestContext = process.env.NODE_TEST_CONTEXT;
  process.argv[1] = join(DIST, "cli.js");
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return fn();
  } finally {
    process.argv[1] = savedArgv1;
    if (savedNodeTestContext !== undefined) process.env.NODE_TEST_CONTEXT = savedNodeTestContext;
  }
}
const attachFromAsProductEntry = (socket, session) =>
  withEnv(socket, () => asProductEntryPoint(() => ensureAttached(session)));

describe("which clients auto-attach counts", () => {
  it("names the probe per mode", () => {
    assert.deepEqual(autoAttachProbe("on", "hive-1"), ["list-clients", "-t", "=hive-1"]);
    assert.deepEqual(autoAttachProbe("auto", "hive-1"), ["list-clients"]);
    assert.deepEqual(autoAttachProbe("off", "hive-1"), ["list-clients"]);
  });

  const runnable = process.platform === "darwin" && hasTmux;

  it(
    "auto leaves a clientless session alone while another session is being watched",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "auto", sessionClients: false, serverClients: true });
      attachFromAsProductEntry(ON_DEFAULT_SOCKET, "hive-1");
      assert.equal(openedAWindow(), false, "this is the case that opened a window on every spawn");
      assert.deepEqual(probes(), ["list-clients"], "auto must ask the server, never one session");
    },
  );

  it(
    "auto still surfaces a worker once nothing at all is attached",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "auto", sessionClients: false, serverClients: false });
      attachFromAsProductEntry(ON_DEFAULT_SOCKET, "hive-1");
      assert.equal(openedAWindow(), true);
    },
  );

  it(
    "on keeps the per-session behaviour in that same world",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "on", sessionClients: false, serverClients: true });
      attachFromAsProductEntry(ON_DEFAULT_SOCKET, "hive-1");
      assert.equal(openedAWindow(), true);

      const seen = probes();
      assert.equal(seen[0], "list-clients -t =hive-1", "the predicate probe must be unchanged");
      assert.equal(seen.length, 2, `expected exactly one probe after the predicate; saw: ${JSON.stringify(seen)}`);
      assert.match(seen[1], /^has-session -t =hive-\S*view-\d+$/, seen[1]);
    },
  );

  it(
    "survives a server that wedges between the client probe and the view-name probe",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {

      world({ mode: "on", sessionClients: false, serverClients: true });
      withEnv({ ...ON_DEFAULT_SOCKET, HIVE_TEST_HANG_HAS_SESSION: "1", HIVE_TMUX_TIMEOUT_MS: "300" }, () =>
        asProductEntryPoint(() => {
          assert.doesNotThrow(
            () => ensureAttached("hive-1"),
            "auto-attach is best-effort; a wedged server must not fail a spawn that already succeeded",
          );
        }),
      );
      assert.equal(openedAWindow(), false, "with no view name there is nothing to open");

      const seen = probes();
      assert.equal(seen[0], "list-clients -t =hive-1", "the client probe must have ANSWERED first");
      assert.match(seen[1], /^has-session -t =hive-\S*view-\d+$/, seen[1]);
    },
  );

  it(
    "off asks tmux nothing and opens nothing",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "off", sessionClients: false, serverClients: false });
      attachFromAsProductEntry(ON_DEFAULT_SOCKET, "hive-1");
      assert.equal(openedAWindow(), false);
      assert.deepEqual(probes(), [], "off must short-circuit before probing");
    },
  );
});

describe("the shared-socket/scratch-store pair itself is refused (todo 368)", () => {
  const runnable = process.platform === "darwin" && hasTmux;

  // Unlike the block above, these use attachFrom (this file's ordinary scratch store, still under the
  // test runner) to demonstrate the guard actually firing, rather than routing around it.

  it(
    "auto refuses before probing under the scratch-store/shared-socket pair",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "auto", sessionClients: false, serverClients: true });
      attachFrom(ON_DEFAULT_SOCKET, "hive-1");
      assert.equal(openedAWindow(), false);
      assert.deepEqual(probes(), [], "the todo 368 guard must refuse before asking tmux anything");
    },
  );

  it(
    "the refusal itself does not throw out of ensureAttached, matching wedge handling",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "on", sessionClients: false, serverClients: true });
      withEnv({ ...ON_DEFAULT_SOCKET, HIVE_TEST_HANG_HAS_SESSION: "1", HIVE_TMUX_TIMEOUT_MS: "300" }, () => {
        assert.doesNotThrow(
          () => ensureAttached("hive-1"),
          "auto-attach is best-effort; a refusal must not throw out any more than a wedge would",
        );
      });
      assert.equal(openedAWindow(), false);
      assert.deepEqual(probes(), [], "the guard refuses before the client probe that used to answer first");
    },
  );
});

describe("a private tmux socket refuses to attach at all (todo 355)", () => {
  const runnable = process.platform === "darwin" && hasTmux;

  it(
    "auto opens nothing under full isolation, in the very world that surfaces a worker on the default socket",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {

      world({ mode: "auto", sessionClients: false, serverClients: false });
      attachFrom(ON_PRIVATE_TMPDIR, "hive-1");
      assert.equal(openedAWindow(), false, "this is the window that landed on the developer's own desktop");
      assert.deepEqual(probes(), [], "the guard must refuse before asking tmux anything");
    },
  );

  it(
    "on opens nothing inside a `tmux -L` server, where TMUX names the private socket",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {

      world({ mode: "on", sessionClients: false, serverClients: true });
      attachFrom(ON_PRIVATE_L_SOCKET, "hive-1");
      assert.equal(openedAWindow(), false);
      assert.deepEqual(probes(), [], "the guard must refuse before asking tmux anything");
    },
  );

  it(
    "still attaches with no tmux environment at all, which is what an ordinary spawn has",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {

      world({ mode: "auto", sessionClients: false, serverClients: false });
      attachFromAsProductEntry(NO_TMUX_ENV, "hive-1");
      assert.equal(openedAWindow(), true, "the guard must not reach the ordinary case");
      assert.equal(probes()[0], "list-clients", "and it must reach the probe to get there");
    },
  );

  it(
    "todo 355's own guard - privateTmuxSocket - reads the ordinary no-tmux-env case as NOT private, straight from the predicate",
    () => {
      // Belt and suspenders alongside the end-to-end test above: pins the same invariant directly
      // against todo 355's own predicate, matching "names the probe per mode" for autoAttachProbe.
      assert.equal(privateTmuxSocket(undefined, undefined), false, "todo 355's guard must not treat no tmux env at all as private");
    },
  );

  it(
    "with no tmux environment at all but THIS file's necessarily-scratch store, todo 368's guard refuses where todo 355's does not",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {

      // A real ordinary spawn has no TMUX env AND the real default store, which neither guard refuses -
      // confirmed directly above via privateTmuxSocket() itself. A test-runner process can never
      // legitimately point at the real default store (store-and-datadir.md), so this uses the file's
      // own ordinary scratch one instead, to show todo 368's guard catching what todo 355's
      // deliberately does not: a scratch store that would otherwise reach the shared socket unguarded.
      world({ mode: "auto", sessionClients: false, serverClients: false });
      attachFrom(NO_TMUX_ENV, "hive-1");
      assert.equal(openedAWindow(), false);
      assert.deepEqual(probes(), [], "todo 355's socket-only guard is not what stops this - todo 368's store pairing is");
    },
  );
});
