# Attic: test/agent-rename-partial.test.mjs

Comments removed from `test/agent-rename-partial.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// TODO 418, agent_rename's own version of todo 414's fix for agent_send.
// sendText (src/tmux.ts) is a PASTE and then, ENTER_DELAY_MS later, a
// SEPARATE tmux call for the Enter. Before this lane, agent_rename's catch
// asserted a cause it never checked ("Pane died between the liveness check
// and the keystrokes") for EVERY sendText failure, so a paste that landed
// with only the Enter failing returned `retitled: false` and NO note at
// all - worse than the bare tmux error a caller would have seen before
// todo 386 even built onPasted.
//
// UNLIKE todo 414, this is a NOTE, not a throw. agent_rename sends one
// fixed, short command to a claude pane only, and a retry is already
// refused on both paths that could send one (holdsHumanInput's pending-box
// guard on the next agent_rename, and agent_send's own text path on the
// same predicate) - see the code comment at the fix itself. So the only
// thing missing was the receipt's truthfulness, not a stronger refusal.
//
// THE SHIM IS test/agent-send-partial.test.mjs's, reused rather than
// rebuilt: same env-var toggles, same reasoning for using a real tmux
// rather than killing the pane mid-gap.
```

## line 65

```
// 220 columns and placement "window": matches agent-send-partial.test.mjs's
// own reasoning - every fixture here was captured at 220, and a worker gets
// its own window so a tiled split does not shrink the pane the fixture's
// own box needs to classify.
```

## line 71

```
// The ordinary client: no HIVE_TEST_FAIL_ENTER/PASTE, so its own
// tmux calls (spawn, agent_output, agent_status) stay real throughout.
```

## line 97

```
// A second, short-lived MCP server per failing call, spawned WITH its extra
// env baked in at process start - matches agent-send-partial.test.mjs's own
// callWithBrokenTmux, for the identical reason: toggling process.env in
// this file cannot reach a spawned server's own tmux calls.
```

## line 135

```
// The row IS renamed either way; only the pane's own title was left
// alone, same as the two guards above this one.
```

## line 141

```
// The paste really landed - without this the case is not the one this
// lane closes.
```

## line 159

```
// CONTROL. DIES if the new branch is not gated on `pasted` actually
// being set: a version that adds a note for every sendText failure,
// not only the ones where the paste landed, would turn this
// pre-existing "nothing happened" case into a false claim that text is
// on screen.
```
