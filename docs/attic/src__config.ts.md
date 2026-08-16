# Attic: src/config.ts

Comments removed from `src/config.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 6

```
// The one machine preference issue #81 asks for. A file, not a row: hive
// restore swaps the database, and a terminal preference has no business being
// carried in a project snapshot or clobbered by restoring an older one.
```

## line 11

```
// Exported so a caller validating a user-supplied value (`hive setup
// --attach`) and this module's own fallback logic can't drift apart into two
// lists that quietly disagree about what is valid.
```

## line 22

```
// Exported so a caller validating a user-supplied value (`hive setup
// --auto-attach`) and this module's own fallback logic can't drift apart into
// two lists that quietly disagree about what is valid.
```

## line 41

```
// Read at CALL time, same reasoning as storeDir() itself (src/dataDir.ts:14-27):
// resolving the path into a module-level const would freeze it at this
// module's first import, ahead of whatever later sets HIVE_DATA_DIR.
//
// An absent file, an unreadable one, and malformed JSON all read as "nothing
// set yet" -- there is no operator here to report a parse error to, and a
// config read must not be the thing that breaks a tmux attach. storeDir()'s
// OWN refusal (the real store under a test runner, .claude/rules/store-and-
// datadir.md) is not swallowed with them: configPath() runs outside the try,
// so that throw still reaches the caller the same way it already does on the
// write side (setAttachMode's mkdirSync). Folding it into "absent file" would
// make a misconfigured test process read a silent "auto" instead of the loud
// failure the guard exists to give it.
```

## line 70

```
// HIVE_ATTACH_MODE is a one-off TESTING override, not the way to configure
// this -- use `hive setup --attach` for that. It exists because it does NOT
// reliably reach ensureAttached, which runs inside the MCP server process:
// Claude Code starts that from its own registration, so a shell export
// reaches it only by accident of the process chain
// (.claude/sessions/dead-ends/2026-08-02-env-var-for-mcp-server-config.md).
// A stored file reaches both call sites structurally; this does not, and
// must never be promoted to the primary mechanism for that reason.
```

## line 83

```
// HIVE_AUTO_ATTACH is a one-off TESTING override, not the way to configure
// this -- use `hive setup --auto-attach` for that. ensureAttached runs inside
// the MCP server process, which Claude Code starts from its own registration,
// so a shell export reaches it only by accident of the process chain. The
// legacy "0" spelling remains accepted because existing setups rely on it.
```

## line 94

```
// Where the mode came from, alongside the mode itself: "hive doctor" needs
// both to answer "why am I in control mode", not just the resolved value.
// Precedence is env, then the config file, then detection. An unknown config
// value (a future mode this build does not know, or a hand-edited typo)
// reads the same as absent -- "detection", falling back to "auto" -- rather
// than throwing.
```

## line 120

```
// Read-modify-write, so a key this lane does not know about survives a write
// from it.
```

## line 129

```
// Read-modify-write, so a key this lane does not know about survives a write
// from it.
```
