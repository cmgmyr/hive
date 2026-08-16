# Attic: test/cli-registration-notice.test.mjs

Comments removed from `test/cli-registration-notice.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Todo 255. run()'s notice (src/result.ts, pinned by
// test/project-registration-notice.test.mjs) only covers the MCP tool layer.
// resolveProjectAndNotify (src/cli.ts) is the CLI's own equivalent - added in
// the same lane, but with no test behind it. The lead found the gap by
// mutation on the rebased head: deleting
// `if (notice) console.log(registrationNoticeText(notice));` left the suite
// fully green. This file is that missing test, driving the real built `hive`
// CLI (runCli, the same harness every other CLI test file uses - see
// test/profiles.test.mjs's `hive init`/`hive runbook` calls) rather than a
// helper, for the same reason test/project-registration-notice.test.mjs gives
// for the MCP half.
```

## line 22

```
// Anchored so the capture stops at end-of-line rather than swallowing later
// output, and scoped to a single captured line rather than testing the whole
// stream: `hive init` also prints "Project: name (path)" unconditionally
// (src/cli.ts's cmdInit), which already contains the project's path and
// would satisfy a path assertion made against the whole stream whether or
// not the notice exists at all. Matching only inside the notice's own
// captured line is what actually pins the notice, the same reasoning
// test/project-registration-notice.test.mjs applies by reading content[1]
// specifically instead of the whole content array.
```

## line 47

```
// The property this move exists for: `hive pad ... > out.md` from an
// unregistered directory must not put the notice into the redirected
// file. stdout still carries cmdInit's own "Project: ..." line, so this
// checks specifically for the notice's own text, not stdout in general.
//
// IMMUNE to generated data: stdout does carry dirs.projectDir (a scratch
// mkdtemp path), but the pattern is a multi-word literal with a colon and
// spaces. mkdtemp's random suffix is alnum-only, so no generated value in
// this stream can ever spell "hive: no registered project" by accident -
// this differs from the -CC case (test/attach-mode.test.mjs), where the
// colliding pattern was short enough to be drawn from the SAME alphabet
// as the random data.
```

## line 70

```
// A fresh process, the way a real second CLI invocation would be -
// resolveProjectAndNotify's flag is process-local, so this is the only
// way to prove the SECOND call does not repeat it.
```

## line 75

```
// IMMUNE for the same reason as the doesNotMatch above: the pattern is a
// multi-word literal with a colon and spaces, which no alnum-only
// generated value (dirs.projectDir, dirs.dataDir) can ever spell.
```
