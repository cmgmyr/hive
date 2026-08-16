# Attic: test/part-c-gate.test.mjs

Comments removed from `test/part-c-gate.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 11

```
// McpClient spawns a plain node child (never a real hive server in these
// tests -- see the fixtures below), so nothing here actually touches tmux.
// But constructing one trips suite-isolation's own textual scan regardless
// (it cannot tell that apart from a real hive spawn, by design -- see that
// file's own header), so isolate the same way every other file here does.
```

## line 19

```
// A minimal stand-in for a real hive dist/index.js: exits immediately, no MCP
// handshake needed, because this only exercises McpClient's own process
// lifecycle (close()), not protocol behavior. Real hive MCP client behavior
// (start/call/JSON-RPC framing) is exercised for real by scripts/part-c-gate.mjs
// itself when run by hand -- see that file's own header on why it costs real
// tokens and is not part of `npm test`.
```

## line 27

```
// Todo 141 item 7: close() used to attach a `once("exit", ...)` listener
// unconditionally, but Node emits "exit" exactly once -- if the child
// exited before close() was ever called, that event is already gone by
// the time the listener is attached, and only the exit-race's own
// unref'd 3-second timeout is left to resolve the wait. This pins the
// fix (checking child.exitCode before attaching the listener) by timing:
// the buggy shape takes at least 3000ms here (the test's own event loop
// has other referenced handles keeping it alive long enough for the
// unref'd timer to actually fire), a fixed close() returns immediately.
```

## line 59

```
// Guards the OTHER direction (todo 130's own fix, kept intact by item 7):
// close() must not return the instant SIGKILL is merely sent -- it must
// wait for the process to actually be gone, or cmdDown's rmSync can race
// a still-dying process's open file descriptors.
```

## line 67

```
// let it actually start before closing
```

## line 69

```
// A SIGKILLed process reports its death via signalCode, not exitCode
// (which stays null for a signal exit) -- checking exitCode alone here
// would be the same category of mistake close() itself had to avoid.
```

## line 80

```
// Todo 141 item 10: Part B's documented usage is
// eval "$(node scripts/isolated-hive.mjs up)", which EXPORTS HIVE_DATA_DIR
// into the interactive shell; it survives a later `down` even though the
// directory is gone. Without this guard, recordResultInStore would let
// db.ts silently recreate an empty store there and report success into it.
```
