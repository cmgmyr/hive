# Attic: test/state-provenance-mcp.test.mjs

Comments removed from `test/state-provenance-mcp.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 14

```
// L1 (design-l1). test/state-provenance.test.mjs already pins
// deriveProvenance()'s own logic exhaustively; this file pins that the two
// decorated MCP surfaces actually carry it through a real server -- agentSummary
// (agent_list, agent_status) and wake_when_idle's watching array -- and that
// wake_when_idle's already_satisfied path is untouched, since that predicate
// is explicitly out of scope for this lane (it belongs to L2).
```

## line 36

```
// Issue #72's pane signal. dialogPane replays a real captured dialog screen
// (test/fixtures/panes/folder-trust-dialog.txt, same fixture
// typing-guards.test.mjs pins paneChoiceCheck against) rather than typing
// anything synthetic: what is under test here is agent_list carrying
// paneChoiceCheck's answer through, not paneChoiceCheck itself.
```

## line 55

```
// stateChangedAgo=null leaves state_changed_at NULL: a latch that has never
// changed, same as a freshly-spawned row before its first hook event.
```

## line 177

```
// False-green shape 7 (test/CLAUDE.md): a fixture with only one state
// cannot prove this is the last row, not just any row.
```

## line 203

```
// Fix round 1, item 5b. paneField's reportsAgentStateLog half used to
// be unpinned here: this worker is on a LIVE pane (alive === true), so
// a mutant that gated pane only on `alive !== true return {}` -- never
// checking reportsAgentStateLog at all -- passed every other test in
// this file and would only go red here.
```

## line 238

```
// Same bogus target the existing "dead" case above uses. alive is
// false here, and #72's pane signal is specifically about a worker
// that IS alive but stuck -- a dead one has nothing to capture.
```

## line 252

```
// paneField used to live inside the shared agentSummary, so agent_status
// silently got a SECOND, independently-timed pane snapshot next to its
// own capturePane/inputBoxField below -- a dialog clearing between the
// two captures could leave one response with a dialog pane field beside
// a top-level tail showing no dialog at all. agent_status must build
// its pane picture from its own single capture only.
```

## line 268

```
// Todo 392. The dialog fixture above (folder-trust-dialog.txt) never carried
// `╰`, so it could never have caught the bug: an ordinary tool-permission
// prompt's own preview box closes with `╰`, the same glyph paneChoiceCheck's
// INPUT_BOX_PRESENT used to trust as proof no dialog was up, and agent_list
// reported "no dialog" for a worker sitting on a real, unread prompt. Its own
// session and panes, deliberately: reusing dialogPane above would only prove
// the fixture that was already fine still works.
```

## line 340

```
// src/tools/wakes.ts's `state` field used to come straight from
// a.agent_state, so a dead watched agent showed its last real state
// ("working") with no hint anything was wrong -- agent_list, on the
// same row, already said "gone". Both now derive `state` from the same
// deriveProvenance() call, so they cannot disagree about the same
// worker again.
```

## line 361

```
// Pinned because this file touches wakes.ts: the already_satisfied
// predicate at src/tools/wakes.ts is explicitly NOT this lane's to
// change (that is L2), and this proves the edit here did not brush it.
```
