# Attic: src/context.ts

Comments removed from `src/context.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 18

```
// Set ONLY by resolveHomeProject's registration fallback below, never inside
// addProject itself: project_add's MCP handler calls addProject() directly,
// never touching this flag, so it stays silent. `hive init` is NOT silent -
// it resolves through this same fallback via resolveProject/effectiveProjectId
// like every other CLI command, and src/cli.ts's resolveProjectAndNotify
// prints the notice there too; see that function's own comment.
//
// TWO KNOWN RESIDUALS, both accepted rather than fixed here.
//
// First: this flag is a module global, not scoped to the request that set
// it. CLAUDE.md already documents that MCP requests are handled concurrently
// ("drive dependent calls sequentially" in test/helpers.mjs's own header).
// selectedId's memoization means at most one call in a process's life ever
// reaches the branch that sets this flag, but if that call and a second,
// unrelated concurrent call are both in flight across an await boundary in
// run() (src/result.ts), the second call's read could in principle drain the
// notice before the call that produced it does, attaching it to the wrong
// receipt. Fixing this properly means binding the notice to the specific
// execution that produced it - AsyncLocalStorage keyed per tool call, or
// threading it through fn()'s own return value - which is a real change to
// the tool-call execution model, not a one-line fix, and out of scope for
// the lane that added this notice. Narrow window, once per process, at worst
// a misattributed notice rather than data loss or a wrong project id in the
// working receipt.
//
// Second: addProject (below) returns an EXISTING row when the resolved path
// is already registered, and this flag gets set to whatever addProject
// returns regardless of which branch it took. gitPrimaryRoot has a 2-second
// timeout (see its own comment); a call that times out on this attempt but
// would have succeeded on a retry, combined with a second call that races it
// and registers the git root itself in between, makes THIS call's own
// addProject return that now-existing row - and the notice then says
// "created" about a project this call merely found. Real and verified, but
// the trigger needs a stalled git command landing in exactly that window,
// and the cost is a false verb in a sentence naming a project that does
// exist and is correctly identified - project_prune still refuses to touch
// it once it owns rows, so the remedy this notice names stays honest either
// way.
```

## line 63

```
// Exported for src/tools/meta.ts's actor_prune: it derives its own liveness
// window from this rather than picking an unrelated round number, since this
// is the throttle that bounds how stale actors.last_seen_at can be for a
// session that keeps calling tools.
```

## line 69

```
// No actor_get, actor_list, or a soft-retire state for actors (issue #82).
// An agent-kind actor is already fully readable through agent_status and
// agent_list, addressed by the same id; a user or lead actor's id (user:name,
// lead:N) is already a readable string, so a lookup tool would name the same
// thing its argument already says. Retire is accepted for the same reason it
// is for projects: a stale actor row is something to remove, not archive;
// `actor_prune` (src/tools/meta.ts) is that Remove tool.
```

## line 78

```
// last_seen_at is advisory; avoid a write transaction on every tool call.
```

## line 108

```
// A plain SELECT first (the overwhelmingly common case: the project is
// already registered), falling back to INSERT ... ON CONFLICT DO NOTHING
// then SELECT only when that first read finds nothing - not
// SELECT-then-plain-INSERT. Two sessions resolving the same unseen checkout
// at once used to both find nothing and both plain-INSERT; the second hit
// projects.path's UNIQUE constraint and its whole call failed even though
// the project now exists. The race is still closed the same way: the
// fallback's ON CONFLICT DO NOTHING makes a loser's INSERT a no-op instead
// of an error, and the SELECT after it reads whichever row actually won -
// its own if it inserted, the other session's if it lost the race - so both
// callers converge on the same canonical row instead of one of them
// throwing. The fast SELECT above it is a pure optimization: it cannot
// itself observe a stale answer that matters, since a miss there always
// falls through to the race-safe path.
```

## line 138

```
// The single gate for reaching a project by id: it must exist, and a locked
// session may only touch its home project.
```

## line 157

```
// True when `path` names `root` itself, or a directory nested under it.
```

## line 172

```
// For a git checkout, the project is the repo root. For a linked worktree,
// --git-common-dir points into the PRIMARY checkout, so worktree sessions
// resolve to the same project as the main repo.
```

## line 181

```
// A cwd on a stalled network mount blocks `git` in the kernel, and a
// PATH-provided git shim can hang outright; on main this path never ran
// at all when a directly registered project matched. Both are now live
// failure modes for callers that are not once-per-process (hive
// statusline, the SessionStart hook), so this cannot be unbounded.
```

## line 189

```
// A genuine primary checkout's common dir is always exactly
// `<root>/.git` - basename ".git", nothing else. `endsWith(".git")`
// wrongly admitted two other real layouts whose common dir also happens
// to end in those four letters but names something that is NOT a
// checkout's own .git: `git init --separate-git-dir=X` points at an
// arbitrary path like `repository.git`, and a bare repo's common dir IS
// the bare repo itself, e.g. `proj.git`. Neither is a linked worktree,
// and dirname()-ing either lands on a directory that contains neither a
// working tree nor the checkout this function is meant to find - so
// reject them by requiring the exact basename instead of a suffix.
```

## line 206

```
// The one resolution rule: a directory belongs to the project whose root is
// its LONGEST registered prefix, unless its git primary root names a project
// that is strictly more specific than that prefix match (equal to it, or
// nested under it) - the linked-worktree case, where --git-common-dir points
// OUTSIDE the worktree's own ancestry into the primary checkout. When that
// happens the git-root project wins; otherwise the prefix match stands, even
// when it is null.
//
// Plain "prefer the longer path" is wrong here: comparing two projects' path
// lengths only means something when they sit on the same chain. For a linked
// worktree of repo Y sitting inside an unrelated registered project X,
// length alone compares by character count, which is arbitrary. Containment
// (is git's path the direct match's path, or under it?) decides the
// cross-tree case deliberately instead of by accident.
//
// THAT CROSS-TREE ANSWER WAS CHALLENGED AND IS ACCEPTED, NOT OVERLOOKED: a
// linked worktree of repo B sitting inside registered project A resolves to A.
// It was challenged on PR #64 as incorrect, since the files being edited are
// B's. It was rejected as a change there (identical to main, so the branch
// neither introduced nor worsened it) and then decided outright with Chris on
// 2026-08-02: ACCEPT, CHANGE NOTHING.
// Recorded here rather than only on a pad, because the next review pass will
// have the code and not the argument, and will otherwise rediscover it as a
// defect - which is exactly what happened the first time.
// The reasoning, so disagreeing with it means engaging with THIS: containment
// is the only principled tie-breaker available across trees, the obvious
// alternative is the length comparison ruled out in the paragraph above, and
// nobody has proposed a third rule that beats containment on principle. It has
// also never fired in this project: every worktree in use is of hive itself,
// where gitPrimaryRoot resolves to an ancestor and the answer is A regardless.
// THE HONEST RESIDUAL, and the only thing worth reopening on: this crossing is
// SILENT. The deliberate cross-project path refuses and makes the caller pass
// project_id (agent_spawn, src/tools/agents.ts); this one just picks. If a
// foreign worktree is ever nested inside a registered project here and writes
// to the wrong store, that is the trigger, and the fix is to SURFACE the
// crossing rather than to change what it resolves to.
//
// THIS WAS CLAIMED AS A NO-OP FOR EVERY ORDINARY CHECKOUT AND SUBDIRECTORY,
// AND THAT WAS FALSE: a `git init --separate-git-dir=X` checkout and a bare
// repo's linked worktree both produce a --git-common-dir that is NOT an
// ancestor of dir (it names X, or the bare repo itself), so gitPrimaryRoot
// used to resolve those to the wrong directory whenever a registered project
// happened to sit under it - a real regression from main, where `direct`
// always short-circuited first. The ancestry argument below was sound about
// its own premise (--git-common-dir ending in ".git" resolves to an
// ancestor); the premise was wrong, since a bare repo's or a separate git
// dir's common dir also ends in ".git" without being one.
//
// gitPrimaryRoot's basename check (exactly ".git", not merely ending in it)
// closes this: it now returns non-null ONLY for a genuine `<root>/.git`
// checkout layout, which is one of exactly two shapes - an ordinary
// checkout, where it resolves to an ANCESTOR of dir (verified: a
// subdirectory two levels into an ordinary checkout reports its
// grandparent's .git), or a linked worktree, where it resolves to the
// primary checkout. THAT PRIMARY CHECKOUT IS NOT ALWAYS A SIBLING - this
// sentence used to claim it always was, and that was measured false: a
// worktree cut INSIDE the primary checkout's own tree
// (.claude/worktrees/<lane-tag>-<slug>, this project's own layout) resolves
// to an ANCESTOR too, identical in that respect to an ordinary checkout. A
// sibling only for a worktree cut OUTSIDE the primary checkout. See
// isLinkedWorktree's own comment below, which exists precisely because this
// function's ancestor/sibling answer alone cannot tell a nested linked
// worktree from an ordinary subdirectory. A separate-git-dir checkout or a
// bare repo's worktree now gets null instead (verified against real repos
// of all four shapes), and null can never outrank `direct`.
//
// So the NO-OP claim is true again, but not for the reason this paragraph
// used to give - "ancestor of dir means ordinary checkout, non-ancestor
// means linked worktree" is false now that a NESTED linked worktree is also
// an ancestor case, indistinguishable from an ordinary checkout by this
// fact alone. What actually keeps the claim true is narrower: `direct` is
// already the LONGEST REGISTERED prefix of dir, and a nested worktree's own
// root is always reachable that way too - it is registered, and dir sits
// literally under it - so `hasStricterMatch` ordinarily finds nothing for
// it to change and this function is never even called for that shape, short-
// circuited above before this comment's ancestor/sibling answer matters at
// all. The shape that DOES reach here with a real effect on the outcome is
// a linked worktree cut OUTSIDE its own repo's registered path - the
// sibling case - because that is the one shape plain prefix matching cannot
// already resolve on its own. For the two shapes it now rejects, it returns
// null and cannot participate. The rule changes behaviour only for that
// sibling-cut linked worktree; a nested one reaches the same no-op outcome
// for a different reason - never being asked - not because this function
// answers it identically.
```

## line 291

```
// True when `dir` sits inside a linked git worktree rather than the primary
// checkout - the shape `git worktree add` leaves with none of the primary
// checkout's installed dependencies.
//
// AN EARLIER VERSION OF THIS FUNCTION REUSED gitPrimaryRoot AND WAS WRONG,
// MEASURED AGAINST THIS PROJECT'S OWN LAYOUT. It compared dir's path against
// gitPrimaryRoot's answer, on the premise (gitPrimaryRoot's own comment)
// that a linked worktree's primary root is always a SIBLING, never an
// ancestor. That premise holds only for a worktree cut OUTSIDE the primary
// checkout. This project's own runbook puts worktrees INSIDE it, at
// `.claude/worktrees/<lane-tag>-<slug>`, so the primary root IS an ancestor
// of the worktree dir there, and the sibling-based check read every one of
// this project's own worktrees as an ordinary checkout - the exact defect
// this function exists to fix, reproduced by the comparison rather than fixed
// by it.
//
// THIS VERSION ASKS GIT DIRECTLY, LAYOUT-INDEPENDENT BY CONSTRUCTION. `git
// rev-parse --git-dir` and `--git-common-dir` name the SAME directory for
// an ordinary checkout (or any subdirectory of one) and DIFFERENT ones for
// a linked worktree: git-dir is the worktree's own private
// `<primary>/.git/worktrees/<name>`, common-dir is always the primary
// checkout's real `<primary>/.git`. Git resolves both from `dir` by walking
// up its own tree, not from any assumption about where dir sits relative to
// the primary root, so this is correct whether the worktree is a sibling,
// nested inside the primary checkout, or several directories below either
// one. Verified live against this repo: from the primary checkout and from
// a subdirectory of it, both paths resolve to the identical `.git`; from
// this project's own nested worktree, they resolve to
// `<primary>/.git/worktrees/<name>` and `<primary>/.git` respectively.
//
// One git fork, same as the earlier version's reuse of gitPrimaryRoot, and
// deliberately NOT the same call: gitPrimaryRoot's `--git-common-dir`-only
// answer collapses exactly the distinction this function needs (nested vs.
// sibling), because it only ever returns the ROOT, discarding whether dir's
// own git-dir agreed with it. `--git-dir --git-common-dir` in one
// `rev-parse` invocation answers both questions, cheaper than two forks.
//
// Git-dir and common-dir are resolved FROM `dir` by
// git's own discovery only when nothing overrides it. GIT_DIR, GIT_COMMON_DIR
// and GIT_WORK_TREE are the three repository-SELECTION env vars - when any
// is inherited from the calling process, `rev-parse` honours it instead of
// discovering from cwd, which is exactly the "resolves both from dir" claim
// this function's own comment makes above. Measured: with GIT_DIR set, an
// ordinary checkout can read as linked and a real linked worktree can read
// as ordinary. Stripped from the child's env below - deliberately narrow to
// just these three; no attempt to sanitize every GIT_* variable, since these
// are the only ones that change WHICH repository is being asked about.
```

## line 339

```
// ACCEPTED RESIDUAL, not fixed: the `--git-dir --git-common-dir` argument order
// is unpinned by anything that reads THIS return value, because both call sites
// so far only ever compare gitDir and commonDir against each other or discard
// one - a symmetric `!==` and a same-position `out[1]`. Inert today. It stops
// being inert the moment any caller reads `.gitDir` for its VALUE rather than
// for the comparison; if you are that caller, verify which output line is which
// before trusting this object's field names.
```

## line 348

```
// Destructured out, deliberately unused, rather than spread-then-deleted.
```

## line 373

```
// The primary checkout's root when `dir` is a
// linked worktree of it, else null - built on the same gitDirs() call as
// isLinkedWorktree (common-dir's own directory name IS the primary
// checkout's root), so a caller that needs both facts pays for one fork,
// not two. This is what src/tools/agents.ts's worktreeInstallNotice
// compares against the SPAWNING project's own path: findProjectForDir(cwd)
// was the wrong tool for that comparison (project-scoping.md's own
// containment rule deliberately resolves a foreign worktree nested inside a
// registered project to the CONTAINING project, not the worktree's own repo
// - accepted there for STORE scoping, wrong here for naming an install
// command). This function answers a plainer question with no containment
// involved: which repository does dir's own worktree actually belong to.
```

## line 391

```
// Whether some registered project could possibly outrank `directPath`.
// gitPrimaryRoot can only change detectFromDir's answer by naming a project
// that is STRICTLY more specific than `direct` (equal doesn't change the
// outcome, it names the same project). If no registered project's path is
// strictly under directPath, no git-root match could ever qualify, so
// forking git to find out is pure cost with no way to change the result.
```

## line 402

```
// One fetch, shared by both prefix scans below - detectFromDir used to
// query listProjects() at most once per invocation (it returned as soon as
// the direct match hit), so querying twice here would double a DB read
// that was previously conditional.
```

## line 408

```
// Skip the git fork outright when it cannot possibly change the answer.
// findProjectForDir's callers are not once-per-process (hive statusline
// re-runs it on every render, the SessionStart hook runs it once per
// session, agent_spawn's cwd guard runs it per spawn), so a fork that used
// to be conditional on `direct` missing must stay conditional now too.
```

## line 428

```
// Non-registering lookup: resolves a directory to an already-registered
// project or null. Unlike effectiveProjectId, an unknown directory is never
// registered - callers on this path (agent_spawn's cwd guard, hive
// statusline) must never create a project row as a side effect of checking
// one.
```

## line 449

```
// A worker's spawner tells it which project it belongs to, not by an env var
// naming a bare id, but by a fact already recorded ON THE AGENTS ROW at spawn
// time (src/spawn.ts's launchAgent INSERT), looked up by actor_id - the same
// identity hive already trusts for hook writes (src/hook.ts) - and only for a
// session that also carries HIVE_PROJECT_LOCK=1 (see agentProjectPin's own
// comment for why that second check is load-bearing, not redundant).
// Consumed ahead of detectFromCwd: the whole point is that a cwd disagreeing
// with the brief must not silently win. Checked ahead of selectedId's
// *caller* (effectiveProjectId's override param) too, in the sense that
// project_select already routes through assertAccessible, which under
// HIVE_PROJECT_LOCK=1 can only ever select the home project anyway - so
// selectedId stays the first check without the pin needing to outrank it.
//
// Row-shaped, not env-shaped, because an env var naming a bare id can be
// validated for EXISTENCE but never for IDENTITY: issue #63 shipped an env
// pin first, and rebuilding (not restoring) the store reissues ids, so a
// stale HIVE_PROJECT_ID could name a getProject()-valid but DIFFERENT
// project while the loud check on existence passed. The agents row moves
// WITH the project across a restore and cannot be reissued out from under a
// running worker the way a bare id can.
//
// Three cases, and the difference between them is the whole design:
//   ROW RUNNING -> its project_id is the answer, guarded below by
//     projectPathGuard.
//   ROW CLOSED -> prefer cwd, but never let this fall through to
//     resolveHomeProject's registration fallback while HIVE_PROJECT_PATH
//     still names a real project (see the closed-row branch below for why).
//     This is what fixes a hole an env pin could never close: `tmux -e` env
//     is PANE-scoped and outlives the process launched in it, so a human who
//     later runs `claude` by hand in a pane a closed worker left behind must
//     not inherit that worker's project - on main this was always benign
//     (home came from cwd), and an env-only pin would have turned a harmless
//     leak into a wrong-project WRITE. A closed row is an affirmative "this
//     worker is finished", not an error, so it is not cached as one below.
//   ROW MISSING while HIVE_AGENT_ID and HIVE_PROJECT_LOCK are both set ->
//     fail loudly, naming the actor id. The store does not know this worker
//     (a rebuilt store, most likely); falling through to cwd here would
//     silently reintroduce this issue's own defect one level up.
// A missing-row or path-mismatch failure can never resolve on its own, so a
// worker stuck with one would otherwise re-run this DB lookup on every tool
// call for the rest of its life - resolveHomeProject is on that hot path.
// Caching the error means the query runs once per process, not once per
// call. The closed-row case needs no such cache: it does not throw, and
// resolveHomeProject's own selectedId memoizes whatever cwd resolves to
// right below it.
```

## line 496

```
// HIVE_PROJECT_PATH is a GUARD over the row lookup above, not a second
// source of truth: it catches a store swapped underneath a live worker,
// where the agents row survived the swap but now names a project at a
// different path than the one this process was actually spawned into.
// Compared realpath'd, since the row's own path is stored realpath'd
// (addProject) and a raw HIVE_PROJECT_PATH may not be.
```

## line 505

```
// FK-guaranteed: agents.project_id references projects(id) ON DELETE
// CASCADE, so a live agents row can never outlive its project.
```

## line 523

```
// Exported for the CLI (src/cli.ts's cmdStatusline/cmdTodos/cmdTodo): those
// commands resolve by cwd alone today (findProjectForCwd) and never register,
// so a locked worker's pane answered agent_spawn's own tools one way and
// these commands another - a NEW symptom of a pre-existing structural gap,
// now that the MCP path resolves from this pin instead of cwd. They must
// consult this SAME function, not re-derive their own version of it, or the
// two answers can drift again the next time this logic changes.
```

## line 532

```
// The pin applies to a session claiming BOTH an agent identity AND a
// project lock - exactly and only what launchAgent produces for
// kind="agent" - not to HIVE_AGENT_ID alone. HIVE_AGENT_ID is the
// documented manual-identity mechanism (docs/concepts.md's "Identity" section) that
// ANY session may claim without ever being spawned or getting a backing
// agents row; HIVE_PROJECT_LOCK=1 is what only a real spawned worker ever
// carries alongside it. Keying this on identity alone once broke that
// manual pattern outright (two unrelated existing tests simulating a
// second actor via a bare HIVE_AGENT_ID started failing loudly the moment
// they touched a project-scoped tool) - do not drop this second check as
// "redundant" with the identity check above it.
```

## line 545

```
// Issue #27. actor_id stopped being unique across agents ROWS once a lead row
// closed by someone else could have its actor_id inherited by the NEXT `hive
// lead`'s freshly INSERTed row (src/cli.ts's ensureLeadRow), so one actor_id
// can now legitimately name two rows, one closed and one running. A bare
// SELECT with no ORDER BY leaves SQLite free to return either - this query is
// unreachable for a lead today (a lead's env carries no HIVE_PROJECT_LOCK=1),
// but that is one lane away from mattering, not a guarantee this function can
// lean on. Prefer a RUNNING row over a CLOSED one when both exist, tie-broken
// by the most recent id; when only a closed row exists (the ordinary,
// single-row worker case this branch was written for), that is still exactly
// what falls out.
```

## line 562

```
// "Restart it" is not an escape hatch here: `tmux -e` env is PANE-scoped
// and outlives the process (the same fact the closed-row branch below is
// built on), so a plain restart in this pane re-inherits HIVE_AGENT_ID
// and HIVE_PROJECT_LOCK and fails identically forever. Name the env to
// clear, since that is the only way out of this pane specifically.
```

## line 573

```
// The janitor closes a running row on a PANE probe, not a process probe
// (tmux-and-panes.md documents it closing live workers), so a closed row
// does not mean this pane is actually done: the same process can still be
// running, or a human can have reused the pane verbatim. Prefer wherever
// this pane's cwd ACTUALLY is now, non-registering - that is the
// reused-pane property this branch exists for, and it wins first so a
// genuinely different, already-registered cwd is not shadowed by a stale
// path. Only when cwd resolves to nothing do we fall back to the project
// this pane's env still names: an unregistered cwd on a pane that still
// carries a worker's HIVE_PROJECT_PATH is at least as likely to be this
// false-closure case as a human's fresh unrelated repo, and silently
// registering a stray project for it is exactly the failure mode issue
// #63 exists to remove. If HIVE_PROJECT_PATH itself resolves to nothing
// (its directory is gone from disk; the project row survives, so this is
// not the FK-cascade case), fail loudly rather than let the caller fall
// through to resolveHomeProject's own registration fallback - "never
// register while HIVE_PROJECT_PATH is set" holds even here.
```

## line 616

```
// Never fall back to an unrelated project: state must stay scoped to the
// directory the session is working in. New projects register at the git
// primary root when there is one, so worktrees and subdirectories share
// the main checkout's project. This still agrees with detectFromDir's
// rule above: reaching this line means detectFromCwd found neither a
// direct prefix match NOR a registered project at the git root, so there
// is nothing already registered to prefer over the git root - registering
// there is the most specific project a first-time session can create.
```
