# Attic: test/lead-notice-placement.test.mjs

Comments removed from `test/lead-notice-placement.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Lane A step 4 (plan-lane-a-cmdlead-characterisation, pad 73, HALF 2). The
// registration notice used to print at resolve time - the very first line of
// cmdLead, a second-plus and a dozen console.log lines before the attach
// that takes over the terminal and scrolls it away, invisible in practice.
// Now printed LAST, immediately before that attach (decisions/2026-08-05-
// cli-notices-go-to-stderr.md's sibling problem, not what that decision
// itself fixes). test/cli-registration-notice.test.mjs already pins the
// notice's TEXT and its stderr routing for the general case (`hive init`);
// this file pins WHEN `hive lead` specifically prints it.
//
// Review round 1 (F2/F3/F4) found the first version of this file measured
// nothing: it timestamped stdout/stderr `data` events in the PARENT process,
// but those are two independent OS pipes, and a parent-side timestamp
// records which pipe libuv happened to service first, not which console.*
// call the CHILD made first. Under the print-at-resolve-time mutation the
// child's own write order is still notice-then-marker, sub-millisecond
// apart; whichever pipe's callback fired first in the parent could go
// either way, and it measured to "notice after marker" with a 0.4ms margin
// - noise, not a measurement, and the mutation "passed" by luck rather than
// having been fixed. Rebuilt around a MERGED stream instead: the child's
// own shell redirects fd 2 into fd 1 before either byte leaves the process,
// so kernel write order in the one resulting stream really is program print
// order, and ordering is now a string-offset comparison, not a clock
// sample. The exactly-once check is also fixed: NOTICE_LINE is a non-global
// regexp, so `String.match` returned a single result whether the text
// occurred once or five times - `assert.equal(count, 1)` was asserting
// nothing beyond the existence check already above it.
```

## line 50

```
// A hive.yml with one auto_start:false process, and no `lead:` override, so
// this test's own fixture has a marker that fires LATE in cmdLead - right
// before the deferred print, after ensureLeadRow/the CAS/tmux setup - not
// only an early one. Load-bearing for what F3 actually needs: with no
// hive.yml at all, cmdLead prints exactly ONE line ("No hive.yml here...")
// before the notice and nothing else before attach's own ready line, so
// "the notice is the line immediately before ready" would hold true even
// under the F3 mutation (move the print right after that one early line) -
// nothing else prints in between either way, so that placement would be
// indistinguishable from the correct one. A process line that fires right
// before the true print position closes that: moving the print anywhere
// earlier than its correct spot leaves this line sitting between the
// notice and the ready line, and the immediately-before assertion catches
// it. auto_start:false means the loop logs this line and continues; it
// never calls ensureTrusted, so no trust prompt is needed.
```

## line 71

```
// A single merged stream, not two independent pipes: `2>&1` inside the
// child's OWN shell merges stdout and stderr at the kernel level before
// either reaches this process, so string position in the resulting buffer
// really is print order - unlike timestamping two separate `data` callbacks
// in the parent (see the file comment above).
```

## line 94

```
// close, not exit: node's own docs say a child's stdio streams may
// still be open when `exit` fires, so resolving there can drop a
// buffered chunk this test then asserts against.
```

## line 110

```
// dirs.projectDir is NEVER registered before this call - that is
// what triggers effectiveProjectId's silent-registration fallback
// and its notice, the same trigger test/cli-registration-notice
// .test.mjs uses for `hive init`.
```

## line 132

```
// attach()'s own first line, printed the instant it takes over -
// this harness's child has no TTY, so this is attach()'s
// unconditional no-TTY branch, not a guess about which one runs.
```

## line 139

```
// THE ASSERTION THIS BEHAVIOUR IS: not "somewhere before attach",
// but the line immediately preceding it - "last" is the whole
// decision (pad 73, HALF 2). THE MUTATION THIS FAILS AGAINST,
// THREE WAYS: (a) print at resolve time - the notice becomes the
// very first line, nowhere near readyIndex - 1; (b) delete the
// print entirely - readyIndex - 1 is LATE_MARKER, which does not
// match NOTICE_LINE; (c) move the print to immediately after the
// early "No hive.yml here" log (F3's required mutation) - this
// fixture has no such line (config exists), but the equivalent
// early placement leaves LATE_MARKER between the notice and
// readyLine, and lines[readyIndex - 1] is LATE_MARKER, not the
// notice, exactly as it would for any placement earlier than the
// true last-line position.
```

## line 159

```
// Exactly once. A global regexp, not NOTICE_LINE's own /m: F4
// found `String.match` with a non-global pattern returns a single
// result whether the text occurs once or five times, so the old
// count here asserted nothing the match above did not already.
```

## line 180

```
// A fresh, still-unregistered project dir - dirs.projectDir was
// already registered by the test above, in the same module-scoped
// store. PATH excludes tmux entirely, the cheap way to make
// ensureSession throw without needing a real absent-tmux machine:
// execFileSync("tmux", ...) fails ENOENT regardless of whether this
// developer's machine has tmux installed, and tmux.ts's own
// wrapper turns that into a TmuxError, thrown before any tmux
// command in cmdLead's body can succeed - the plainest reachable
// case named in src/cli.ts's own catch-block comment.
```

## line 192

```
// Before this fix, a throw here dropped the notice permanently: the
// project registers regardless of what happens next, and the
// notice is a consume-once in-process fact with no later chance to
// print. THE MUTATION THIS FAILS AGAINST: removing the catch
// block's own `if (registrationNotice) console.error(...)` (keeping
// the `throw e` after it) - the process still exits nonzero, but
// the notice never appears anywhere.
```
