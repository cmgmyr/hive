import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { isolateTmux, scratchDirs } from "./helpers.mjs";

// FIRST, before this file's own explanation: isolation has to precede anything
// that could reach a tmux server, and test/suite-isolation.test.mjs enforces
// that by reading this source top to bottom.
const { hasTmux } = isolateTmux("auto-attach scope");

// WHAT THIS FILE EXISTS FOR. ensureAttached's whole job is deciding whether to
// open a native terminal window, and the two live modes differ ONLY in which
// clients they count. The first version of this feature tested that decision
// as a pure function taking (sessionHasClient, serverHasClient) while the
// caller passed the SAME value for both, so the pure function's interesting
// case could not occur in production. Reverting "auto" to the per-session
// probe - the regression the feature exists to prevent - left all 1022 tests
// passing, measured before this file was written.
//
// So this asserts against a RECORD OF WHAT HAPPENED: a fake tmux on PATH logs
// every probe and answers a fixture, and a fake osascript logs the fact that
// hive tried to open a window. Nothing here inspects source text or re-checks
// a helper's arithmetic against itself.
//
// The fakes are how this stays deterministic. Counting real clients means
// attaching real ones, which needs a pty per client and makes a unit-level
// decision depend on terminal plumbing. Both the tmux wrapper and the
// AppleScript call reach their binaries through PATH, so replacing the
// binaries is enough to drive every branch.

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
// A stray override from the ambient shell would silently pin every case to one
// mode: the maintainer's own tmux server exports HIVE_AUTO_ATTACH=0 today.
delete process.env.HIVE_AUTO_ATTACH;

const state = join(dirs.tmp, "auto-attach-state");
const bin = join(dirs.tmp, "auto-attach-bin");
mkdirSync(state, { recursive: true });
mkdirSync(bin, { recursive: true });

const PROBES = join(state, "probes.log");
const ATTACHED = join(state, "attached.log");
const SESSION_CLIENTS = join(state, "session-clients");
const SERVER_CLIENTS = join(state, "server-clients");

// `list-clients -t =X` answers for one session; bare `list-clients` answers for
// the whole server. Anything else exits silently, so an unexpected tmux call
// shows up in the log rather than failing in a way that reads as a real bug.
writeFileSync(
  join(bin, "tmux"),
  `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(PROBES)}
if [ "$1" = "list-clients" ]; then
  if [ "$2" = "-t" ]; then cat ${JSON.stringify(SESSION_CLIENTS)} 2>/dev/null
  else cat ${JSON.stringify(SERVER_CLIENTS)} 2>/dev/null
  fi
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
const { autoAttachProbe, ensureAttached } = await import("../dist/tmux.js");

// A client line's contents never matter; tmux's own emptiness check is what
// hive reads. "" means nobody attached.
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

describe("which clients auto-attach counts", () => {
  it("names the probe per mode", () => {
    assert.deepEqual(autoAttachProbe("on", "hive-1"), ["list-clients", "-t", "=hive-1"]);
    assert.deepEqual(autoAttachProbe("auto", "hive-1"), ["list-clients"]);
    assert.deepEqual(autoAttachProbe("off", "hive-1"), ["list-clients"]);
  });

  // ensureAttached is a no-op off darwin by construction, so the cases below
  // would pass everywhere for the wrong reason. These four are covered by
  // the macOS leg of the CI matrix only (ci.yml) - Linux runs two of the
  // three legs and always skips them - so a skip off darwin is honest, a
  // silent pass is not. THIS IS THE ONLY COVERAGE of the `auto` predicate,
  // the same predicate whose false green was the headline lesson of
  // .claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md,
  // and it now runs on exactly one of three CI legs. If that macOS leg is
  // ever dropped (it bills 10x on a private repo; see ci.yml's own comment
  // on the OS split), `auto` loses all coverage and nothing goes red -
  // check for a replacement before cutting it.
  const runnable = process.platform === "darwin" && hasTmux;

  it(
    "auto leaves a clientless session alone while another session is being watched",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "auto", sessionClients: false, serverClients: true });
      ensureAttached("hive-1");
      assert.equal(openedAWindow(), false, "this is the case that opened a window on every spawn");
      assert.deepEqual(probes(), ["list-clients"], "auto must ask the server, never one session");
    },
  );

  it(
    "auto still surfaces a worker once nothing at all is attached",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "auto", sessionClients: false, serverClients: false });
      ensureAttached("hive-1");
      assert.equal(openedAWindow(), true);
    },
  );

  // The negative control for the case above, and the reason it means anything:
  // identical world, different mode, opposite outcome. Without this pair, a
  // hard-coded "never attach" would satisfy the first case.
  it(
    "on keeps the per-session behaviour in that same world",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "on", sessionClients: false, serverClients: true });
      ensureAttached("hive-1");
      assert.equal(openedAWindow(), true);
      assert.deepEqual(probes(), ["list-clients -t =hive-1"]);
    },
  );

  it(
    "off asks tmux nothing and opens nothing",
    { skip: runnable ? false : "darwin-only behaviour" },
    () => {
      world({ mode: "off", sessionClients: false, serverClients: false });
      ensureAttached("hive-1");
      assert.equal(openedAWindow(), false);
      assert.deepEqual(probes(), [], "off must short-circuit before probing");
    },
  );
});
