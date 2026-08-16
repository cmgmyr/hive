# Attic: test/agent-send-partial.test.mjs

Comments removed from `test/agent-send-partial.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// TODO 414. sendText (src/tmux.ts) is a paste and then, ENTER_DELAY_MS later,
// a SEPARATE tmux call for the Enter. Before this lane, a throw from that
// second call propagated as a bare TmuxError, and agent_send's synchronous
// caller reads a throw as "nothing was sent" - so it retries the whole send,
// pasting the same text onto the end of the stranded copy and submitting
// both as one message. On a claude pane that lands on top of todo 389's own
// clobber shape; on a PLAIN SHELL pane, which holdsHumanInput cannot see at
// all (.claude/rules/tmux-and-panes.md, "THIS PROTECTION IS
// CLAUDE-CHROME-SHAPED"), the merged line EXECUTES.
//
// Todo 386 (f0bec0e) built the mechanism this lane reuses rather than
// reinventing: sendText's onPasted callback fires the instant the PASTE
// CALL RETURNS, before the Enter is ever attempted - NOT "the instant the
// paste lands", which this file's own header claimed until the adversarial
// round corrected it. Those differ for a timed-out paste call: the server
// can finish a command after the client gives up on it
// (.claude/rules/tmux-and-panes.md's own "A TIMED-OUT PASTE..." paragraph),
// so a TmuxTimeoutError on the paste itself can throw before onPasted ever
// runs even though the text landed. That case gets its own hedged message
// ("may already be on screen"), tested below; only a confirmed pasted:true
// gets the confident one. Here there is a synchronous caller standing right
// there, so the fix is a truthful thrown error instead: the text WAS on
// screen, unsubmitted, the moment the paste returned, and the exact call
// that finishes it is agent_send(name, keys: ["Enter"]) - never a second
// text send, which is the thing this message exists to make read as
// obviously wrong.
//
// THE FAKE TMUX SHIM IS test/notice-partial-send.test.mjs's, reused rather
// than rebuilt (.claude/sessions/dead-ends/2026-08-14-killing-the-pane-mid-
// gap-to-reproduce-a-partial-send.md - killing the pane races a 300ms
// window and destroys the evidence; this env-var shim is deterministic and
// serves the Enter-fails case, the paste-fails control, and the
// paste-times-out case from one fixture).
//
// COVERS BOTH PANE KINDS, which notice-partial-send.test.mjs's own case C
// established matters for a real distinction: the existing pending-box
// guard (todo 317, holdsHumanInput) already blocks a blind text retry on a
// CLAUDE pane in production, so the danger there is a caller wasting a call
// on a refusal - not asserted directly here, since this file's claude pane
// is a static `cat` fixture and cannot stage a live pending box (see the
// claude-pane "finish" test's own comment). On a SHELL pane nothing blocks
// it at all, and this file's shell-pane retry test proves that case
// actually executes the merge rather than merely asserting the codebase's
// own claim about it.
```

## line 99

```
// 220 columns: every fixture in that directory was captured at 220, and a
// narrower pane wraps its own box borders, which reads as no-box (todo 399,
// "A WRAPPED BORDER IS ONE EDGE") and would fail the claude-pane case for
// the wrong reason.
```

## line 105

```
// The ordinary client: no HIVE_TEST_FAIL_ENTER/PASTE, so every tmux
// call it makes passes through the shim untouched.
```

## line 120

```
// placement: "window" for both spawns below, for the same reason
// typing-guards.test.mjs gives every worker its own window: a tiled split
// pane shrinks as more workers join the session, and this file's claude
// pane needs its full 60 rows for the fixture's own box to classify
// (see BOX_TAIL_ROWS / BOX_MAX_ROWS in .claude/rules/tmux-and-panes.md).
```

## line 136

```
// A REAL interactive bash, not a fixture cat - the claim under test
// ("the shell pane actually executes the merge") needs a shell that reads
// its own stdin, not a static screen. No claude chrome anywhere, so
// isClaudeCommand(agent.command) is false and holdsHumanInput can never see
// text sitting in this pane (.claude/rules/tmux-and-panes.md's own
// "CLAUDE-CHROME-SHAPED" section).
```

## line 148

```
// A second, short-lived MCP server per failing call, spawned WITH its extra
// env baked in at process start. Toggling process.env in THIS file, the way
// notice-partial-send.test.mjs does around its in-process tick() calls,
// cannot reach a spawned server's tmux calls: execFileSync inside that
// CHILD process reads the child's own env, fixed the moment node forked it,
// not this file's env at call time. `mcp` above is never given any of these
// variables, so its own tmux calls stay real for the rest of each test (the
// recovery agent_send(keys:["Enter"]), the blind retry, agent_output).
```

## line 171

```
// DIES if the catch block reverts to a bare rethrow: the message would
// then be the shim's own "tmux: send-keys failed", matching none of the
// three assertions below.
```

## line 196

```
// Adversarial-round finding 4: the earlier version of this test used the
// claude pane and asserted only `finished.sent === true`, which stays
// green even if the keys path stops calling tmux at all and just
// fabricates a receipt - the exact false-green shape counselors' codex
// seat already found once on this file's sibling suite
// (test/typing-guards.test.mjs's own comment: "a handler returning
// {sent: true} without ever calling sendText kept all of them green").
// A static cat fixture has nothing listening on stdin to prove a real
// Enter landed, so this uses the SHELL pane instead, where a submitted
// "MARKERONE" is something bash actually tries to run - proof read off
// the pane, not off the receipt's own claim about itself.
//
// NOT ASSERTED HERE, and it never was: that a blind text retry (rather
// than the named keys call) would instead be refused by the pre-existing
// pending-box guard (todo 317). It would be, on a claude pane, in
// production - a stranded send-keys -l paste carries no faint
// attribute, same mechanism as test/fixtures/panes/real-input.txt - but
// this file's claude pane is a static `cat` of a fixture and cannot
// stage a live pending box: a live send-keys types where the pty's
// cursor actually sits (the row below the fixture's last printed line),
// not into the box the fixture merely PRINTS as text.
// test/typing-guards.test.mjs's own compose-finish test hits the
// identical limit and says so in the same words; it covers that guard by
// starting FROM a fixture that already has the pending text baked in.
// The shell-pane retry test below is where this lane's own claim -
// nothing stops a blind retry there - is demonstrated end to end.
```

## line 226

```
// THE RIGHT MOVE: the exact call the error named.
```

## line 241

```
// BLOCKING, adversarial round: the first version of this message always
// named agent_send(name, keys:["Enter"]) as the fix, which agents.ts's
// own keys-path guard (a worker calling keys against a lead) refuses -
// exactly the human's-pane scenario todo 414 was filed about. Seeded
// directly on the row, matching test/typing-guards.test.mjs's own
// "showingAsLead" pattern, since minting a real lead identity is a
// different test's job (lead-identity.test.mjs).
```

## line 267

```
// Adversarial-round finding 2. HIVE_TEST_HANG makes the shim never
// answer the paste's own send-keys call, and a short HIVE_TMUX_TIMEOUT_MS
// (the same testing-only override test/tmux-timeout.test.mjs uses) turns
// that into a real TmuxTimeoutError inside the production window rather
// than a 10-second wait. onPasted can never fire here - the paste call
// itself never returns - so `pasted` stays false, and the fix has to
// tell that apart from a call that genuinely FAILED (this file's control
// test below) rather than one that merely never answered.
```

## line 314

```
// Nothing refuses this. holdsHumanInput's box detector finds claude's
// own chrome; a bash pane has none (.claude/rules/tmux-and-panes.md,
// "THIS PROTECTION IS CLAUDE-CHROME-SHAPED"). The retry pastes onto the
// end of the stranded copy, and this time the Enter succeeds, so bash
// receives ONE line carrying BOTH copies concatenated and runs it.
```

## line 337

```
// CONTROL. DIES if the rewrite is not gated on onPasted actually firing:
// a version that rewrites every sendText failure, not only the ones
// where the paste landed, would turn this pre-existing, correct
// "nothing happened" error into a false claim that text is on screen.
```

## line 356

```
// Adversarial-round finding 3. normalizeAgentName (agents.ts, near line
// 604) blocks control characters and nothing else, so a name like
// `ba"tch` is valid. Naive string interpolation
// (`agent_send(name: "${name}", ...)`) would then emit
// `agent_send(name: "ba"tch", keys: ["Enter"])`, which does not parse -
// the only advertised recovery would itself be broken. JSON.stringify
// escapes it instead.
```

## line 367

```
// Plain substring, not a regex: JSON.stringify(name) already contains
// regex metacharacters (the embedded `"`), so re-parsing it into a
// RegExp would just reintroduce the escaping bug this test exists to
// catch, one layer up.
```
