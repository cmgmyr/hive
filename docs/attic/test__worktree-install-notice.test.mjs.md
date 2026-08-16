# Attic: test/worktree-install-notice.test.mjs

Comments removed from `test/worktree-install-notice.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 406, option B only (see plan-406-worktree-backstop / pad 155 for the
// scope cut): agent_spawn's spawn-time backstop for a fresh git worktree
// that hive.yml declares an install command for. Detection only - nothing
// here ever runs vars.install; option A (a `hive worktree` verb that DOES)
// is a separate, larger decision and stays out of this lane.
```

## line 17

```
// db.js opens the store in its module body, so HIVE_DATA_DIR must be a
// scratch dir before the first import of anything that reaches it (both
// context.js and tools/agents.js do).
```

## line 37

```
// Not mkdtempSync'd - `git worktree add` requires the target not to exist.
```

## line 40

```
// THE LAYOUT THIS PROJECT ITSELF USES, AND THE CASE THE FIRST VERSION OF
// THIS PREDICATE GOT WRONG: a worktree cut INSIDE the primary checkout,
// at .claude/worktrees/<slug>, exactly like this project's own runbook.
// A version keyed on "is dir an ancestor-or-self of the primary root"
// (the sibling-comparison version this lane shipped first, then had to
// replace) reads this as an ordinary checkout, because the primary root
// genuinely IS an ancestor of a nested worktree too - that was the actual
// defect, reproduced here rather than only described.
```

## line 54

```
// MUTATION: dropping the `dirs.gitDir !== dirs.commonDir` comparison
// and returning `dirs !== null` alone flips this to true, since an
// ordinary checkout's git-dir and common-dir both resolve (to the same
// path, which is exactly what the dropped comparison was checking).
```

## line 70

```
// This is the case that must go red against the version this lane
// shipped first (49e77ea): that version compared dir's path against
// gitPrimaryRoot's answer, and the primary root IS an ancestor of a
// nested worktree, so it read every worktree this project actually
// creates as "not a worktree" and the notice never fired.
```

## line 79

```
// MUTATION: dropping the `dirs !== null &&` guard makes this line read
// `dirs.gitDir !== dirs.commonDir` unconditionally, which throws a
// TypeError on `dirs` being null rather than silently misclassifying -
// this call still fails the test, just via a throw instead of a wrong
// boolean.
```

## line 87

```
// COUNSELORS ROUND, FIX 3. Measured directly (see gitDirs's own comment):
// `git rev-parse` honours GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE over
// discovery-from-cwd when any is inherited from the calling process. Both
// directions are real and both are exercised here, not just one.
```

## line 105

```
// MUTATION: dropping the env-stripping in gitDirs makes this pass -
// measured live: `git -C primary rev-parse --git-dir --git-common-dir`
// with GIT_DIR set to the worktree's private gitdir prints the
// worktree's gitdir and the primary's commondir, gitDir !== commonDir,
// primary misreports as a linked worktree of itself.
// git names the admin dir under .git/worktrees/ after the worktree's
// OWN directory basename, not the branch name - measured live.
```

## line 119

```
// MUTATION: same as above, opposite direction - measured live: with
// GIT_DIR set to the primary checkout's own .git, both outputs come
// back identical regardless of cwd, so a genuine worktree misreports
// as an ordinary checkout.
```

## line 136

```
// A SECOND, genuinely unrelated repo - fix 2's shape: a linked worktree of
// THIS repo, so worktreeInstallNotice(worktreeOfOther, primary, ...) must
// say nothing even though `worktree` above would say something for the
// identical config, because the config belongs to `primary`, not to
// whatever repo cwd's own worktree is linked to.
```

## line 153

```
// MUTATION: dropping the linkedWorktreePrimaryRoot(cwd) check and
// returning `install` whenever it is declared fires this on EVERY spawn
// into the primary checkout too - exactly the noise the plan warns
// turns the notice into something a lead learns to skip.
```

## line 161

```
// MUTATION: reading a different field (e.g. config?.install instead of
// config?.vars?.install) makes this pass `undefined` through as a
// truthy-looking value or throws; either way this case stops meaning
// "declares nothing".
```

## line 172

```
// COUNSELORS ROUND, FIX 1 + FIX 4. codex measured `vars: {install: "   "}`
// shipping a present-but-blank receipt field, and separately measured that
// the earlier version's "install guard" mutation SURVIVED every existing
// test: an ABSENT key already reads `undefined` whether or not the guard
// exists, so nothing before this pinned the guard doing anything. These
// two cases are what actually depends on it - a value with characters that
// are all whitespace, or no characters at all - which the guard rejects
// and an absent key cannot distinguish it from.
```

## line 181

```
// MUTATION: removing `?.trim()` and the `if (!install)` guard entirely
// lets "   " flow through unchanged - `!"   "` is false in JS, so a
// bare truthiness check alone (the pre-fix-1 shape) already shipped this
// exact string as the receipt field.
```

## line 189

```
// MUTATION (codex's "drop install guard: SURVIVED"): removing the
// `if (!install) return undefined` guard lets "" flow through to the
// primaryRoot check and, for a genuinely linked worktree, come out the
// other side as the return value instead of undefined - unlike an
// ABSENT key, which reads undefined identically with or without the
// guard and so cannot catch its removal.
```

## line 205

```
// COUNSELORS ROUND, FIX 2. cwd is a genuine linked worktree - just not of
// `primary`, the project supplying `config`. Measured against a real
// fixture shaped like test/spawn-cwd-scope.test.mjs case (h): a linked
// worktree of an unrelated repo can resolve to a CONTAINING project for
// store purposes while its own files belong elsewhere; this asserts the
// notice does not attribute the containing project's install command to
// it.
```

## line 213

```
// MUTATION: comparing `findProjectForDir(cwd)` instead of
// `linkedWorktreePrimaryRoot(cwd)` against projectPath does NOT catch
// this - measured directly against case (h)'s own fixture shape
// (recorded on todo 406): findProjectForDir resolves a nested foreign
// worktree to the CONTAINING project by design (project-scoping.md's
// accepted containment residual), which is the same project supplying
// config here, so that comparison is true in exactly the case this test
// exists to catch.
```

## line 243

```
// sessionName() tags itself from HIVE_DATA_DIR read live at call time,
// not this process's own store (still pointed at unitRoot/data above,
// used only by the two describes that import dist/ modules directly)
// - it has to name the SPAWNED server's own store for cleanup to find
// the right session.
```

## line 295

```
// No hive.yml at all. project_add registers it deliberately, so the
// cross-project cwd guard (src/tools/agents.ts) is satisfied by
// project_id rather than by this test tripping over an unrelated
// refusal.
```

## line 311

```
// COUNSELORS ROUND, FIX 2, END TO END. The exact motivating shape: a
// linked worktree of an UNRELATED repo nested inside the spawning
// project's own directory tree, no project_id override - matching
// test/spawn-cwd-scope.test.mjs case (h)'s precondition
// (findProjectForDir resolves the nested foreign worktree to the
// CONTAINING project, dirs.projectDir here). Before fix 2 this printed
// dirs.projectDir's own `npm install && npm run build` for a cwd whose
// real files are a different repo entirely.
```
