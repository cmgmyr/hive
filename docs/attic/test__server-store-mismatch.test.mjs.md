# Attic: test/server-store-mismatch.test.mjs

Comments removed from `test/server-store-mismatch.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// Found 2026-07-29 during the #24 lane, by it happening to that lane's own
// worker: agent 40's row read "closed" while its pane was alive and working.
//
// A worker isolating tmux for a spike set TMUX_TMPDIR to a private dir and
// started a nested claude there. That claude inherited HIVE_DATA_DIR=~/.hive,
// started its own hive MCP server as every claude session does, and its janitor
// asked the PRIVATE tmux server about a pane that lives on the shared one. It
// got an authoritative "no such pane" and closed a live worker in the real
// store.
//
// This is not issue #14. There the probe FAILED. Here it SUCCEEDS and answers
// the wrong question correctly, so #14's "did tmux answer" distinction has
// nothing to catch. These tests pin the new refusal and, just as importantly,
// pin the boundary: legitimate isolation sets a private tmux AND a scratch
// store, and that has to keep working or the whole suite stops.
```

## line 48

```
// ONE cleanup for the file. cleanup() removes the shared socket dir as well
// as killing the sessions it is given, so a per-describe call pulls TMUX_TMPDIR
// out from under every describe still to run. That is not theoretical: it
// happened here first time out, and the later janitor tests started passing
// through the guard because TMUX_TMPDIR now named a directory that was gone,
// which is precisely the bug this commit fixes.
```

## line 78

```
// Reproduces the unsafe configuration: this process keeps its private tmux
// server (isolateTmux already set that up) and stops naming a scratch store.
//
// Safe to do here, and worth being explicit about why. dist/db.js opened the
// scratch store at import, above, and holds that handle in a module const, so
// unsetting the variable now cannot make any statement in this file reach the
// real store. The code under test never opens a store either: it compares a
// resolved path and returns. Restored immediately afterwards regardless.
```

## line 89

```
// A private socket named by an inherited TMUX. tmux writes
// "<socket>,<pid>,<session>" into every pane, and only the first field matters.
```

## line 95

```
// Every earlier version of this predicate answered a proxy question and was
// wrong in a new way each time. These pin the three inputs in tmux's own
// order of precedence.
```

## line 109

```
// /tmp is a symlink to /private/tmp on macOS. Naming the same directory by
// its real path is still the shared server, and reading it as private
// would refuse to sweep on an ordinary machine.
```

## line 125

```
// tmux does not create the directory, and handed one it cannot reach it
// uses its default socket. This is the ordinary end state of every isolated
// session: kill it, the scratch socket dir goes with it, and any shell
// still exporting the old value now names a path that is gone.
```

## line 133

```
// The pair, so the case above cannot be satisfied by always answering false.
```

## line 143

```
// THE HOLE THAT SHIPPED, and the reason this predicate now takes two
// arguments. Inside a pane tmux exports the socket it is on, and a tmux
// client started there talks to THAT socket regardless of TMUX_TMPDIR.
// Measured inside a real `tmux -L hivespike` pane, both halves.
//
// Blind: a -L server sets no TMUX_TMPDIR, so the old predicate read
// "shared" and the janitor closed live rows whose panes are elsewhere.
```

## line 155

```
// And refusing wrongly: a pane on the SHARED server with a stray
// TMUX_TMPDIR exported is still on the shared socket, so hive must not
// refuse to sweep it.
```

## line 178

```
// privateTmuxSocket is now built on a claim about tmux, so the claim gets a
// test rather than a comment. If a future tmux starts creating TMUX_TMPDIR,
// or starts erroring instead of falling back, this fails and says so
// directly instead of leaving hive quietly refusing to sweep.
//
// Everything here runs against this file's own isolated server. The one call
// made with a missing TMUX_TMPDIR reaches whatever the DEFAULT socket is,
// which on a developer machine is their real server, so it is a read that
// asserts only on the absence of this file's own session name. It never
// writes, and it never names a session it did not create.
```

## line 197

```
// This used to swallow every tmux error into listed = "" and then assert
// that the private session was absent, which is true of ANY failure. On a
// CI runner with no server on the default socket it was vacuous every run,
// and it pinned "not the private socket" while never pinning "the shared
// socket" -- which is the half privateTmuxSocket actually depends on.
//
// tmux names the socket it tried in its own failure text, so the fallback
// can be pinned positively without needing a server to exist. Both outcomes
// are asserted: either it listed sessions (a server is there) or it said it
// could not reach the DEFAULT socket. An arbitrary failure now fails.
```

## line 232

```
// The control. Without it the test above passes on a tmux that cannot find
// any server at all.
```

## line 246

```
// The reported configuration, exactly: private tmux, default store.
```

## line 251

```
// The boundary that decides whether this fix is usable at all. Every test
// in this repo runs on a private tmux server, and isolating tmux is the
// documented advice. Refusing on a private socket alone would break all of
// it while fixing nothing: the danger is the PAIRING with the shared
// store, not the isolation.
```

## line 261

```
// A human running hive normally sets no TMUX_TMPDIR at all. This must stay
// completely untouched.
```

## line 272

```
// The configuration the suite could not see. isolateTmux clears TMUX,
// which is exactly the variable that decides the socket in production, so
// every test here ran against an environment no real hive session has.
// Setting it back is the only way this branch gets exercised at all.
```

## line 287

```
// The other half, and the one that would break every real user: a normal
// hive session runs inside tmux on the shared socket.
```

## line 295

```
// null, not false. Everything downstream already treats unknown
// conservatively because issue #14 made it, so the whole refusal rides on
// plumbing that exists. Answering false would close every agent instead.
```

## line 310

```
// The lead's own reproduction against this file's isolated server, kept
// as a live check rather than a comment: fallbackSession (set up above)
// is still running at this point in the file, and an empty target
// silently answers with ITS pane rather than failing the way a dead
// target does. A future tmux that started erroring instead would fail
// this test, not targetLive('')'s below, which is the point of keeping
// both.
```

## line 322

```
// Same server, same live session as the test above - if targetLive
// reached tmux for an empty target the way it used to, this would come
// back true (or, off the default store, null), never false.
```

## line 334

```
// The control. Without this the refusal below could be satisfied by a
// janitor that never sweeps anything at all, which would be a worse bug
// than the one being fixed: stale rows pile up forever.
```

## line 347

```
// The regression pin, and the whole bug. These rows name panes on the
// shared tmux server. This process is talking to a private one, which will
// answer, correctly, that it has never heard of them. Believing it closed
// a live worker mid-lane.
```

## line 362

```
// The end-to-end version of the hole: TMUX names a -L socket, TMUX_TMPDIR
// is unset, the store is the default one. Before the predicate took TMUX
// into account this swept every row.
```

## line 396

```
// The write half. Refusing to READ liveness off a tmux server this store does
// not live on is only half a fix while the write path keeps putting that
// server's pane ids INTO the store: sessionName() returns the untagged
// hive-main for the default store, ensureSession creates a second one on the private
// server, and that server numbers panes from zero, so the row lands in the
// shared store naming a pane id that very likely exists there belonging to
// someone else. agent_send would type into it; agent_close would kill it.
```

## line 430

```
// The refusal sits ABOVE the INSERT on purpose. launchAgent puts the row
// first so a rejection never leaves a half-built pane; refusing after it
// would trade that for an orphan row instead.
```

## line 437

```
// The same shape as doctor's message. A refusal that says only "refused"
// sends someone hunting through source for which variable to change.
```

## line 448

```
// Was /agent_close would kill|kill/, whose second branch subsumes the
// first: any message containing "kill" passed, so the refusal could be
// reworded to name nothing and stay green.
```

## line 455

```
// launchAgent had its own gate, but cmdLead and cmdAttach call
// ensureSession directly, so the write half was not actually closed. Under
// the bad pair hive attach created a SECOND hive-1 on the private server
// and attached the user to an empty session while the real lead and its
// workers sat on the shared one.
//
// The refusal lives in ensureSession rather than at the two call sites,
// because that is the one function that creates a session on whatever
// server this process reaches.
```

## line 471

```
// The control for the gate above.
```

## line 480

```
// Never started, or already gone.
```

## line 486

```
// The control, and the whole reason the boundary matters. A gate that
// refused here would break every spawning test in the repo. Those tests are
// the distributed version of this assertion; this is the local one, so a
// reader does not have to take the rest of the suite on faith.
```

## line 496

```
// kill-session directly, NOT cleanup(): cleanup removes the shared socket
// dir along with the session, which is the trap documented at the top of
// this file and the one that already bit it once. Never kill-server.
```

## line 502

```
// Never started, or already gone.
```

## line 508

```
// NOT TESTED HERE, deliberately, rather than by oversight: doctor's branch that
// names this refusal instead of saying "re-run when tmux responds". Reaching it
// needs a hive process using the DEFAULT store, and guardStoreDir exits any
// process that tries under a test runner, so a spawned `hive doctor` dies
// before doctor's body runs. A test that asserted untrustedTmuxServer() again
// and called itself a doctor test would only be restating the block above.
```
