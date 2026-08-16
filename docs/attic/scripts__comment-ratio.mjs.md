# Attic: scripts/comment-ratio.mjs

Comments removed from `scripts/comment-ratio.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Caps how much of src/ is comment (todo 436). Run directly for the report.
```

## line 9

```
// Comment spans, skipping strings, templates and regexes. A line-prefix match
// would count src/dashboard.ts's embedded browser JS as comments.
```

## line 16

```
// `${}` pushes a code context so its contents scan by the same rules. Both
// desyncs this scanner has had were silent under-counts; see its tests.
```

## line 103

```
// Whole identifiers: `return /re/` and `x /re/` differ only in this word.
```

## line 133

```
// A comment LINE is one that exists only for its comment. One trailing real
// code costs no line and is not counted.
```

## line 140

```
// Newlines survive, or a block comment collapses the lines after it.
```

## line 191

```
// pathToFileURL: a `file://` template fails on any path needing encoding.
```
