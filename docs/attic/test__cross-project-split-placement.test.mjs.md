# Attic: test/cross-project-split-placement.test.mjs

Comments removed from `test/cross-project-split-placement.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 268 / plan-lane-3-tmux-topology. The case that started the whole
// investigation: a lead in project A is told to work in another repo, and
// the worker it spawns there must appear NEXT TO THE LEAD, not off in
// project B's own tab (pad 71 "THE PLACEMENT RULE, STATED ONCE" - "the
// worker's project's window" is the exact popping-out behaviour this design
// exists to stop, wearing a different costume). Todo 267 already built the
// mechanism (splitTargetWindow resolves the SPAWNING PARENT's window from
// the store); this file proves it generalizes across projects and that the
// receipt names where the pane actually landed, since a caller cannot
// reconstruct that from project_id alone.
```

## line 35

```
// Registered, but no `hive lead` of its own - the ordinary shape of "the
// lead is told to work in another repo" (project-scoping.md: cwd's
// project need not be running anything).
```

## line 77

```
// WHERE THE PANE IS: next to the lead, in project A's window.
```

## line 83

```
// WHERE THE PANE IS NOT: project B never gets a window of its own out
// of this spawn - there is nothing yet for a project-id fallback to
// have found, so a passing test here cannot be explained by the OLD
// "worker's own project's window" rule happening to agree.
```

## line 93

```
// STORE SCOPE: a separate question, and it stays project B's.
```

## line 101

```
// THE RECEIPT: names the crossing rather than leaving the caller to
// reconstruct it from project_id, which is exactly the field it can't.
```
