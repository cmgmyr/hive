# test/CLAUDE.md

Rules for this suite. They exist because each was broken once and cost real state: a live store's rows, a live worker mid-lane, and a running session typed into by a test. The repo root `CLAUDE.md` carries the product invariants; this file carries what keeps the tests from damaging the machine they run on.

## Isolation is enforced, not conventional

Two guards hold this up and both must stay.

- `storeDir()` refuses `~/.hive` outright when a test runner is the entry point, keyed on `NODE_TEST_CONTEXT`. That is an env var, so it crosses into every process the suite spawns, and a file that never sets `HIVE_DATA_DIR` fails loudly instead of writing to a live store. `db.ts` uses `guardStoreDir()`, which prints and exits rather than throwing, because a throw out of an ESM module body arrives as a stack trace with hive's sentence buried in it.
- `test/suite-isolation.test.mjs` reads the suite's own source and fails when a file that can reach tmux does not call `isolateTmux()` at module top level.

Neither can tell one scratch directory from another, so `assertScratchStore()` still earns its place in any file that runs DELETEs.

## What the guards do not cover

- **Call `isolateTmux()` at module TOP LEVEL.** Every hive command can reach the server, since `hive status` and `hive doctor` both run the janitor, so any file that spawns hive needs it.
- **Set BOTH halves.** A private `TMUX_TMPDIR` with the default store is worse than no isolation: the janitor probes the private server, gets a correct "no such pane" about panes that live on the shared one, and sweeps live agents. hive refuses that pair now, but a refusing hive is still one that cannot see its workers.
- **Never `list-panes -a`.** It lists every pane on the server and ignores `-t`, so `list-panes -a -s -t =mysession` reads as scoped and is not. Scope with `-s -t =<session>`. `suite-isolation.test.mjs` fails any use of it.
- **`isolateTmux()`'s `cleanup()` kills sessions only, and only by name.** The socket directory is removed once on process exit. It used to be removed per-`after()`, so a file with more than one tmux `describe` destroyed its own isolation halfway through: `TMUX_TMPDIR` went on naming a path that no longer existed, tmux does not create it, and every later `describe` silently created sessions on the developer's own server.
- **The exit handler kills the file's own tmux SERVER, and reports any session it had to reap.** Todo 294. Because `cleanup()` reaches a session only by name, anything never threaded through a `cleanup(...)` call used to outlive the file: `new-session -d` on a cold socket forks a server that `setsid()`s into its own session, `ps` keeps showing the original `new-session` argv forever (fork carries argv with no exec, so it reads as a stuck client and is not), and the `rmSync` below then deletes the directory backing that server's own listening socket. The server stayed alive and unreachable. One per full-suite run, 227 alive at one point, and a run eventually died with `fork failed: Device not configured`. The handler now runs `list-sessions` first and names anything left, setting `process.exitCode = 1` so the file that leaked is identified rather than an anonymous pid found later.
- **That `kill-server` MUST name its socket with `-S`, never select it through `TMUX_TMPDIR`.** `TMUX_TMPDIR` names a directory tmux has to be able to REACH, not a pinned server: when it is unreachable, `tmuxSocketPath()` falls back to `/tmp/tmux-<uid>/default`, the SHARED socket, and a bare `kill-server` there takes down every lead and worker on the machine. `src/tmux.ts` measures that fallback and `server-store-mismatch.test.mjs` pins it live. Stripping `TMUX` does not close it; `-S` does, because it has nothing to fall back to. Caught by counselors before it shipped.
- **Keep `dist/` imports inside functions.** A static import hoisted above the line that sets `HIVE_DATA_DIR` chooses the store for the whole file.
- **The tmux socket path caps near 104 bytes.** `<base>/tmux-<uid>/default` from a long scratch path fails with "File name too long", which reads like a bad command rather than a limit. `isolateTmux()` uses `mkdtemp` under `os.tmpdir()`, which clears it with about 20 bytes to spare.
- **`env -u TMUX` is not optional from a lead pane.** `TMUX` overrides `TMUX_TMPDIR` completely, so a one-off `TMUX_TMPDIR=... tmux ...` typed inside a pane hits the SHARED server while looking isolated.

## Write tests that can fail

For every test, say out loud what would have to be true for it to PASS while the behaviour it names is BROKEN. If you cannot answer, you have tested that the suite runs. Seven shapes have shipped green here:

1. **A dead alternation branch.** One branch of a regex had not existed since a rewording, so a two-way assertion pinned one branch by accident and still passed.
2. **A saturated comparison.** Comparing two exit codes proves nothing on a box already failing for an unrelated reason: both are 1. Compare something carrying a count. Never assert `hive doctor`'s global exit code.
3. **A fixture colliding with reality.** `/usr/local/bin/node` as the "some other interpreter" fixture is where nodejs.org's installer puts Node, so on such a machine the fixture IS `process.execPath` and the assertions invert silently.
4. **A fixture whose validity depends on the defect.** A regression test built on the bug's own payload can only exist while the bug does; fixing it makes the test meaningless rather than failing.
5. **A test asserting the OLD behaviour.** When you fix a bug, grep the suite for tests that assert what it used to do before assuming the suite is on your side.
6. **A fixture too small to reach the bound.** Every fixture in `todo-cli.test.mjs` seeded four todos against a limit of fifty, so no test in the file could reach the truncation path. A bound can only be tested by a fixture that exceeds it.
7. **An assertion satisfied by two indistinguishable causes.** Todo 294's own positive control asserted that querying a child's tmux socket THROWS after the child exits, to prove the exit handler had killed the server. That query also throws when the socket FILE is gone, which the unconditional `rmSync` on the next line always makes true. So it passed with the kill removed entirely, and would have passed on `main` before the fix existed. Found by mutating the fix and checking the mutation had applied: the first attempt used a substitution that silently did not match, and a green run from a mutation that never happened reads exactly like a pinned behaviour. Assert on the thing that actually differs, here the server's own pid via `process.kill(pid, 0)`.

Two more habits from the same lessons. Assert over the SEQUENCE in `agent_state_log`, never a sample of `agents.agent_state`, which is overwritten in place. And if a test depends on two real events differing in time, force the gap: two back-to-back `backupNow()` calls landed in the identical millisecond on this hardware.

## CI is the only thing that catches environment assumptions

Local green says nothing about anything environment-shaped. Before pushing a lane that touches paths, interpreters or installed binaries, run the suite with a PATH that lacks them.

## Fixtures

`test/fixtures/panes/` holds captured pane screens for the dialog and input-box discriminators, and `test/fixtures/hook-payloads/` holds real Claude Code hook payloads for the replay corpus. Both have their own README. The pane fixtures must keep the real-input control, not just the ghost cases, or the tests cannot fail in the direction that matters. The payload corpus is sourced by reading `agent_state_log` from a real store, never hand-written from documentation: a corpus can only preserve fields someone already knew mattered, which is the failure it exists to reduce.
