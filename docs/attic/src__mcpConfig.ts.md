# Attic: src/mcpConfig.ts

Comments removed from `src/mcpConfig.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 1

```
// Reading Claude Code's MCP registrations. hive never writes them; it reports
// what is there, because a registration that runs a bare `node` is one `cd`
// away from starting hive's server under an interpreter that cannot open the
// store.
```

## line 18

```
// fileURLToPath, not URL.pathname: a checkout under "Application Support"
// comes back percent-encoded and matches nothing.
```

## line 22

```
// The one place a `claude mcp add` line is written. Paths are quoted because
// the line is meant to be pasted, and the interpreter a version manager
// installs is routinely under a directory with a space in it ("Application
// Support" on this author's machine).
```

## line 30

```
// What is wrong with one registration, given the interpreter hive wants the
// server to run under, or null when nothing is. Both surfaces that report this
// (hive doctor and hive setup) call it, so one problem never gets two
// descriptions; each wraps the lines in its own prefix.
//
// The first line completes "<label>: ", the rest are continuations.
```

## line 61

```
// Absent, or a shape hive does not get to have an opinion about.
```

## line 66

```
// Claude Code's own config, holding user scope and local scope both.
// CLAUDE_CONFIG_DIR moves it.
```

## line 71

```
// A registration is hive's if it is named hive, or if it is named something
// else and points at this checkout's server. Shared, so the offer below cannot
// disagree with what the scan counts as already registered.
```

## line 79

```
// Where Claude Code keeps them. User and local scope share ~/.claude.json
// (local hangs off the project's entry); project scope is a .mcp.json in the
// repo.
```

## line 88

```
// Remote servers (http, sse) have no command and cannot have this bug.
```

## line 108

```
// The one registration state setup can establish rather than infer: this
// config file exists, it parses, it lists MCP servers, and hive is not among
// them. Everything else stays silent, including the case that looks the most
// like it. "No hive registration found anywhere" is an inference about the
// machine, and hive reads one config dir and at most one project's .mcp.json,
// so a user registered project-scope elsewhere would be told they have no
// registration on every single update.
//
// The three silent states are silent for the same reason: a missing file, an
// unreadable one, and one with no mcpServers block are each a state hive
// cannot interpret. Only the shape above supports a sentence.
//
// Offered, not warned. A fresh install with no hive registration yet is doing
// the right thing in the right order; the README hands over this same line one
// step below `hive setup`. Both doctor and setup print it, from here, so the
// two surfaces keep one voice.
```

## line 132

```
// --scope user because that is the file just read, and the scope the README
// installs with.
// Says only what the file shows. An mcpServers block can be present and
// empty, which is what Claude Code writes for someone who has never added a
// server, so "lists MCP servers" would be false exactly where this is most
// useful. "Not registered in this file" is true either way, and is the
// whole of the claim.
```
