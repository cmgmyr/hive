# Attic: test/store.test.mjs

Comments removed from `test/store.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// The MCP server drives tmux for the agent tools; isolate first.
```

## line 9

```
// One server instance drives the whole file; a second instance with its own
// actor id joins for the lease-contention case. Both share one database.
```

## line 120

```
// Expiry compares datetime('now') at whole-second granularity with a
// strict <, so a 1s TTL can outlive its deadline by up to ~2s.
```
