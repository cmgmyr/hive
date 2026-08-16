# Attic: test/spawn-cwd-scope.test.mjs

Comments removed from `test/spawn-cwd-scope.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Issue: agent_spawn resolves the worker's PROJECT from the spawner (or an
// explicit project_id) and never looks at args.cwd, but the worker itself
// resolves its own scope from its OWN cwd at runtime. A cwd naming another
// registered project's tree produces a worker whose brief names one project
// and whose actual scope is a different one (todo 136). The fix is a
// refusal, not a re-resolution: resolving the label from cwd would make
// agent_spawn a new cross-project write path. Most of this file's cases sit
// above launchAgent, before any tmux call, so they spawn no worker -
// isolateTmux is paired anyway per test/CLAUDE.md, since McpClient's server
// can reach tmux through other tools, and the allow-path case at the bottom
// genuinely does spawn one.
```

## line 20

```
// sessionName tags itself from HIVE_DATA_DIR at call time (read live, not at
// import), so it is safe to import here and call later once this process's
// HIVE_DATA_DIR is pointed at whichever scratch store actually spawned the
// session being cleaned up.
```

## line 27

```
// db.js opens the store in its module body (src/db.ts), so HIVE_DATA_DIR has
// to be a scratch dir before the first import of anything that reaches it.
// A sibling directory, not one of the project fixtures below: the store and
// the projects it tracks are different things, and mixing them would make
// the store's own directory look like a project's subdirectory by accident.
```

## line 38

```
// Shared by every case below that asserts on an error message: a path built
// by mkdtempSync's prefix argument literally contains that prefix, so
// matching a bare project name against the whole message can pass "by
// construction" even when the code stopped naming the project at all -
// counselors' T2. Escaping and anchoring the name next to its id is what
// makes the assertion mean something the path cannot also supply.
```

## line 60

```
// No .git here, so this exercises matchRegistered's prefix match rather
// than gitPrimaryRoot - the ordinary "worktree under the project root"
// case the pad calls out as the one that must not regress.
```

## line 72

```
// The defect this pins: matchRegistered(dir) used to return as soon as it
// hit, so a registered project that is a path ANCESTOR of dir shadowed
// gitPrimaryRoot outright. A linked worktree sitting outside its own repo
// checkout, but still under some broader registered project (e.g. a
// home-directory project), resolved to that broader ancestor instead of
// its own repo. These fixtures use a REAL linked git worktree - (b) above
// has no .git in it and stays green even if gitPrimaryRoot is deleted
// outright, which is why this defect survived a whole lane.
```

## line 88

```
// The worked example from the issue: the repo lives inside the ancestor's
// tree, and its linked worktree sits at a sibling path also inside the
// ancestor's tree but outside the repo checkout itself.
```

## line 97

```
// A subdirectory of the worktree, not just its top level - the shape a
// real session actually sits in, and untouched by every fixture until
// this one, all of which asserted only at a worktree's root.
```

## line 104

```
// Fails if the new git-preferred branch is taken NEVER (the old, buggy
// behaviour): matchRegistered(worktreeDir) hits the ancestor first and
// gitPrimaryRoot is never consulted, so this would return ancestor.id.
```

## line 111

```
// Control: a linked worktree of an UNRELATED repo (registered as its own
// project, but not nested under the ancestor at all) sitting inside the
// ancestor's tree resolves to the ancestor, not the unrelated repo. This is
// the cross-tree case the rule decides deliberately: the git-root project's
// path is neither equal to, nor nested under, the direct match's path, so
// containment says no and the direct match stands.
```

## line 124

```
// Fails if the new git-preferred branch is taken ALWAYS (ignoring
// containment): gitPrimaryRoot(wtInsideAncestor) resolves into
// unrelatedRepoDir, which is not under ancestorDir, so an unconditional
// git-wins rule would pick unrelatedRepo instead of the ancestor.
```

## line 129

```
// This case is supposed to kill a length-based "prefer longer path"
// rule too, but only does so as long as unrelatedRepoDir's path is
// longer than ancestorDir's - true today because "unrelated62-" is one
// character longer than "ancestor62-", by accident of naming, not by
// anything this test asserts. Pin the precondition so a rename that
// silently reverses the lengths fails loudly here instead of letting a
// length-based rule pass this case unnoticed.
```

## line 140

```
// Control: a `git init --separate-git-dir=X` checkout (not a worktree),
// not separately registered, living inside the ancestor's tree resolves to
// the ancestor unchanged - the no-op-for-ordinary-checkouts property
// asserted here rather than only argued in the code comment.
//
// This REPLACES an earlier version of this case that used a plain nested
// checkout with no --separate-git-dir. That version could not fail for
// ANY variant of the resolution rule: an ordinary checkout's git root is
// an ancestor of dir by construction, so the direct-match scan and the
// git-root scan land on the SAME registered project regardless of which
// one the rule prefers - false-green shape 7 (test/CLAUDE.md), and this
// repo's second time shipping it.
//
// The external gitdir is placed INSIDE a project registered UNDER the
// ancestor (decoyDir, not just anywhere unregistered) so that the OLD,
// buggy endsWith(".git") check produces a DIFFERENT, wrong, but still
// real answer rather than accidentally falling back to the right one: an
// external gitdir under an unregistered directory resolves to `null` and
// falls through to `direct` regardless of the basename check, which does
// not discriminate anything. Verified by hand before relying on it - see
// todo 142.
```

## line 171

```
// Fails under the old endsWith(".git") check (group B's regression pin):
// --git-common-dir here is externalGitDir, which ends in ".git" but is
// not sepGitDirCheckout's own .git and is not an ancestor of it. The
// pre-fix code would dirname() it to decoyDir - a DIFFERENT registered
// project nested under the ancestor, so the old containment check would
// accept it as "more specific" and wrongly return decoy.id instead of
// ancestor.id.
```

## line 182

```
// Control: a directory belonging to no registered project, even one with a
// git repo of its own, still returns null.
```

## line 191

```
// Control: the `!direct` half of detectFromDir's git-preference check.
// Every other case in this describe block has a non-null `direct` - (g),
// (h) and (i) all sit under the registered ancestor - except (j), where
// `direct` AND the git match are both null, so the disjunct is never
// actually reached. Deleting `!direct ||` and every other case here still
// passes; this is the only one that needs it: a repo's linked worktree
// placed somewhere NO project is registered at all, where `direct` is
// null but the git match is not.
```

## line 204

```
// Not mkdtempSync'd - `git worktree add` requires the target not to exist.
```

## line 245

```
// Asserted on the refusal itself, not only on what never happened
// downstream: launchAgent deletes its own agents row on a failed spawn,
// so "no agents row" alone is also true if the guard were removed
// entirely and the pane just failed to come up for an unrelated reason
// (counselors' P2-5). Naming both projects ties this failure to the
// guard specifically.
```

## line 257

```
// Non-registering, the load-bearing part: a guard that registers a new
// project as a side effect of checking one would create rows for every
// scratch directory anyone spawns into.
```

## line 261

```
// The refusal happens above launchAgent's INSERT: no half-built pane, no
// agents row, in either project.
```

## line 271

```
// A worker's project_id is not this session's to override: every worker
// runs with HIVE_PROJECT_LOCK=1 (src/spawn.ts), and assertAccessible
// refuses any project_id but the home one under it. Telling a locked
// caller to "pass project_id" would just trade one refusal for another
// (counselors' C2/P2-3).
```

## line 287

```
// Immune: err.message can carry generated mkdtemp path segments
// (see the escapeRegex/namedAs comment above for the class of bug
// that guards against), but "Pass project_id" is a fixed, capitalised,
// underscore-joined phrase no random alnum path fragment can spell.
```

## line 300

```
// Before issue #62's fix, a linked worktree outside its own repo but
// still under some broader registered project (here, the caller's own
// project A - dirs.projectDir) resolved to A, the SAME project as the
// caller, so agent_spawn allowed it: both sides agreed. After the fix,
// findProjectForDir(cwd) correctly resolves the worktree to the more
// specific nested repo project instead of A, so this spawn is now
// refused where it used to be allowed. That is correct under strict
// scoping (CLAUDE.md's first invariant), but it is a new user-facing
// failure this lane introduces, and nothing pinned it before this case:
// (d) and (e) both refuse on a directly registered path, never on a
// worktree.
```

## line 330

```
// Env-shaped pin, take one, validated only for EXISTENCE never IDENTITY:
// counselors broke it two ways (id reuse across a rebuilt store; a reused
// tmux pane inheriting a finished worker's project via pane-scoped `-e`
// env). The row lookup fixes both - see resolveHomeProject's own comment
// in src/context.ts for why each of the three cases below resolves the
// way it does.
//
// These simulate the worker side of a spawn directly: a real `agents` row
// inserted by hand (matching exactly what launchAgent's own INSERT
// produces), then a McpClient started with the env launchAgent's
// kind==="agent" branch builds (HIVE_AGENT_ID, HIVE_PROJECT_LOCK,
// optionally HIVE_PROJECT_PATH) - rather than a real tmux pane. This is
// the same store this file's top-level `db` already has open, so the
// insert and the worker's own lookup share one on-disk database exactly
// the way a real spawn and a real worker do. The actual env launchAgent
// constructs is covered separately below, by a test that inspects a real
// spawned process's environment.
```

## line 358

```
// Mirrors launchAgent's own INSERT (src/spawn.ts) closely enough to stand
// in for it: same table, same columns that matter here (project_id,
// actor_id, status).
```

## line 390

```
// The bug's signature is a new projects row, not a worker that merely
// "looks right" - assert the count, not just the write's destination.
```

## line 393

```
// And the write actually landed in the row's own project, not nowhere
// and not some other project silently registered for the unregistered
// cwd.
```

## line 400

```
// agentProjectPin's guard clause is `if (!actorId || lock !== "1")
// return null`, so this path never touches the agents table at all.
// This is what (m) would look like if the row lookup fired for every
// session rather than only ones with both HIVE_AGENT_ID and
// HIVE_PROJECT_LOCK set - the answer this file's own history already
// proved for the env-var version of this pin (issue #63's original
// reproduction): an unregistered cwd registers.
```

## line 422

```
// The documented manual-identity pattern ("Set identity through
// environment variables when starting a worker session:
// HIVE_AGENT_ID=worker-1 ... claude", documented in src/help.ts and
// docs/concepts.md) is unlocked and was never meant to carry a project
// pin - any session may claim an
// identity without ever going through agent_spawn. Two existing tests
// elsewhere in the suite (test/store.test.mjs's lease-conflict case,
// test/todo-cli.test.mjs's actor-attribution case) already exercise
// this pattern incidentally; this is the one that names the property
// deliberately, and it is the strongest form of the check: a row DOES
// exist and DOES name a project, so only the lock gate - not a missing
// row - can be what stops it from winning.
```

## line 440

```
// Deliberately no HIVE_PROJECT_LOCK.
```

## line 453

```
// Every OTHER bad-pin case in this describe sits in a fresh
// unregistered directory. An implementation that falls back to cwd
// whenever detectFromCwd() finds *anything* - not just on a genuinely
// closed row - would keep every one of those green while silently
// resolving here. This is the one case built specifically to catch
// that: the cwd is registered, so a fallback would succeed quietly
// instead of failing loudly.
```

## line 461

```
// never inserted - no matching row
```

## line 479

```
// (o) makes exactly one call. Rewriting the cache as `return null`
// (treating "already failed" the same as "unset") would leave that
// test green while a real worker's SECOND call fell through and
// registered its cwd - this calls the tool twice in the same worker and
// checks the project count only after both.
```

## line 507

```
// The defect the fix round exists to close: a bare id survives a
// rebuilt store's reissued ids and would silently "agree" with a row
// that now names a different project. HIVE_PROJECT_PATH is the guard
// that catches it - a forged/stale path naming a DIFFERENT project than
// the row actually resolves to, simulating a store swapped underneath a
// live worker where the row survived but now points somewhere else.
```

## line 537

```
// A DIFFERENT, freshly registered project as the cwd, so landing there
// (rather than in the closed row's own project, and rather than a
// thrown error) is unambiguous proof the closed row was ignored, not
// consulted and not fatal.
```

## line 558

```
// (q) proves the reused-pane property by landing in a DIFFERENT,
// already-registered cwd. This proves the other half: the janitor closes
// rows on a pane probe, not a process probe (tmux-and-panes.md), so the
// SAME worker can still be alive in its ORIGINAL unregistered cwd when
// its row goes closed underneath it. Falling through to (q)'s plain
// "closed -> cwd" rule here would hit resolveHomeProject's own
// registration fallback and re-create issue #63's own defect one level
// up - a stray project, and HIVE_PROJECT_LOCK then locking the worker to
// it. HIVE_PROJECT_PATH is exactly the fact that stops that: it still
// names the real project, unlike cwd.
```

## line 588

```
// Locks in the order inside the closed-row branch: cwd is checked BEFORE
// HIVE_PROJECT_PATH. If that order were reversed, a human reusing a
// closed worker's pane in a DIFFERENT, already-registered repo would land
// back in the closed worker's project whenever the stale
// HIVE_PROJECT_PATH happened to still be set - exactly the regression (q)
// exists to prevent, just with the path guard now also in play.
```

## line 614

```
// Neither half of (q2)'s fix can answer here: cwd is unregistered (same
// as (q2)) and the project's own directory is gone from disk (not the
// FK-cascade case - the row survives, only the path stopped resolving).
// "never register while HIVE_PROJECT_PATH is set" has to hold even when
// HIVE_PROJECT_PATH itself is stale, or this is a silent registration
// path with no test on it at all.
```

## line 663

```
// Answers "what fails if the pin is applied but the lock is dropped":
// were HIVE_PROJECT_LOCK not honoured alongside the row lookup, the
// first assertion below would see the other project's todo_list
// succeed instead of being refused.
```

## line 681

```
// The home project - the one its row names - is still reachable.
```

## line 693

```
// Unlike the describe above, this goes straight at launchAgent (real
// tmux, no MCP layer, and a REAL agents row from launchAgent's own
// INSERT rather than a hand-inserted one) and inspects a spawned
// process's ACTUAL environment, so it is the one test in this file that
// would catch a regression in spawn.ts's env-block ordering
// specifically - the row-lookup tests above cannot see it, since
// agent_spawn's own tool never lets a caller supply spec.env in the
// first place (it is always {}). This exercises launchAgent directly,
// the way a future caller with a non-empty spec.env would.
```

## line 723

```
// A caller trying to override the worker's own identity and scope -
// exactly what the ordering fix in spawn.ts (spec.env spreads
// FIRST) exists to stop. If that ordering regresses, this test
// reads these bogus values back out of the spawned process's real
// environment.
```

## line 750

```
// Immune: content is a real dumped process env, so it does carry
// generated scratch paths (HIVE_DATA_DIR, pinProject.path, etc.), but
// "forged-project-path-63" is a literal this test itself invented for
// the bogus override a few lines up - unique text nothing else in the
// suite could generate, so this can only fail if the override actually
// survived into the child's environment, which is the real regression.
```

## line 760

```
// The pane/window is created by respawn-pane/split-window/new-window,
// not by the tmux_target UPDATE that follows - by the time that UPDATE
// runs, a real process is already up with HIVE_AGENT_ID naming this
// row baked into its env. Deleting the row here (the pre-fix rollback)
// would strand a genuinely running worker whose own agentProjectPin()
// lookup then finds no row at all and fails loudly for its whole life.
// Simulates the SQLITE_BUSY class src/db.ts already retries for
// elsewhere by making the UPDATE throw directly - the class of the
// error is not what this test is about, only what launchAgent does
// with it once the pane is already live.
```

## line 774

```
// Todo 336 added pane_pid to this exact UPDATE (src/spawn.ts) - the
// string this test intercepts has to track that literal SQL, or the
// patch below silently stops matching and launchAgent just succeeds.
// IT DRIFTED EXACTLY THAT WAY, once, and the comment above is what
// caught it: issue #156 added `AND status = 'running'` to recordPane
// (counselors, all three seats - a row retired mid-spawn must not have
// a pane written onto it), the `===` stopped matching, and this test
// went from proving launchAgent's rollback behaviour to proving
// nothing. startsWith rather than a second full literal, so the next
// clause added to that WHERE does not silently disarm it again.
```

## line 830

```
// The ordinary case this whole guard exists not to break, and the one no
// other case in this file exercises: every case above spawns nothing (a
// refusal) or nothing at all (the resolver unit tests), so mutating the
// guard's condition to refuse EVERY explicit cwd left them all green
// while an everyday worktree spawn - the kind this project's own lanes
// run constantly - would break completely. This is the negative control
// for that (counselors' T1).
```

## line 849

```
// sessionName reads HIVE_DATA_DIR at call time; point it at this
// describe's own store just for this lookup so cleanup targets the
// session this describe actually created.
```
