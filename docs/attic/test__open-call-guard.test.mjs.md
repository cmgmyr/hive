# Attic: test/open-call-guard.test.mjs

Comments removed from `test/open-call-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 11

```
// isolateTmux() ABOVE the explanatory comment below, deliberately: this
// suite's own isolation scan (test/suite-isolation.test.mjs) fails a file
// where any earlier LINE - comment or not - matches a spawn pattern, and this
// file's own comment two paragraphs down has to describe the very call it
// mentions.
```

## line 18

```
// Todo 419. This is the whole lane, not a nice-to-have alongside it: without
// a test that reproduces the actual escape, the next worktree run goes green
// for the wrong reason - exactly what happened here (todo 419 comment 1106
// recorded zero calls on the same code that produced three real windows in
// the main checkout, because a fresh worktree had neither precondition the
// escape needs).
//
// TWO PRECONDITIONS, PROVEN TOGETHER. scripts/open-guard.mjs's own header
// names them: a dashboard FILE already at the resolved project path, and a
// scratch kv store carrying no `hive:dashboard_opened` marker (true by
// construction for a fresh scratch store). Building both directly below,
// rather than relying on either checkout's ambient state, is what makes this
// reproducible on any machine - a worktree, the main checkout, or CI.
//
// isolateTmux() above is needed even though this file's own process never
// touches tmux directly: the e2e case below spawns the wrapper through
// runNode, and the same suite-isolation scan treats every runCli/runNode
// occurrence as tmux-reaching regardless of what the spawned process
// actually does - including the ones embedded inside this file's own
// template-string fixture. Matches the identical pattern in
// test/tmux-leak-check.test.mjs, whose target-script strings have the same
// property.
```

## line 105

```
// it-level skip, not describe-level: a skipped describe's nested tests
// are invisible to node --test's own summary tally (measured - a
// describe-level skip wrapping this one test reported `skipped 0`,
// where an it-level skip on the identical test reports `skipped 1`),
// and .github/workflows/ci.yml's skip-budget gate parses exactly that
// summary line. A skip nobody can see counted is worse than the wrong
// count - it defeats the gate rather than tripping it.
```

## line 117

```
// Deliberately the SAME shape as test/dashboard-open-lead.test.mjs's
// own fixture setup, minus that file's local fake-open bin on PATH:
// exactly what test/restart-lead.test.mjs's REPO-registered lead
// spawn looked like before it was fixed with --no-dashboard (todo
// 419). PATH is left ambient on purpose - under the wrapper this
// test spawns below, that PATH already carries the WRAPPER's own
// suite-wide fake, which is precisely the mechanism under test.
```

## line 162

```
// The tmux leak check must not be the thing that failed this run - a
// false attribution here would say the open-call guard works when it
// was actually the sibling check doing the failing.
```
