# Attic: test/cli-project-pin.test.mjs

Comments removed from `test/cli-project-pin.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #63's fix round: agent_spawn's own MCP tools resolve a worker's
// project from its agents-row pin (src/context.ts's agentProjectPin), but
// cmdTodos, cmdTodo and cmdStatusline (src/cli.ts) resolved by cwd alone -
// findProjectForCwd, ignoring the pin entirely. One pane could answer two
// ways: the MCP tools honoring the brief, the CLI commands run in the same
// pane's shell resolving to whatever the cwd happens to be. No test in the
// suite ran any CLI command with a pin set, which is how that was missed.
```

## line 16

```
// Issue #27's L4 fix round R6, todo 170 (counselors opus F6). Needed only by
// the duplicate-actor_id describe block below, which seeds rows directly
// rather than through a real spawn.
```

## line 24

```
// mkdtempSync's prefix argument lands literally in the path, so matching an
// unregistered directory's own path back out of an error message needs
// escaping - the same rule test/spawn-cwd-scope.test.mjs's namedAs() exists
// for.
```

## line 44

```
// A REAL running agents row, via a real spawn - this is the exact row
// agentProjectPin() looks up, not a hand-inserted stand-in, so it also
// proves launchAgent's own env (HIVE_AGENT_ID, HIVE_PROJECT_LOCK) is
// what a CLI command run from that worker's pane would actually see.
```

## line 63

```
// A cwd that names NOTHING, deliberately: findProjectForCwd() alone
// would return null here (silent, D5), so any output at all is already
// proof the pin - not the cwd - decided the answer.
```

## line 95

```
// cmdStatusline prints nothing for a project with no live state, and
// nothing at all for no project (its own doc comment) - a plain cwd
// resolution here would hit exactly that silent path. The pinned
// project has a running agent (the worker itself) and an open todo,
// so non-empty output is already proof the pin won.
```

## line 114

```
// The false-green counselors run 9 found: swap pinnedOrCwdProject's
// body for `getProject(effectiveProjectId())!` - the REGISTERING
// version - and every other test in this file stays green, because the
// pin wins before registration in the first three cases, the fourth
// case's cwd is already registered, and the fifth still throws. None of
// them exercise the one case that distinguishes the two functions: an
// unregistered cwd with no pin at all, where the registering version
// creates a project and the non-registering one returns null. Assert
// the count, not the output - a project registering silently is the
// bug's signature, same rule as (m) in spawn-cwd-scope.test.mjs.
```

## line 144

```
// (finding 4) "restart it" is not an actionable remedy here: HIVE_AGENT_ID
// and HIVE_PROJECT_LOCK live in the pane's own env (tmux -e), not the
// process's, and survive a restart in the same pane. The message must
// name the env to unset, or this failure has no escape a human can act
// on from inside the pane that hit it.
```

## line 150

```
// A raw uncaught exception prints its own trace to stderr with these
// markers; their absence is what "clean message" actually means here,
// not just that stdout also happened to carry a nicer string.
// IMMUNE to generated data, and more strongly than that: cmdTodos's
// bad-pin path throws out of agentProjectPin() before ever reaching
// resolveProjectAndNotify (src/cli.ts), the ONLY call site that writes
// to stderr for a CLI command (a registration notice, which is the one
// place a generated project path can land in output at all) - so
// stderr here is always the empty string, not merely a string these
// four alternates happen not to match. A future caller that reaches
// this assertion through a path where stderr is non-empty would
// inherit an unexamined assumption, not a bug this comment already
// covers.
```

## line 167

```
// cmdStatusline's own doc comment: "Prints nothing outside a registered
// project... status lines run in every directory a session opens." A
// status line redraws on every prompt, so the same loud failure that is
// correct for `hive todos` (a human runs it once, on purpose) would
// print the pin error on every single render if it reached here
// unguarded.
```

## line 184

```
// cwd is deliberately NOT the pinned project, so a pass here proves the
// PATH argument (not cwd) drove the resolution. Asserting on the
// "no profile" message rather than exit code alone: a wrongly-always-
// refusing implementation would also exit 1, so the message text -
// "no profile" and not "locked to project" - is what actually
// distinguishes "reached normal resolution" from "refused".
```

## line 201

```
// The false-green shape this shares with finding 1 and finding 6:
// refusing is only half proven without checking that the refusal
// branch didn't register a project for the path on its way to
// refusing. Assert the count, not just the throw.
```

## line 222

```
// Proves the change is scoped to locked sessions: without this, a fix
// that accidentally made resolveProject refuse or no-op for EVERY path
// argument (not just a locked, disagreeing one) would pass 2a/2b and
// still be wrong.
```

## line 241

```
// Issue #27's L4 fix round R6, todo 170 (counselors opus F6). Decision 2's
// closed-row actor_id reuse (the lead's own identity-survives-a-restart
// mechanism) means actor_id stopped being unique across agents ROWS: one
// closed row and one running row can now legitimately share it.
// agentProjectPin's SELECT had no ORDER BY, so which row's project_id it
// returned was whatever SQLite's query plan reached first - unreachable for
// a lead TODAY only because a lead's own env carries no HIVE_PROJECT_LOCK=1
// (todo 167 in this same round), but the mechanism (two rows, one actor_id)
// is real and this guard should not depend on that staying true.
```

## line 259

```
// Lower rowid, closed - exactly the row a bare `.get()` with no ORDER BY
// tends to reach first in practice, per the finding.
```

## line 280

```
// IMMUNE to generated data: "closed-project-todo-170" is a hard-coded
// literal this test itself INSERTed as the todo's title two lines above
// it, not a scratch path or any other value hive generated. It can only
// appear in stdout by naming the actual todo it identifies, which is
// exactly the regression this line exists to catch.
```
