import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Todo 375, counselors round 2. CAPTURED AT MODULE LOAD, ABOVE ANY TEST
// BODY'S REACH, and that position is the whole fix. clearHiveEnv() below
// deletes EVERY HIVE_* key, this one included, and isolateTmux() used to read
// it from process.env at call time - so a file that cleared first and
// isolated second dropped its own socket from the run-level leak manifest
// while the run still printed "N scratch socket(s) checked, all gone".
// Nothing in that sentence distinguishes N checked from N of M checked, which
// is test/CLAUDE.md's shape 7 living inside the leak detector itself.
//
// Latent rather than live when it was found (no file violates the order
// today), and enforced by convention only, which is what made it worth
// closing structurally: this module is evaluated before any importing file's
// body, so the capture cannot lose that race.
const LEAK_MANIFEST = process.env.HIVE_TMUX_LEAK_MANIFEST;
export const DIST = join(REPO, "dist");
export const SERVER = join(DIST, "index.js");
export const CLI = join(DIST, "cli.js");
// The SessionStart hook runs this file directly, not through cli.js.
export const KICKOFF = join(DIST, "kickoff.js");

// The suite is normally run from inside a hive worker pane, whose env carries
// HIVE_AGENT_ID, HIVE_PROJECT_LOCK and friends. Inheriting those makes a
// spawned server think it is that worker, so drop the whole namespace and let
// each helper set back only what it means to. Explicit per-call env still wins.
export function baseEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HIVE_")));
}

// The in-process counterpart of baseEnv, for a test that imports dist/ rather
// than spawning it: same rule, applied to this process. Call it before the
// first import of anything that reads HIVE_* at module load, then set back
// only what the test means to.
export function clearHiveEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HIVE_")) delete process.env[key];
  }
}

// A project with hive.yml processes that hive will actually run.
//
// Two things gate every hive.yml command path, and a test that skips either
// one never reaches the code it means to test. The config has to be on disk
// where loadProjectYml finds it, and the command has to be trusted, which is
// normally an interactive y/N prompt: without the trust row a non-TTY run
// prints "not trusted yet" and returns before doing anything.
//
// Trust is keyed by a hash of exactly what will run, so this seeds it with
// hive's own configHash rather than a copy. A drift between the two would
// otherwise show up as a test that mysteriously stopped reaching the command.
//
// db is passed in and configHash is imported INSIDE the function so that
// nothing here pulls dist/ in at hoist time. That is no longer what stands
// between the suite and a live store (see test/store-isolation.test.mjs), but
// a static dist import at the top of this file is the literal line that
// destroyed one, and every test file imports this one.
export async function seedTrustedYml({ db, projectId, projectDir, processes }) {
  const { configHash } = await import("../dist/projectYml.js");
  const lines = Object.entries(processes).map(([name, command]) => `  ${name}: ${command}`);
  writeFileSync(join(projectDir, "hive.yml"), `processes:\n${lines.join("\n")}\n`);
  for (const [name, command] of Object.entries(processes)) {
    db.prepare(
      "INSERT OR IGNORE INTO command_trust (project_id, name, config_hash) VALUES (?, ?, ?)",
    ).run(projectId, name, configHash(name, command, null, {}));
  }
}

// Call this after setting HIVE_DATA_DIR and BEFORE importing dist/db.js, in
// any test file that imports dist/ directly instead of spawning it.
//
// Two structural guards now stand behind this, and it is worth being precise
// about what is left for it to do. dist/dataDir.js reads HIVE_DATA_DIR when
// asked rather than caching it at module load, so import order no longer
// decides the store; and storeDir() refuses the real ~/.hive outright when a
// test runner is the entry point, so a file that never sets HIVE_DATA_DIR
// fails loudly instead of running its DELETEs on a live store. Neither can
// tell one scratch directory from another: HIVE_DATA_DIR inherited from the
// worker pane this suite usually runs in points somewhere real enough to
// satisfy both and wrong enough to ruin the run. That is this function's
// remaining job, plus giving a destructive file its error at the top instead
// of at the first statement. See test/store-isolation.test.mjs.
export async function assertScratchStore() {
  const { storeDir, DEFAULT_DATA_DIR } = await import("../dist/dataDir.js");
  const resolved = storeDir();
  if (resolved === DEFAULT_DATA_DIR || resolved !== process.env.HIVE_DATA_DIR) {
    throw new Error(
      `Test store is not isolated: dist resolved the store to ${resolved}, expected ${process.env.HIVE_DATA_DIR}. ` +
        "Refusing to run against a store this test does not own.",
    );
  }
}

export function scratchDirs() {
  // realpath because macOS tmpdir is a symlink (/var -> /private/var) and
  // hive resolves project paths to their real location.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-test-")));
  return {
    dataDir: join(root, "data"),
    projectDir: mkdtempSync(join(root, "project-")),
    tmp: mkdtempSync(join(root, "tmp-")),
  };
}

// Writes `source` as its own .mjs file under `tmp` and runs it as a fresh
// process, so latched or module-load-time state (storeReplaced()'s latch,
// storeDir()'s module-body side effects) cannot leak between scenarios the
// way it would on one shared process. Asserts a clean exit before parsing
// stdout as JSON, so a fixture that threw fails with its stderr attached
// rather than a confusing JSON.parse error.
export function runFixture(tmp, name, source, env) {
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, source);
  const result = spawnSync(process.execPath, [file], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(result.status, 0, `fixture ${name} failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// Source text for a runFixture() script that reproduces restoreSnapshot's
// exact on-disk sequence (src/backup.ts): copy a decoy to a `.restoring`
// temp path, rename it over the live db (an atomic swap onto a different
// inode, the same way a restore orphans an open connection), then drop the
// stale sidecars. dbPathExpr must be a JS expression, as source text,
// evaluating to the db path - typically JSON.stringify(join(dataDir,
// "hive.db")) from the caller. Requires cpSync, renameSync, rmSync, and
// writeFileSync imported in the fixture script.
export function storeReplaceScript(dbPathExpr) {
  return (
    `const decoyPath = ${dbPathExpr} + ".decoy";\n` +
    `writeFileSync(decoyPath, "not a real sqlite file, only the inode matters here");\n` +
    `const tmpPath = ${dbPathExpr} + ".restoring";\n` +
    `cpSync(decoyPath, tmpPath);\n` +
    `renameSync(tmpPath, ${dbPathExpr});\n` +
    `for (const suffix of ["-wal", "-shm"]) rmSync(${dbPathExpr} + suffix, { force: true });\n`
  );
}

// The import line every storeReplaceScript() caller needs.
export const FS_SWAP_IMPORT = `import { cpSync, renameSync, rmSync, writeFileSync } from "node:fs";\n`;

// A stand-in `claude` binary: isClaudeCommand matches on basename, so
// spawning it exercises the same brief-writing and pane-announcement code
// paths a real claude would, without an API turn per test. Each call gets its
// own directory because the basename is what's matched, not the path.
// `exec sh -c` rather than `exec runs` directly so a caller can pass more than
// one shell command (e.g. "cat fixture; sleep 600"), not just a single one.
export function makeFakeClaude(tmp) {
  let count = 0;
  return function fakeClaude(runs = "sleep 600") {
    const bin = join(tmp, `claude-${count++}`);
    mkdirSync(bin, { recursive: true });
    const path = join(bin, "claude");
    writeFileSync(path, `#!/bin/sh\nexec sh -c ${JSON.stringify(runs)}\n`);
    chmodSync(path, 0o755);
    return path;
  };
}

// Fakes macOS `open` on PATH, the same shape as makeFakeClaude above for the
// analogous reason (todo 356): a real `open` would pop a real browser window
// on whatever machine runs the suite. `bin` logs every invocation's args to
// a file a test reads back with `calls()`; `failBin` holds a second `open`
// that exits nonzero without logging anything, for simulating a launch that
// never actually opened a window. One call per test file is enough - both
// dashboard-open test files use exactly one - so this returns a single
// fixture rather than a factory with makeFakeClaude's per-call counter.
export function makeFakeOpen(tmp) {
  const bin = join(tmp, "fake-open-bin");
  const failBin = join(tmp, "fake-open-fail-bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(failBin, { recursive: true });
  const log = join(tmp, "fake-open.log");
  writeFileSync(join(bin, "open"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(join(bin, "open"), 0o755);
  writeFileSync(join(failBin, "open"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(failBin, "open"), 0o755);
  writeFileSync(log, "");
  return {
    bin,
    failBin,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    reset: () => writeFileSync(log, ""),
  };
}

// Puts this process, and every child that inherits its env, on a private tmux
// server. Call it at module top level, before anything spawns tmux.
//
// Every tmux call in the suite, including the ones inside dist/tmux.js,
// inherits this env. Pointing TMUX_TMPDIR at a private socket dir keeps the
// suite off the developer's own server, so a hard crash cannot strand a
// session there; clearing TMUX/TMUX_PANE stops tmux from treating the pane
// running the tests as a target. Short dir: unix socket paths cap out around
// 104 bytes.
//
// This lives here because it encodes a stated invariant (see CLAUDE.md), and a
// second hand-rolled copy that drifts fails open: it talks to the real server
// and can act on the session the developer is working in.
//
// ALWAYS PAIR THIS WITH A SCRATCH HIVE_DATA_DIR. Isolating tmux on its own is
// the more dangerous half-measure, not the safe subset: a hive process on a
// private tmux server while still using the default store asks that server
// about panes that live on the shared one, gets a correct "no such pane", and
// sweeps every agent in the real store as dead. That happened on 2026-07-29.
// hive refuses that pair outright now (see untrustedTmuxServer in src/tmux.ts),
// so a caller who sets only this one gets a hive that answers "unknown" to
// every liveness question rather than a hive that destroys state. Setting both
// is what a test actually wants.
//
// Returns { hasTmux, cleanup }. cleanup(...sessionNames) kills ONLY the named
// sessions and is still the right tool mid-file (see below for why exit is
// different). Never call kill-server from cleanup() itself: it has no socket
// path of its own to pin, so it resolves through whatever the AMBIENT env
// currently points at, which a test can legitimately have repointed mid-file
// to exercise a second socket - a bare kill-server there takes down whichever
// server that happens to be. The exit handler below also calls kill-server,
// but against an explicit `-S <socket>`, never the ambient env; that is what
// makes it safe where a bare call here would not be.
//
// cleanup deliberately does NOT remove the socket directory, and that is the
// whole reason this comment exists. It used to, and a file with more than one
// tmux describe then destroyed its own isolation halfway through: the first
// after() hook removed the dir, TMUX_TMPDIR went on naming a path that no longer
// existed, and tmux DOES NOT CREATE IT. Per CLAUDE.md that resolves to the
// SHARED socket, so every later describe in the file quietly created its
// sessions on the developer's own tmux server. On 2026-07-29 that put a
// list-panes -a in a test face to face with the developer's real panes and typed
// five wake bodies into a live claude session. Nothing was lost, and nothing
// about it was loud.
//
// So the directory is removed once, on process exit, when no more tmux calls can
// happen. Registered once per isolateTmux call; a file that calls it twice gets
// two handlers for two directories, which is correct.
// tmux puts its socket at <TMUX_TMPDIR>/tmux-<uid>/default. One derivation
// for every caller here, matching src/tmux.ts's socketUnder(): three copies
// of this join had grown in this file alone, and all of them have to stay in
// step with tmux's own layout or the leak checks are testing nothing.
export function tmuxSocketUnder(tmuxTmpDir) {
  return join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 0}`, "default");
}

// Todo 375, counselors round 2 (F6). isolateTmux registers its OWN socket and
// nothing else, so a file that starts a server on a SECOND, bespoke
// TMUX_TMPDIR - four of them do - is invisible to the run-level leak check
// unless it says so. Call this with that socket at CREATION time, for the
// same reason isolateTmux does: a file killed before its handlers run leaves
// a server nothing in that process will ever report.
//
// Registering a socket whose server never starts is harmless and expected:
// the checker probes it, tmux answers "error connecting to", and it reads
// gone like any other clean socket.
export function recordScratchTmuxSocket(socket) {
  if (!LEAK_MANIFEST) return;
  try {
    appendFileSync(LEAK_MANIFEST, `${socket}\n`);
  } catch {
    // A manifest that cannot be written must never fail a test run.
  }
}

export function isolateTmux(suite) {
  const tmuxTmp = mkdtempSync(join(tmpdir(), "hive-tmux-"));
  process.env.TMUX_TMPDIR = tmuxTmp;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  // The socket this file's own server will live on, derived exactly the way
  // the exit handler below derives it (and src/tmux.ts's socketUnder does).
  const socket = tmuxSocketUnder(tmuxTmp);

  // Todo 375 item 3. Recorded at CREATION, not at teardown, and that is the
  // whole point: a test file killed before its handlers run (node does NOT
  // run process.on("exit") under a default-disposition SIGTERM - measured on
  // todo 375 comment 899) leaves a server nothing in this process will ever
  // report. The run-level check (scripts/tmux-leaks.mjs) reads this manifest
  // after every file has exited and asks each socket directly.
  //
  // Absent env var means a bare `node --test` rather than `npm test`, where
  // there is no run-level check to feed; that stays silent rather than
  // failing, since a single-file run is a legitimate thing to do.
  //
  // LEAK_MANIFEST (inside recordScratchTmuxSocket), not process.env, for the
  // reason its own comment at the top of this file gives: clearHiveEnv()
  // deletes the variable, so reading it here made coverage depend on the
  // order two helpers happen to be called in. One O_APPEND write of one short
  // line, which is why many test processes can share the file without a lock.
  recordScratchTmuxSocket(socket);

  let hasTmux = true;
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
  } catch {
    hasTmux = false;
  }
  // CI installs tmux, so a skip there means the workflow lost that step and
  // these tests are quietly covering nothing. Fail instead of skipping.
  if (!hasTmux && process.env.CI) {
    throw new Error(`tmux is missing on CI; ${suite} cannot run. Restore the install step in ci.yml.`);
  }

  process.on("exit", () => {
    // Todo 294. cleanup() only ever reaches a session BY NAME, so any session
    // a describe created but never threaded through to a cleanup(...) call -
    // a forgotten argument, a name computed from stale env, a code path
    // nobody tracked - outlives the file. `new-session -d` on a cold socket
    // forks a server that setsid()s into its own session, detached from this
    // process tree entirely; nothing here dies with a parent, and `ps` still
    // shows the ORIGINAL new-session argv forever since fork() carries it
    // forward with no exec. rmSync below then deletes the directory backing
    // that server's own listening socket out from under it, and the server -
    // still alive, just now unreachable by any new client - never gets asked
    // to exit again. This is a leak of the SERVER, not of a stuck client.
    //
    // -S names the socket FILE directly, mirroring src/tmux.ts's own
    // socketUnder() (same join shape, same process.getuid?.() ?? 0 fallback).
    // A first version of this used TMUX_TMPDIR: tmuxTmp in the child's env
    // instead, and counselors caught the real hazard in it: TMUX_TMPDIR
    // names a DIRECTORY tmux must be able to REACH, not a pinned server -
    // tmuxSocketPath()'s own fallback rule (src/tmux.ts, DEFAULT_TMUX_TMPDIR
    // = "/tmp", pinned live by test/server-store-mismatch.test.mjs) means
    // that if tmuxTmp is ever unreachable when this runs, an env-based call
    // resolves silently to the SHARED socket instead of erroring - a bare
    // kill-server there takes down every lead and worker on the machine.
    // Stripping TMUX does not close that; only naming the socket file
    // directly does, since -S has no fallback to fall back TO - a missing
    // file is just ENOENT, caught below like any other absent server.
    // Named before killed: reports which SESSIONS this file left running,
    // not just an anonymous pid a separate sweep discovers after the fact.
    try {
      // stdio must be explicit: execFileSync's own default sends a failing
      // child's stderr straight to THIS process's stderr (unlike spawn's
      // default), so an ordinary "no server on this socket" answer would
      // otherwise print into every suite run's own output as noise.
      const left = execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (left) {
        console.error(`${suite}: left tmux session(s) behind on its own private socket: ${left.split("\n").join(", ")}`);
        process.exitCode = 1;
      }
    } catch {
      // No server ever started on this socket, or it is already gone: nothing leaked.
    }

    // timeout is part of this call, not a nicety: execFileSync defaults to
    // no timeout, so a wedged server would block this exit handler forever.
    // node --test has already printed its green summary by then, so the job
    // would hang silently to its CI timeout with no diagnostic pointing here.
    try {
      execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
    } catch {
      // No server was ever started on this socket, or it is already gone, or
      // it is wedged and the bound above gave up on it - which the survivor
      // check immediately below is what tells apart.
    }

    // Todo 375 item 3. DID THE KILL ACTUALLY WORK? The bound on the call
    // above means it can now return having achieved nothing, against exactly
    // the wedged server this whole todo is about, and an unverified kill
    // reads identical to a successful one.
    //
    // Written out here rather than calling scripts/tmux-leaks.mjs's
    // probeScratchSocket, which classifies the identical three outcomes: this
    // check and the run-level one are two independent nets over the same
    // failure, and a shared probe is one bug away from blinding both at once.
    // The duplication is ten lines; the independence is the whole point of
    // having two.
    //
    // IT SETTLES BEFORE IT BELIEVES A SURVIVOR, and the number is MEASURED,
    // not guessed: `kill-server` returns before the server has finished
    // exiting, and the server keeps answering for a few milliseconds after
    // that. Timed 20 times against a real tmux 3.7b, one and two sessions
    // deep: 4.9ms min, 5.3ms median, 5.8ms max. The probe below is the very
    // next fork after the kill, which lands right on that boundary - so the
    // first version of this check was a coin flip per test file and reported
    // a healthy file (auto-attach-scope) as a leak on the first full run. A
    // leak detector that cries wolf gets deleted, so a first "still
    // answering" only earns a 250ms settle (43x the measured window) and one
    // more look.
    // GATED ON THE SOCKET FILE, which is the one part of this that does not
    // go through PATH. test/auto-attach-scope.test.mjs installs a FAKE tmux
    // for its whole module and never restores PATH, so every call in this
    // handler resolves to a binary that answers a fixture: the fake exits 0
    // for `list-sessions` and the first version of this check read that as a
    // surviving server on a file that cannot create one. A file whose socket
    // was never created has nothing to verify. It also cannot hide a real
    // leak - the run-level check (scripts/tmux-leaks.mjs) probes the same
    // socket later, from a process with a normal PATH.
    //
    // SKIPS THE CHECK, NEVER THE CLEANUP. An early `return` here was the first
    // shape and it was a leak regression shipped by a leak lane (PR gate, fix
    // round 1): the rmSync below used to be unconditional, and every file that
    // calls isolateTmux() without ever starting a server on its own socket -
    // required of every hive-reaching file by test/CLAUDE.md, and common,
    // test/wire-surface.test.mjs among them - then leaked its scratch
    // directory on every run. The gate was right; the return was not.
    // THE PROBE TAXONOMY, the second of the two copies (the other is
    // scripts/tmux-leaks.mjs, where the same four states are written out in
    // full with the measurements behind them). Measured against tmux 3.7b:
    // exit 0 with a session list means a live server; "no server running on
    // <path>" means tmux ANSWERED that the socket file outlived its server,
    // which is the ordinary state after a successful kill-server since it
    // does NOT unlink the file; "error connecting to <path>" covers both an
    // absent socket file and a path that is not a socket. Those are the only
    // answers that prove nothing is there.
    //
    // ANYTHING ELSE IS UNKNOWN, NOT GONE (counselors round 2, F5). This
    // handler DELETES THE SOCKET DIRECTORY on "gone", so reading a failure to
    // SPAWN as an answer is the destructive direction: under the process/fd
    // exhaustion this whole detector exists to catch, kill-server fails, the
    // probe fails with EAGAIN, and the directory backing a live server's
    // listening socket gets removed - which is exactly how todo 294's leaks
    // became unreachable forever, manufactured this time out of an unknown
    // result. An unknown keeps the directory and says so, the same way a
    // wedged one already did.
    const answeredNoServer = /no server running|error connecting to/;
    const settle = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const stillThere = () => {
      try {
        execFileSync("tmux", ["-S", socket, "list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          timeout: 2000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return "is still answering";
      } catch (e) {
        // A wedged server is believed on the FIRST reading: it did not answer
        // within two seconds, which no amount of settling explains away.
        if (e?.code === "ETIMEDOUT") return "did not answer (wedged)";
        // No tmux binary: nothing tmux manages can be alive, and a file with
        // no tmux never started a server. Same call this handler's own
        // kill-server just made, same conclusion src/tmux.ts draws from
        // ENOENT.
        if (e?.code === "ENOENT") return null;
        const stderr = (typeof e?.stderr === "string" ? e.stderr : e?.stderr?.toString() ?? "").trim();
        if (answeredNoServer.test(stderr)) return null;
        return `could not be probed (${stderr || e?.code || e?.message})`;
      }
    };
    let survivor = existsSync(socket) ? stillThere() : null;
    // One settle-and-retry for both inconclusive readings. "Still answering"
    // is usually the measured 5.8ms shutdown window below; an unknown is
    // usually transient too, and a detector that cries wolf gets deleted.
    // Neither is believed until a second look agrees.
    if (survivor !== null && survivor !== "did not answer (wedged)") {
      settle();
      survivor = stillThere();
    }
    if (survivor) {
      // The directory STAYS. Removing it deletes the socket file backing the
      // survivor's own listening socket, which is what made todo 294's leaks
      // unreachable forever: alive, holding ptys, and impossible to name.
      // Leaving it costs one scratch directory and keeps the server reapable
      // by hand and visible to `hive doctor`'s orphan report.
      console.error(
        `${suite}: its tmux server ${survivor} after kill-server. Nothing has said it is gone, so ${tmuxTmp} ` +
          `stays in place and it remains reachable: tmux -S ${socket} kill-server`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      rmSync(tmuxTmp, { recursive: true, force: true });
    } catch {
      // A scratch dir left in the system temp dir is not worth a failed run.
    }
  });

  // Todo 375, and this is the call site that produced the incident's own
  // spinners: two `tmux kill-session -t =hive-<hash>-main` processes at 99%
  // CPU for 1h33m and 1h08m, each started seconds after the `new-session` it
  // targets. A teardown racing its own server, then never returning.
  //
  // THE ASYMMETRY IS THE DEFECT. The exit handler ONE LINE ABOVE has carried
  // `timeout: 5000` and SIGKILL, with a comment explaining that a wedged
  // server would otherwise block forever, since todo 294. The reasoning was
  // written down one line away and this loop did not get it: a fix applied to
  // some call sites, which is this project's most repeated defect shape.
  //
  // Matching that neighbour is worth more than picking a new number, and no
  // measurement is owed here the way it is for src/tmux.ts's bound: a
  // teardown has no legitimate slow case to protect. SIGKILL for the same
  // reason it uses one - a wedged tmux is the process least likely to act on
  // a SIGTERM.
  const cleanup = (...sessions) => {
    for (const session of sessions) {
      try {
        execFileSync("tmux", ["kill-session", "-t", `=${session}`], {
          stdio: "ignore",
          timeout: 5000,
          killSignal: "SIGKILL",
        });
      } catch {
        // Never started, or already gone, or wedged and killed by the bound
        // above. All three mean the same thing to a teardown: stop waiting.
      }
    }
  };
  return { hasTmux, cleanup };
}

// Todo 375. A SECOND scratch tmux server, on its own socket, for the two
// files that test hive's answers ABOUT orphaned and leaked servers
// (test/orphan-tmux-servers.test.mjs, test/tmux-leak-check.test.mjs).
// isolateTmux() only ever makes the file's own, and both files had grown a
// byte-identical copy of this - including the socket-path derivation, which
// has to stay in step with src/tmux.ts's socketUnder() for either file to be
// testing anything at all.
//
// Returns { socket, dir, reap }. `reap` kills the SESSION rather than the
// server: test/suite-isolation.test.mjs forbids that other verb by name in
// any test file (and counts this file's single exempted use), and tmux's own
// `exit-empty on` takes the server down with its last session anyway.
export function scratchTmuxServer({ prefix = "hive-tmux-", session = "orphan", ageHours = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // realpathSync because macOS's os.tmpdir() is a symlink (/var ->
  // /private/var) and hive reports canonical paths. Resolved with node's own
  // realpath rather than by asking the code under test, which would only
  // prove it agrees with itself.
  //
  // tmux does NOT create the parent of a `-S` path - measured: it prints
  // "error creating <path>" and exits 0 doing it - so the uid directory tmux
  // would make for itself under TMUX_TMPDIR has to be made here.
  const socket = tmuxSocketUnder(realpathSync(dir));
  mkdirSync(dirname(socket), { recursive: true });
  // A real second server on a real socket: it belongs in the run-level leak
  // manifest exactly as much as a file's own does (counselors round 2, F6).
  recordScratchTmuxSocket(socket);
  execFileSync("tmux", ["-S", socket, "new-session", "-d", "-s", session, "sleep", "300"], {
    stdio: "ignore",
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  // Backdating the socket rather than adding a testing-only env knob for
  // doctor's age floor: the floor reads the socket file's own mtime, so a
  // real file with a real old timestamp exercises the production
  // configuration instead of a second code path only tests take.
  if (ageHours > 0) {
    const when = new Date(Date.now() - ageHours * 3_600_000);
    utimesSync(socket, when, when);
  }
  const reap = () => {
    try {
      execFileSync("tmux", ["-S", socket, "kill-session", "-t", `=${session}`], {
        stdio: "ignore",
        timeout: 5000,
        killSignal: "SIGKILL",
      });
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { socket, dir, reap };
}

// A `tmux` on PATH that never answers, which is what a wedged server looks
// like from a caller's side. The sibling of probe.test.mjs's own
// fakeTmuxFailing scaffold ("one scaffold shared by every fixture, rather
// than a hand-copied heredoc per fixture") for the case where the call has to
// HANG rather than fail.
//
// `exec sleep` rather than `sleep`: the shim then IS the process
// execFileSync kills, so the SIGKILL that enforces a timeout reaps it instead
// of leaving an orphaned sleep behind for the rest of the run.
// `hangOn` narrows it to ONE subcommand and passes everything else through to
// the real tmux, the same shape probe.test.mjs's fakeTmuxFailing uses. Needed
// because a shim that hangs on EVERY call also hangs `tmux -V`, which
// src/cli.ts deliberately leaves unbounded (it is answered client-side and
// never reaches a server), so a doctor run against the blanket version waits
// out the fake's own sleep before it gets anywhere near the read under test.
// `log` names a file the shim appends each call's SUBCOMMAND to, one per
// line, before it decides whether to hang. Counselors round 2 (F2): a test
// that only asserts the TYPE of the error a wedged server produces cannot
// tell which call produced it, because every bounded call against this shim
// throws the same TmuxTimeoutError. Counting the calls is what tells "the
// probe threw and stopped the sequence" from "the probe was flattened into a
// false and the NEXT call threw".
export function fakeHangingTmux({ hangOn, log } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-hangingtmux-"));
  // Before the hang, or a hanging call would never be recorded - and the
  // hanging call is the one under test.
  const record = log ? `printf '%s\\n' "$1" >> ${JSON.stringify(log)}\n` : "";
  const body = hangOn
    ? `#!/bin/sh\n${record}if [ "$1" = "${hangOn}" ]; then exec sleep 30; fi\nexec ${execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()} "$@"\n`
    : `#!/bin/sh\n${record}exec sleep 30\n`;
  writeFileSync(join(dir, "tmux"), body, { mode: 0o755 });
  return dir;
}

// A `tmux` on PATH that FAILS one subcommand with stderr hive's classifier
// does not recognise, and passes everything else through to the real one.
// Counselors round 2 (F3): a timeout is the likeliest unanswered call and not
// the only one - EACCES spawning tmux, ENOBUFS, a transient socket error all
// arrive as an ordinary TmuxError whose text matches nothing, and a predicate
// written as "not a timeout" reads every one of them as an ANSWER. This is
// how a test constructs that class without needing to exhaust a machine's
// file descriptors.
//
// `stderr` deliberately defaults to a wording NOTHING_THERE (src/tmux.ts)
// cannot match: the whole point is an error that is neither a timeout nor a
// recognised "there is nothing there".
// `failOn` narrows it to one subcommand, the way fakeHangingTmux's `hangOn`
// does; omitted, EVERY call fails, which is what a machine that cannot fork
// looks like from a caller's side.
export function fakeFailingTmux({ failOn, stderr = "tmux: operation not permitted" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-failingtmux-"));
  const fail = `printf '%s\\n' ${JSON.stringify(stderr)} >&2; exit 1`;
  const body = failOn
    ? `#!/bin/sh\nif [ "$1" = "${failOn}" ]; then ${fail}; fi\n` +
      `exec ${execFileSync("which", ["tmux"], { encoding: "utf8" }).trim()} "$@"\n`
    : `#!/bin/sh\n${fail}\n`;
  writeFileSync(join(dir, "tmux"), body, { mode: 0o755 });
  return dir;
}

// Todo 275 (topology-3c). tmux(), windowOwners(), panesIn() and windowFor()
// were copy-pasted byte-identical into roughly nine test files (four predate
// lane 3; 3a/3b/3c added the rest) as the topology tests grew. Extracted
// here, deferred until now deliberately: doing it during 3b would have meant
// doing it again for 3c's own copies.
//
// THE ONE RULE THAT MAKES THIS SAFE, and it is not optional: these must keep
// doing their OWN RAW TMUX QUERY and must NEVER call findProjectWindow(),
// sessionName(), or any other dist/ function to answer the identical
// question. The moment a test helper answers a question by asking the code
// under test, every test using it only proves the code agrees with itself -
// this project has written that false-green shape up twice already
// (dead-ends/2026-08-05-test-hygiene-lane-that-dissolved.md, and
// .claude/rules/tmux-and-panes.md's note on test/tmux-socket-foreign.test.mjs
// asserting a function agrees with a second call to itself rather than an
// independent derivation). It looks redundant next to `import { findProjectWindow } from "../dist/tmux.js"`
// sitting right above it in most of these files - it is not; that import is
// for driving the code under test, this is for checking its work.
// Bounded on the same terms as cleanup() above (todo 375). This one is shared
// by roughly nine test files, so it is the second-largest concentration of
// raw tmux calls in the suite after the per-file ones, and an assertion that
// hangs forever against a wedged server reads as a hung TEST FILE with
// nothing pointing at tmux - which is exactly how the 2026-08-11 incident
// presented (two files alive 16m45s and 16m after their runs had moved on).
// 5000 is 32x the slowest legitimate call measured for src/tmux.ts's own
// bound, which is ample for a query this makes against a server the test just
// created.
//
// HONEST SCOPE: this does NOT bound the suite's own per-file raw calls, of
// which there are ~190 across 37 files. Bounding those is a mechanical sweep
// with its own review, and the two sites here are the ones every file
// inherits.
export function tmux(...args) {
  return execFileSync("tmux", args, { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" }).replace(/\n$/, "");
}

// #{@hive-project-id} read at WINDOW scope via list-windows -F, not through a
// pane and not via show-options. Measured live against a real tmux (not just
// pad 71's own M7): a window-scope query of a window-scope value agrees with
// or without -A, so none appears below. -A only matters descending FROM
// window scope INTO a pane-scope query, which this never does.
export function windowOwners(session) {
  return tmux("list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{@hive-project-id}")
    .split("\n")
    .map((row) => row.split("\t"));
}

export function panesIn(target) {
  return tmux("list-panes", "-t", target, "-F", "#{pane_id}").split("\n").filter(Boolean);
}

// One field of one PANE, read straight from tmux. `-t <pane>` lists every pane
// in that pane's WINDOW, not just the one asked for, which is the same trap
// targetLiveProbe documents - so #{pane_id} leads the format and picks the row
// out, rather than trusting tmux's ordering. Never `list-panes -a`, which
// ignores -t entirely (test/CLAUDE.md).
export function paneField(pane, field) {
  return tmux("list-panes", "-t", pane, "-F", `#{pane_id}\t${field}`)
    .split("\n")
    .map((row) => row.split("\t"))
    .find(([id]) => id === pane)?.[1];
}

// Asserts rather than indexing blind: a missing window is a real, nameable
// finding (which project, which owners actually exist), not a TypeError that
// buries it. A caller that wants to observe the STORE's own account of what
// happened under a broken lookup (a row's tmux_target, not a window) should
// read that first and call this after, so a window-lookup failure never
// hides a more direct signal behind an unrelated crash.
export function windowFor(session, projectId) {
  const owners = windowOwners(session);
  const match = owners.find(([, id]) => id === String(projectId));
  assert.ok(match, `expected a window stamped for project ${projectId}, got: ${JSON.stringify(owners)}`);
  return match[0];
}

// Minimal MCP stdio client. Requests are sent sequentially; the server
// handles piped requests concurrently, so callers must await each call.
export class McpClient {
  constructor({ cwd, dataDir, env = {} }) {
    this.child = spawn("node", [SERVER], {
      cwd,
      env: {
        ...baseEnv(),
        HIVE_DATA_DIR: dataDir,
        HIVE_AUTO_ATTACH: "0",
        ...env,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();
    // setEncoding makes Node decode with a StringDecoder that carries partial
    // multibyte sequences across `data` events. Without it, `chunk` is a
    // Buffer and `buffer += chunk` implicitly calls chunk.toString("utf8")
    // PER CHUNK - a UTF-8 sequence that straddles two events gets decoded as
    // two incomplete halves, each independently replaced with U+FFFD.
    // Counselors round 2, item 6: caught by name and line. NOT REPRODUCED
    // EMPIRICALLY - eight runs with this line reverted still passed, because
    // the payload fixture's multibyte characters never landed on a chunk
    // boundary on that machine. The fix rests on inspection, which is solid
    // (decoding each chunk independently is provably wrong for a split
    // sequence), but the test does not currently demonstrate it and would not
    // fail if this line were removed. Said plainly so nobody reads the
    // non-ASCII in that fixture as proof it is covered.
    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  send(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (id ${id})`));
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hive-test", version: "0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  // Calls a tool and parses the JSON receipt. Tool-level failures throw
  // with the error text so tests can assert on messages.
  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(msg.error.message);
    const text = msg.result?.content?.[0]?.text ?? "";
    if (msg.result?.isError) throw new Error(text);
    return text ? JSON.parse(text) : null;
  }

  async close() {
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000).unref());
    await Promise.race([exited, timeout]);
    if (this.child.exitCode == null) this.child.kill("SIGKILL");
  }
}

// A receipt is not proof of a worker. A pane whose command exits immediately
// still returns a tmux_target, so a spawn test that trusts the receipt passes
// while nothing is running. Read the row back and require it alive.
export async function liveAgentRow(mcp, name) {
  const row = (await mcp.call("agent_list")).agents.find((a) => a.name === name);
  assert.ok(row?.alive, `worker "${name}" should be running, got ${JSON.stringify(row)}`);
  return row;
}

export function runCli(args, opts = {}) {
  return runNode(CLI, args, opts);
}

// Issue #43, counselors review on PR #47 (test/doctor-profile.test.mjs's own
// non-negotiable rule, also in test/CLAUDE.md): never assert `hive doctor`'s
// global exit code. A machine missing an optional binary (claude, on a CI
// runner that installs only node and tmux) makes doctor correctly FAIL and
// exit 1 - the product is right, and an absolute exit-code assertion is not
// portable across machines. Compare the FAILURE COUNT the summary line
// carries, relative to a baseline run on the SAME machine, instead. Shared
// here after a second file (test/lead-doctor-liveness.test.mjs) needed the
// identical pattern - issue #27's L4 fix round R7, todo 171, the same
// mistake reintroduced on the same command four commits later.
export const summaryLine = (stdout) => stdout.trim().split("\n").pop();
export const failureCount = (stdout) => {
  const m = summaryLine(stdout).match(/^(\d+) problem/);
  return m ? Number(m[1]) : 0;
};
// The other half of the same line, since todo 292 put the warn count on it.
// Compare THIS across two runs, never the whole summary line: the line now
// moves when either count moves, so a test claiming "X is not counted as a
// problem" has to read the problem count specifically or it fails on a warn
// it never cared about.
export const warningCount = (stdout) => {
  const m = summaryLine(stdout).match(/(\d+) warning\(s\)/);
  return m ? Number(m[1]) : 0;
};
// How many of those warnings --strict turned into problems. Present only on a
// --strict run, and 0 there is a real answer rather than a missing field: it
// is what a run whose warns are all non-gating says, and it is the number that
// makes "this flag can still exit 0" checkable without touching an exit code.
export const promotedCount = (stdout) => {
  const m = summaryLine(stdout).match(/(\d+) promoted by --strict/);
  return m ? Number(m[1]) : 0;
};

// node defaults to whatever the suite is running under. Pass another
// interpreter to test what happens when hive is run by one it was not built
// for; everything else about the call stays identical.
// stdin: a string to write to the child, for an entry point that reads fd 0
// (dist/hook.js takes its Claude Code payload that way). Opened as a pipe only
// when asked, so every existing caller keeps the "ignore" it relies on.
export function runNode(script, args, { cwd, dataDir, tmp, env = {}, node = "node", stdin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(node, [script, ...args], {
      cwd,
      env: {
        ...baseEnv(),
        HIVE_DATA_DIR: dataDir,
        HIVE_AUTO_ATTACH: "0",
        HIVE_EDITOR: "true",
        ...(tmp ? { TMPDIR: tmp } : {}),
        ...env,
      },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// An interpreter whose ABI differs from the one that built the addon, i.e.
// the one this suite runs under. Nothing guarantees a machine has a second
// Node installed, so a caller that needs one should skip with a reason rather
// than pass quietly when this returns null.
export function alternateInterpreter() {
  const candidates = [
    process.env.HIVE_TEST_ALT_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ].filter((c) => c && existsSync(c));
  for (const candidate of candidates) {
    try {
      const modules = execFileSync(candidate, ["-p", "process.versions.modules"], { encoding: "utf8" }).trim();
      if (modules !== process.versions.modules) return { path: candidate, modules };
    } catch {
      // Not a working interpreter; try the next.
    }
  }
  return null;
}

// Issue #105 lane B. better-sqlite3 13's prebuilds are N-API, so the real,
// currently-installed addon loads under any Node major on darwin/linux/win32
// x64/arm64 (measured: the same file opened a database under NODE_MODULE_VERSION
// 137 and 147) - alternateInterpreter() can no longer make it mismatch.
// test/fixtures/native-addon-abi/ carries better-sqlite3 12.11.1's classic,
// NODE_MODULE_VERSION-locked build for the two ABIs this project's own CI
// matrix runs (Node 22 = 127, Node 24 = 137), for the two platform/arch pairs
// CI runs on. See that directory's README for provenance.
//
// matches: true asks for the fixture that loads under `against` (stands in
// for "the addon", so a test can still assert the healthy path); false asks
// for one that never does. against defaults to the interpreter running this
// process, but a test driving a SECOND interpreter (alternateInterpreter())
// needs a fixture relative to THAT one specifically - CLASSIC_ADDON_ABIS has
// two values, so "differs from the current process" does not guarantee
// "differs from some other, unrelated interpreter" too. Both return null
// when this machine's platform/arch or ABI is not in the fixture set, so a
// caller skips honestly instead of asserting nothing.
const CLASSIC_ADDON_ABIS = [127, 137];
export function classicAddonFixture({ matches, against = process.versions.modules }) {
  const target = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "linux-x64"].includes(target)) return null;
  const running = Number(against);
  const abi = matches
    ? CLASSIC_ADDON_ABIS.find((a) => a === running)
    : CLASSIC_ADDON_ABIS.find((a) => a !== running);
  if (abi === undefined) return null;
  return join(REPO, "test", "fixtures", "native-addon-abi", `${target}-abi${abi}.node`);
}

// A scratch checkout that can run the real dist/cli.js (or dist/kickoff.js)
// with its OWN, independently controlled better-sqlite3 addon, so a test can
// make guardAbi() see "missing" or "present but wrong ABI" without touching
// the real, working node_modules other tests in this suite run against
// concurrently. Symlinking every real package except better-sqlite3 keeps
// this cheap (dist is the only real copy, a few hundred KB) while still
// resolving zod/yaml/the SDK/everything else exactly as the real checkout
// does. better-sqlite3 itself needs a real copy of package.json and lib/ -
// checkAbi() only touches the addon file directly, but db.ts's static
// `import Database from "better-sqlite3"` walks the package's own JS before
// guardAbi() ever runs, and that has to resolve to something real.
//
// prebuild: a path to a .node file to install as this platform/arch's addon
// (typically one of classicAddonFixture()'s), or omitted to leave the addon
// missing entirely.
//
// layout: where the addon goes. "prebuilds" (default) is v13's shipped
// layout; "debug" is build/Debug/better_sqlite3.node, which
// better-sqlite3/lib/binding.js tries BEFORE build/Release and which
// addonPath() (src/abi.ts) once did not look in at all. Only meaningful
// alongside a working prebuild, since the point is a tree that really loads.
//
// napiVersion: the Node-API level the scratch better-sqlite3 DECLARES, via
// the binding.gyp that requiredNodeApi() (src/abi.ts) reads. Omitted, the
// real package's binding.gyp is copied so the scratch tree matches reality.
// Set it above anything Node provides and the Node-API guard must refuse,
// under any interpreter, on any machine - which is the only way to exercise
// that guard without keeping a sub-floor Node installed everywhere the suite
// runs. Note which variable that moves: the ADDON is the real, working one,
// so a test using this has a genuine control - delete the guard and the
// command succeeds.
//
// classic: install test/fixtures/native-addon-abi/classic-package/ (better-
// sqlite3 12.11.1's own lib/, plus the bindings + file-uri-to-path it needs
// to locate the addon - the exact dependency this repo's git history shows
// were resolved before issue #105 lane B) instead of v13's lib/. Only
// checkAbi() runs against a "matches: false" scratch addon, and it requires
// the addon file directly - never through better-sqlite3's own JS - so
// v13's lib/ paired with a classic .node file is fine there. Anything that
// goes on to open a real Database needs the JS and the native binary talking
// the SAME major's calling convention (v13's lib/binding.js calls addon
// methods v12's binary does not export at all: swapping only the .node file
// under v13's lib/ throws "addon.initialize is not a function" the moment a
// query runs), so kickoff-reexec.test.mjs, which needs a "matches" fixture
// to actually work end to end, passes this.
export function writeScratchAddon(root, { prebuild, classic = false, napiVersion, layout = "prebuilds" } = {}) {
  cpSync(DIST, join(root, "dist"), { recursive: true });
  const scratchModules = join(root, "node_modules");
  mkdirSync(scratchModules, { recursive: true });
  const realModules = join(REPO, "node_modules");
  for (const entry of readdirSync(realModules)) {
    if (entry === "better-sqlite3") continue;
    symlinkSync(join(realModules, entry), join(scratchModules, entry));
  }
  symlinkSync(join(REPO, "profiles"), join(root, "profiles"));
  // A real copy, not a symlink: claude-plugin/kickoff.mjs's own header
  // explains that node realpaths a symlinked MAIN entry script before
  // setting import.meta.url, which would resolve its "../dist/abi.js" import
  // straight through to the REAL dist/ and defeat this whole scratch tree.
  // Small (~20K), so copying is cheap.
  cpSync(join(REPO, "claude-plugin"), join(root, "claude-plugin"), { recursive: true });

  const scratchAddon = join(scratchModules, "better-sqlite3");
  mkdirSync(scratchAddon, { recursive: true });
  if (classic) {
    const classicPkg = join(REPO, "test", "fixtures", "native-addon-abi", "classic-package");
    copyFileSync(join(classicPkg, "package.json"), join(scratchAddon, "package.json"));
    cpSync(join(classicPkg, "lib"), join(scratchAddon, "lib"), { recursive: true });
    // Fixture files live under vendor/, not node_modules/: .gitignore's
    // node_modules/ pattern matches ANY directory with that name, anywhere
    // in the tree, so a fixture actually named that way is silently
    // untracked. Placed into a real node_modules/ here, in the scratch tree
    // only, which is exactly where database.js's own `require('bindings')`
    // needs to find it.
    for (const dep of readdirSync(join(classicPkg, "vendor"))) {
      // rmSync FIRST. The loop above symlinked every real node_modules entry
      // except better-sqlite3 into this directory, so if a future dependency
      // reintroduces `bindings` or `file-uri-to-path` to the lock - both
      // dropped out when 13 stopped needing them - this destination is a
      // SYMLINK POINTING AT THE REAL node_modules.
      //
      // Measured rather than assumed, in both directions, because "a test
      // suite might write into the real node_modules" would be the alarming
      // version of this and it is not what happens: cpSync onto a symlinked
      // directory throws ERR_FS_CP_DIR_TO_NON_DIR and touches the target not
      // at all. So this line buys a confusing failure NOT happening, not a
      // corrupted checkout - and rmSync unlinks the symlink rather than
      // following it, which is the half that would have been alarming if it
      // went the other way. One line, and the question stops being one.
      const dest = join(scratchModules, dep);
      rmSync(dest, { recursive: true, force: true });
      cpSync(join(classicPkg, "vendor", dep), dest, { recursive: true });
    }
    if (prebuild) {
      mkdirSync(join(scratchAddon, "build", "Release"), { recursive: true });
      copyFileSync(prebuild, join(scratchAddon, "build", "Release", "better_sqlite3.node"));
    }
  } else {
    copyFileSync(join(realModules, "better-sqlite3", "package.json"), join(scratchAddon, "package.json"));
    cpSync(join(realModules, "better-sqlite3", "lib"), join(scratchAddon, "lib"), { recursive: true });
    // Only the one line requiredNodeApi() reads, so a scratch tree declaring
    // NAPI_VERSION=99 is a one-variable change against the real package.
    const realGyp = readFileSync(join(realModules, "better-sqlite3", "binding.gyp"), "utf8");
    writeFileSync(
      join(scratchAddon, "binding.gyp"),
      napiVersion === undefined ? realGyp : realGyp.replace(/NAPI_VERSION=\d+/, `NAPI_VERSION=${napiVersion}`),
    );
    mkdirSync(join(scratchAddon, "prebuilds"), { recursive: true });
    if (prebuild && layout === "debug") {
      mkdirSync(join(scratchAddon, "build", "Debug"), { recursive: true });
      copyFileSync(prebuild, join(scratchAddon, "build", "Debug", "better_sqlite3.node"));
    } else if (prebuild) {
      copyFileSync(prebuild, join(scratchAddon, "prebuilds", `${process.platform}-${process.arch}.node`));
    }
  }

  return {
    dist: join(root, "dist"),
    cli: join(root, "dist", "cli.js"),
    kickoff: join(root, "dist", "kickoff.js"),
    kickoffMjs: join(root, "claude-plugin", "kickoff.mjs"),
  };
}

// git, usable in a throwaway scratch repo. -c commit.gpgsign=false plus a
// fake author/committer identity, so a suite run under a developer's own
// signing config (which may be locked) never blocks on a commit that exists
// only to give a scratch repo a branch to read. -c core.hooksPath=/dev/null
// neutralises a developer's own global hooksPath (husky, pre-commit): a
// hook failing inside `git commit` throws in the describe BODY, not inside
// a test, which takes down the whole file rather than one case.
export function scratchGit(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "gpg.format=openpgp", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    },
  );
}

// Parses a SessionStart hook's JSON stdout and returns hookSpecificOutput,
// asserting the envelope kickoff writes whenever it actually fires.
export function firedSessionStart(stdout) {
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  return payload.hookSpecificOutput;
}

// One row in agent_state_log, backdated by agoSeconds so a test can seed a
// sequence without waiting on the real clock. Takes an already-open `db`
// rather than opening its own: callers already picked their store via
// HIVE_DATA_DIR before importing dist/db.js, and this must not become a
// second way to choose one.
// Milliseconds, matching agent_state_log.created_at's own real format
// (src/db.ts: strftime('%Y-%m-%d %H:%M:%f', 'now')), not datetime('now')'s
// whole seconds - every existing caller here only reads minute-or-coarser
// ages off the result, so the extra precision changes nothing for them, but
// a caller testing an exact-timestamp comparison (issue #27's
// checkConfirmations) needs the real column shape, not a rounded stand-in.
//
// payload defaults to '{}', an UNRELATED row that carries no wake's marker -
// issue #27 counselors A1 made checkConfirmations() require the delivered
// `[hive wake #<id>...] ` prefix inside payload, so a caller that means to
// actually confirm a specific wake must pass wakeConfirmPayload(wakeId)
// below, not rely on time order alone.
export function insertStateLogRow(db, actorId, event, state, agoSeconds, payload = "{}") {
  db.prepare(
    "INSERT INTO agent_state_log (actor_id, event, state, payload, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now', ?))",
  ).run(actorId, event, state, payload, `-${agoSeconds} seconds`);
}

// Issue #72. Two real tmux panes for a test that needs to prove a dialog
// discriminator works against actual captured chrome, not a synthetic
// string: one ordinary pane (index 0 of a fresh session) and one replaying a
// real captured fixture (test/fixtures/panes/<fixtureFile>) via `cat` so
// paneChoiceCheck reads it exactly as it would a live claude pane showing
// the same screen. Extracted here because test/state-provenance-mcp.test.mjs
// and test/state-provenance-cli.test.mjs both needed this and were drifting
// toward two copies of the same ~15 lines, the exact class of duplication
// isolateTmux() itself was extracted to stop.
//
// `-P -F '#{pane_id}'` on new-window prints the new pane's own id back
// directly, so this needs no follow-up list-panes call (and never `-a`,
// which test/CLAUDE.md forbids: it ignores `-t` and would read the whole
// server, not this session).
//
// Fix round 1, item 8. `-x 300 -y 60`, matching typing-guards.test.mjs's own
// explicit geometry (which spends forty lines explaining why): with no
// explicit size this session inherits tmux's 24-row detached default against
// the measured 18-row threshold for folder-trust-dialog.txt -- six rows of
// margin that would go quiet if it ever shrinks (two tests fail loudly, but
// a doctor "never warns" test would go quietly vacuous instead, since it
// asserts an ABSENCE). The width also matters here specifically: a physical
// terminal wraps a long logical line into several short rows, which is not
// the same bound as sanitizeTail's per-line 160-char cap and can hide it
// entirely if a caller relies on this pane to prove that cap.
export function createLiveAndDialogPanes(session, fixtureFile) {
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "300", "-y", "60", "sleep 600"], { stdio: "ignore" });
  const livePane = execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")[0];
  const dialogPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      // Fix round 1, item 10 (ACCEPT AND RECORD). Single-quoting REPO's path
      // misquotes if a checkout ever lived under a path containing a single
      // quote, the same convention typing-guards.test.mjs, wake-delivery-
      // state.test.mjs, pane-fixtures.test.mjs and false-idle.test.mjs
      // already use (this helper extracted it, not invented it). Not
      // rewritten here: REPO is repo-controlled, not attacker-supplied, and
      // CLAUDE.md's execFileSync-with-argument-arrays invariant is about
      // what hive itself EXECUTES on a user's behalf, not this suite's own
      // fixture plumbing.
      `cat '${join(REPO, "test", "fixtures", "panes", fixtureFile)}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
  return { livePane, dialogPane };
}

// The minimum payload checkConfirmations() (src/scheduler.ts) will correlate
// to a given wake: a real UserPromptSubmit's "prompt" field carries the exact
// text hive typed, which always starts with deliver()'s `[hive wake #<id>] `
// prefix. Shaped as real JSON, not just a bare substring, so a test seeding
// this is exercising the same LIKE match a real hook-written payload does.
export function wakeConfirmPayload(wakeId) {
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: `[hive wake #${wakeId}] acknowledged` });
}

// The running kind='lead' row for a project, however it got there - a real
// `hive lead`, or seedLeadRow() below. No status filter: some callers want
// the most recent row regardless of state (see the comments at those call
// sites for why a status-filtered query would match the wrong one).
export function leadRow(db, projectId) {
  return db.prepare("SELECT * FROM agents WHERE project_id = ? AND kind = 'lead'").get(projectId);
}

// A standalone kind='lead' row, without going through `hive lead` or a real
// tmux pane - for tests of a generic agent_* tool's lead guard (agent_rename,
// wake_when_idle), where the guard itself is what's under test, not identity
// minting. tmux_target is a value nothing here will ever probe.
//
// socket defaults to '' (issue #73's "no fact recorded" case, matching every
// pre-migration row): pass this process's own tmuxSocketPath() or a foreign
// value for a test of the row-level liveness gate itself.
export function seedLeadRow(db, projectId, projectDir, socket = "") {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
       VALUES (?, 'lead:999', 'lead', '%not-a-real-pane', ?, 'claude', ?, 'lead', 'running')
       RETURNING id`,
    )
    .get(projectId, socket, projectDir).id;
}

// Change what a live worker's pane SHOWS, without hive concluding the worker
// was replaced. `respawn-pane -k` is the only lever that repaints a pane whose
// process is a bare `cat fixture; sleep 600`, and every dialog/input-box test
// here uses it for exactly that.
//
// IT GIVES THE PANE A NEW PROCESS, WHICH IS INDISTINGUISHABLE FROM A HIJACK.
// paneReissued (src/tmux.ts) compares the row's recorded pane_pid against the
// pane's current one, so after a respawn the janitor reaps the row and
// deliverable() holds the wake for pane-reissue - and the test then fails
// somewhere else entirely, asserting about a dialog that is no longer what
// the code is reacting to.
//
// This was invisible until todo 371 and the reason is worth knowing rather
// than patching around: these files all spawn with placement="window", and a
// window target made targetLiveProbe return pid null, so those rows carried
// pane_pid='' - "no fact recorded" - and the guard could not fire for them.
// The same respawn against a SPLIT-placed worker has always tripped it. So
// these fixtures were resting on the one placement that was accidentally
// exempt, not on a property of respawn-pane.
//
// Re-recording the pid says "this is still the same worker" and keeps each
// test about ITS OWN subject. It is a fixture repair, not an assertion: no
// test here is about pane identity, and the file that IS
// (test/lead-pane-reissued.test.mjs) does not use this.
export function repaintPaneAsSameWorker(db, target, command) {
  execFileSync("tmux", ["respawn-pane", "-k", "-t", target, command], { stdio: "ignore" });
  const pid = paneField(target, "#{pane_pid}");
  assert.ok(pid, `respawn-pane left no readable pid for ${target}`);
  // THE RE-RECORD IS NOT ATOMIC WITH THE RESPAWN, AND IT CANNOT BE (counselors,
  // opus seat). Every caller runs with a live MCP server whose scheduler ticks
  // every 3s, so a tick landing between the respawn above and the UPDATE below
  // sees a live pane whose pid no longer matches, fires paneReissued, and
  // closes the row - which is the guard behaving correctly against a fact that
  // is briefly true. respawn-pane has no -P -F, so the pid read is a second
  // fork that cannot be folded in.
  //
  // So this tolerates exactly that race rather than asserting through it: the
  // row is flipped back to running with the fresh pid, which is the state the
  // caller is entitled to assume. Written as one statement per outcome rather
  // than a retry loop, because there is nothing to retry - the reaped row is
  // deterministic and recoverable, not transient.
  // ONE UPDATE IS NOT ENOUGH AND THE FIRST FIX ROUND'S TWO-STATEMENT VERSION
  // WAS NOT EITHER (counselors round 2, all three seats). The sweep can read
  // the row BEFORE this write and close it AFTER: closeAgentRow's own CAS is
  // `WHERE id = ? AND status = 'running'` and carries no pid, so a pid this
  // statement has already corrected does not stop it. So the repair is applied
  // until it STICKS, over a window comfortably longer than the read-to-close
  // gap, rather than once.
  //
  // SCOPED TO THE REISSUE SIGNATURE, so it cannot quietly undo a close it was
  // not written for: only a row still carrying the pre-respawn pid is
  // reclaimed. A regression that made the janitor wrongly reap live workers
  // for some OTHER reason would leave a row whose pid this helper has already
  // corrected, and the assertion below fires instead of the test staying green
  // on a repaired store.
  const reclaim = db.prepare(
    "UPDATE agents SET pane_pid = ?, status = 'running', closed_at = NULL " +
      "WHERE tmux_target = ? AND (status = 'running' OR (status = 'closed' AND pane_pid != ?))",
  );
  const row = db.prepare("SELECT status, pane_pid FROM agents WHERE tmux_target = ?");
  const deadline = Date.now() + 2000;
  let stable = false;
  while (!stable) {
    assert.equal(reclaim.run(pid, target, pid).changes, 1, `no row naming ${target} to re-record a pid onto`);
    const now = row.get(target);
    stable = now.status === "running" && now.pane_pid === pid;
    if (!stable && Date.now() > deadline) {
      assert.fail(`row naming ${target} would not stay running with pid ${pid}: ${JSON.stringify(now)}`);
    }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for a condition instead of guessing how long it takes. A fixed sleep
// pays its full cost on every run and still flakes on a loaded CI, because the
// number that is comfortable locally is the ceiling everywhere. Polling exits
// on the first true and can afford a generous deadline, so it is both faster
// and more tolerant than the sleep it replaces. Returns whether the condition
// held, so a caller can assert on it rather than on a timeout.
export async function until(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(stepMs);
  }
}

// Set env vars for the duration of fn, then put back exactly what was there.
// undefined means DELETE the variable, which is the case the suite actually
// needs and the one a plain Object.assign restore gets wrong: assigning
// undefined to a process.env key stores the string "undefined" rather than
// unsetting it. Synchronous on purpose, so the restore cannot interleave with
// another test's env.
export function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Runs `scriptSource` (an ESM module body) in N real, separately-scheduled
// OS processes launched together, and returns each one's stdout parsed as
// JSON. Use this, not sequential calls on one connection, to test a
// check-then-act claim: two calls on one process cannot interleave, because
// the first always fully completes before the second's code runs at all,
// so a naive SELECT-then-UPDATE would pass a "call it twice" test just as
// well as a genuinely atomic UPDATE. Only real concurrent processes can
// reproduce the interleaving a race like that depends on.
//
// The script receives its own argv (after the script path) via `argv`, and
// should end by writing one JSON value to stdout. Absolute paths (e.g. to
// dist/*.js) are the caller's job: the script runs from a scratch tmp
// directory, not from test/, so relative imports would not resolve.
//
// Second counselors pass, C7: launching children "together" via Promise.all
// is not the same as forcing them to reach their critical operation at the
// same instant - Node's own startup cost (module resolution, native addon
// load) varies per process, so in principle every race test built on this
// could pass against an implementation it is meant to reject, if one child
// simply finished before the next one started. Empirically that was not
// happening - the pre-fix migrate(), takeSnapshot(), and hourly-claim
// implementations failed 10/10, 8/10, and reliably respectively when raced
// this way - which is evidence real OS scheduling gives enough jitter on its
// own, not proof it always will. A barrier makes it deterministic instead of
// lucky: every child writes a marker keyed by its own pid, then spins
// (synchronously - yielding here could let a fast child's own later code run
// before a slow peer has even started) until every expected marker exists,
// so all N reach `scriptSource` at close to the same instant regardless of
// how long each one took to get there.
export function raceProcesses(scriptSource, argvList, { env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hive-race-"));
  const barrierDir = join(dir, "barrier");
  mkdirSync(barrierDir, { recursive: true });
  const expected = argvList.length;
  const barrier = `
import { mkdirSync as __hiveBarrierMkdir, readdirSync as __hiveBarrierList, writeFileSync as __hiveBarrierWrite } from "node:fs";
__hiveBarrierMkdir(${JSON.stringify(barrierDir)}, { recursive: true });
__hiveBarrierWrite(${JSON.stringify(barrierDir)} + "/" + process.pid, "");
{
  const __hiveBarrierDeadline = Date.now() + 10000;
  while (__hiveBarrierList(${JSON.stringify(barrierDir)}).length < ${expected} && Date.now() < __hiveBarrierDeadline) {
    // Synchronous spin, deliberately: see raceProcesses' own comment in
    // test/helpers.mjs for why this must not yield.
  }
}
`;
  const script = join(dir, "race.mjs");
  writeFileSync(script, `${barrier}\n${scriptSource}`);
  return Promise.all(
    argvList.map(
      (argv) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [script, ...argv], {
            env: { ...baseEnv(), HIVE_AUTO_ATTACH: "0", ...env },
            stdio: ["ignore", "pipe", "inherit"],
          });
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.on("exit", (code) => {
            if (code !== 0) return reject(new Error(`race child exited ${code}, stdout: ${out}`));
            try {
              resolve(JSON.parse(out));
            } catch {
              reject(new Error(`race child produced non-JSON stdout: ${out}`));
            }
          });
        }),
    ),
  );
}

// Issue #83. The one parser for tool names registered via
// server.registerTool() across src/tools/*.ts, so test/tool-registration.
// test.mjs (every handler routes through run()) and test/docs.test.mjs
// (README's table matches what's registered) read the same list rather than
// keeping two copies of the same regex that could silently diverge. Grouped
// by file, with the file's own source text, so a per-file consistency check
// (registerTool( occurrences vs matched names) stays possible without a
// second read of the source.
export function toolRegistrationsByFile() {
  const dir = join(REPO, "src/tools");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "params.ts") // params.ts declares no tools
    .sort()
    .map((file) => {
      const src = readFileSync(join(dir, file), "utf8");
      const names = [...src.matchAll(/registerTool\(\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]);
      return { file, src, names };
    });
}

// Every registered tool name, flattened and sorted. A name this regex cannot
// see (a digit or hyphen in the literal) is invisible here too - a caller
// that needs to know the parse was complete should also compare
// registerTool( occurrences against names.length per file, the way
// tool-registration.test.mjs does, rather than trusting this list alone.
export function registeredToolNames() {
  return toolRegistrationsByFile()
    .flatMap((f) => f.names)
    .sort();
}

// ---------------------------------------------------------------------------
// A standing watch, its dead-paned owner, and the two matchers for reading
// what it filed. Extracted on todo 373, when test/spawn-false-finish.test.mjs
// arrived as a second file needing all five - the same reason
// createLiveAndDialogPanes above was extracted, one step more load-bearing.
//
// THE MATCHERS ENCODE THE NOTICE FORMAT, WHICH IS WHY A SECOND COPY IS WORSE
// THAN ORDINARY TEST DUPLICATION. Both files' headline assertions are
// SILENCE assertions ("this worker was not reported"), so a change to that
// format in src/scheduler.ts makes an out-of-date copy answer false for every
// worker and go vacuously green - test/CLAUDE.md's shape 1 and 5 at once,
// against exactly the tests written to catch a false finish. One copy cannot
// drift from itself.

// The wake's owner: a lead whose pane is in no snapshot these tests pass, so
// a filed notice is HELD by deliverable()'s lead-pane exemption rather than
// typed at a real terminal. Backdated because a standing watch only reports
// what happened after it existed. seedLeadRow above does not fit: it fixes
// one actor id (so two files sharing a store would collide) and writes no
// created_at.
export function seedDeadPaneLead(db, projectId, projectDir, actorId) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, created_at)
       VALUES (?, ?, 'lead', '%deadlead', 'claude', ?, 'lead', 'running', datetime('now', '-300 seconds'))
       RETURNING id`,
    )
    .get(projectId, actorId, projectDir).id;
}

// THE ONE PLACE THIS SQL LITERAL IS SPELLED FOR TEST PURPOSES. Two files
// reproduce resumeAgent's pre-pane failure by patching db.prepare to throw on
// upsertActor's own INSERT (src/spawn.ts), because that call sits inside the
// paneUp-guarded try and before placeAgentPane, and is the realistic failure
// there (SQLITE_BUSY under contention with a concurrent withWindowClaim
// holder). The literal has to track the source: if it stops matching, the
// patch never fires, resumeAgent SUCCEEDS against a real tmux fork, and the
// test looks exactly like a passing one. Both callers assert the throw for
// that reason; sharing the string means one place to update rather than two,
// and `grep UPSERT_ACTOR_SQL_PREFIX` finds every file that depends on it.
export const UPSERT_ACTOR_SQL_PREFIX = "INSERT INTO actors (id, name, kind)";

// A standing watch (wake_when_idle(scope: "project")) seeded directly rather
// than through the tool, so its owner can be the dead-paned lead above.
// watch='[]' with watch_scope='project' is what a standing watch really
// stores: its membership is a query, not a list (src/db.ts's watch_scope
// migration).
export function seedStandingWatch(db, projectId, owner, { pane = "%deadlead", body = "crew update" } = {}) {
  return db
    .prepare(
      `INSERT INTO timers (project_id, owner, body, kind, watch, watch_scope, deliver_actor, deliver_pane,
         max_wait_at, created_at)
       VALUES (?, ?, ?, 'idle_any', '[]', 'project', ?, ?, datetime('now', '+4 hours'),
         datetime('now', '-60 seconds')) RETURNING id`,
    )
    .get(projectId, owner, body, owner, pane).id;
}

export function standingNoticeBodies(db, watchId) {
  return db
    .prepare("SELECT body FROM timers WHERE parent_timer_id = ? ORDER BY id")
    .all(watchId)
    .map((r) => r.body);
}

// BOTH MATCHERS ARE ANCHORED, AND A BARE /name/ IS ALWAYS WRONG HERE. A
// standing watch's body has three parts: a reported block, one two-space
// indented line per worker ("  <name>: idle for ..." or "  <name>: GONE -
// ..."), then a one-line "Still going: a (...); b (...)" roster, then advice.
// A substring search matches the ROSTER too, so "is this worker being
// reported" and "is this worker merely alive and mentioned" become the same
// question. That is not hypothetical: it failed exactly that way under a full
// npm test, when the MCP server's own 3s scheduler filed a notice about an
// unrelated leftover worker and named the still-running subject in its roster.
//
// namedInReport: reported at all, finish or death. Use it for SILENCE
// assertions, where either would be a failure.
export function namedInStandingReport(db, watchId, name) {
  return standingNoticeBodies(db, watchId).some((body) => new RegExp(`^ {2}${name}:`, "m").test(body));
}

// reportedAsFinished: reported as a FINISH specifically. The GONE line shares
// the same prefix, so without excluding it a "the real finish was reported"
// assertion would also pass on an obituary - counselors flagged exactly this
// on issue #156 (opus F8), and the two mean opposite things to a lead.
export function reportedAsFinished(db, watchId, name) {
  return standingNoticeBodies(db, watchId).some((body) => new RegExp(`^ {2}${name}: (?!GONE)`, "m").test(body));
}
