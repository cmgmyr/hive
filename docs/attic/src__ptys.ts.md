# Attic: src/ptys.ts

Comments removed from `src/ptys.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 1

```
// The 2026-08-07 morning incident: a box hit its PTY ceiling (518
// allocated against kern.tty.ptmx_max=511), every tmux new-session/split/
// respawn failed with "fork failed: Device not configured", and that string
// named nothing a human could act on. Getting from it to "you are out of
// PTYs" took five separate probes. This module is the diagnostic that
// should have existed: `hive doctor` calls ptyHeadroom() and prints one line
// from what it returns.
//
// NEVER THROWS. An unsupported platform, a missing sysctl, an unreadable
// /proc file, or `ps` not on PATH all degrade to returning null -- silence,
// the same as an unsupported platform -- never a thrown error. Doctor is one
// command with many other reasons to already be red; this check must never
// be the reason.
//
// No cleanup action lives here, and none should be added. Doctor reports;
// it does not kill tmux servers or shells
// (.claude/sessions/dead-ends/2026-08-07-killing-orphaned-tmux-servers-by-pid.md
// -- a pid-to-socket mapping was observed ambiguous on a real row, and
// getting one wrong kills the live server).
```

## line 25

```
// WHAT THIS ACTUALLY MEASURES DIFFERS BY PLATFORM, and the weaker of the
// two is what the field name has to be read as. On linux it is the
// kernel's own count (/proc/sys/kernel/pty/nr). On DARWIN it is the number
// of distinct ttys with a live process on them, which is a LOWER BOUND on
// what the kernel has allocated: a pty whose only remaining holder is an
// open fd with no controlling process is invisible to `ps`.
//
// THE ERROR RUNS IN THE DANGEROUS DIRECTION -- it under-reports, so doctor
// can in principle say "plenty free" on a box where a tmux create is about
// to fail -- and it is still the right probe, for two measured reasons.
// macOS publishes kern.tty.ptmx_max and NO counter to pair with it (the
// entire `sysctl -a` tty namespace is that one key), so there is nothing
// stronger to read. And this is the probe the 2026-08-07 incident itself
// used: it reported 486 of 511 while every create was failing, then 14
// after the sweep, so it tracked the real condition on the one occasion
// anyone has been able to check it against reality.
// Callers must not print this as a kernel allocation count; src/cli.ts
// says "in use" for exactly this reason.
```

## line 45

```
// A CANDIDATE count, not reclaimable capacity, and NOT because some of
// them are live: by construction none of them are, since a live pane's
// shell is parented to the tmux server and never to launchd (see
// isOrphanLoginShell). The two real reasons are that a detached terminal a
// human still wants also reads as ppid 1, and that not every pty is held
// by a shell at all -- so this is a lower bound on ONE class of holder.
// A caller must not print it as "you can free N". See the warn text this
// feeds in src/cli.ts.
```

## line 60

```
// The THIRD `ps -eo` column, verbatim -- `comm=` on darwin (empirically
// confirmed by the incident itself to include a login shell's leading
// dash), `args=` on linux (see isOrphanLoginShell below for why: linux's
// `comm=` cannot show it). May contain trailing arguments when it came
// from `args=`; callers that care about the process's own name take only
// the first whitespace-delimited token.
```

## line 71

```
// Exported so the parsing itself is testable against fixture text, per
// test/CLAUDE.md's "write tests that can fail": a test asserting a number
// read off the box it runs on cannot fail, so the corpus is `ps -eo
// tty=,ppid=,comm=` (darwin) or `tty=,ppid=,args=` (linux) output captured
// as a string, not a live probe.
```

## line 87

```
// macOS names pty ttys ttys000, ttys001, ... "Allocated" is a count of
// distinct names, not rows: a shell and its child both list the same tty.
```

## line 93

```
// The measurement trap this lane exists to close
// (.claude/sessions/dead-ends/2026-08-07-pgrep-x-zsh-to-count-shells-holding-ptys.md):
// a login shell's process name is `-zsh`, WITH THE LEADING DASH, and `pgrep
// -x zsh` demands an exact match, so it counted 1 while 483 shells held
// ptys. Match the basename and accept any shell with a leading dash, not
// only zsh -- the incident's shells were zsh, but the convention (argv[0][0]
// == '-' marks a login shell) is not shell-specific. ppid 1 is the other
// half: a live pane's shell is parented to the tmux server, never to
// launchd, so ppid 1 means the parent tmux server is gone and this shell
// outlived it.
//
// A second, platform-specific version of the same
// trap: on linux, `ps -o comm=` is the kernel's task->comm, set from the
// executable's own basename at exec and NEVER from argv[0] -- it cannot
// carry the leading dash no matter how the shell was invoked. Only `args=`
// (reconstructed from /proc/<pid>/cmdline, which does preserve argv[0]
// verbatim) can show it there. That is why linuxHeadroom below requests
// `args=` while darwinHeadroom keeps the `comm=` the incident's own probe
// used and confirmed correct. Taking only the first whitespace token here
// is what makes one function work against either column: `comm=` is always
// one token already, and `args=`'s first token is argv[0].
// Exported for scripts/sweep-scratch.mjs: the dev sweep reaps this
// exact population and must use the identical predicate doctor's count
// already rests on, not a second hand-copied version - the tmux-and-panes.md
// rule about one predicate rather than three copies applies just as much
// here as it did to the input-box detector.
```

## line 130

```
// `field` differs by platform (see isOrphanLoginShell's comment); `stdio`
// pins stderr to a pipe hive throws away, not the parent's own -- without
// it, execFileSync inherits stderr by default, and a `ps`/`sysctl` failure
// this module is documented to degrade to SILENCE would instead print an
// unlabelled system error line straight past the try/catch that is supposed
// to be swallowing it.
```

## line 145

```
// A JUDGEMENT, not a measurement, made explicit so nobody later reads this
// number as derived from anything: the incident failed at zero free with no
// warning at all. A full suite run allocates ptys in bursts rather than one
// at a time, so a warn that fires slightly early costs one line of text,
// while one that fires slightly late costs a suite run that reads as 60
// broken assertions. The percentage carries the number across boxes with a
// different ptmx_max; the floor of 32 keeps it meaningful on a small one.
```

## line 156

```
// The comparison itself, not only the threshold it reads, is exported and
// tested at the boundary: keeping it here rather than inlined at the one
// call site in src/cli.ts is what makes "exactly at the threshold" and "one
// either side" fixture-testable instead of only observable by reading
// doctor's own stdout.
```

## line 166

```
// A number that parses but is <= 0 is not a real reading -- Number("".trim())
// is 0, not NaN, so Number.isFinite alone does not catch an empty/unpopulated
// sysctl or /proc read (observed under some seccomp-filtered /proc mounts).
// Without this, a probe "success" of max=0, allocated=0 computes free=0,
// which is BELOW ptyWarnThreshold(0)=32, and doctor prints a confident "below
// the safety margin" warn about a box with no pty pressure at all -- a
// stronger claim than anything was actually measured, which is the one thing
// this whole module exists not to do.
```

## line 178

```
// Absolute path, not a bare `sysctl` resolved off PATH: /usr/sbin is not on
// every minimal PATH hive can find itself launched under (the iTerm PATH
// note in .claude/rules/tmux-and-panes.md is the documented instance of this
// class of problem), and sysctl's location on macOS is a stable system path,
// not something a user relocates.
```

## line 193

```
// ONE ps fork, not two: allocated and orphan counts both come off this one
// snapshot. Two probes of the same quantity that can disagree is the
// exact shape of the dead-end this file's own comments already cite.
```

## line 211

```
// Orphan detection is advisory context for the warn line, not the
// allocated/max numbers above, so its own failure (no `ps` on PATH) must
// not take those down with it -- unlike the darwin path, where the same
// ps call IS the allocated count. `args=`, not `comm=`: see
// isOrphanLoginShell's comment for why linux's comm cannot carry the
// leading dash a login shell marks itself with.
```

## line 221

```
// Leave it at 0; see comment above.
```

## line 226

```
// Split out from ptyHeadroom() so the two ways this degrades to null are
// each testable directly against a string/callback, instead of only through
// the real os.platform()/execFileSync/readFileSync this process actually
// has -- test/CLAUDE.md's "a test asserting a number read off the box it
// runs on cannot fail" applies just as much to "this platform is
// unsupported" and "this probe throws" as it does to the parsing above.
```

## line 247

```
// The outer try/catch is belt-and-suspenders around platform() itself
// (not expected to throw in practice), so the module's own "NEVER THROWS"
// header comment is true of the whole function, not just the probe half
// safeProbe already guards.
```
