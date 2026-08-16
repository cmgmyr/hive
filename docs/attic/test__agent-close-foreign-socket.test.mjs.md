# Attic: test/agent-close-foreign-socket.test.mjs

Comments removed from `test/agent-close-foreign-socket.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #73, todo 212 (step 3 of the lane): D7 on plan-73-tmux-socket.
//
// agent_close retires a lead row whose pane is "confirmed dead" -
// isLive(agent) === false, never null - and before this issue's lane
// "confirmed dead" resolved through the exact cross-server blind spot #68
// left as a residual: a caller talking to the wrong tmux server got a false
// `false` for a lead that is genuinely still running elsewhere, and retired
// it. Step 2 (todo 211) made isLive() consult the row's own recorded socket
// via rowLive(), so a foreign-socket lead row now answers null instead of
// false - agent_close's own `if (live === null) throw probeFailed(agent)`
// (src/tools/agents.ts) already sat above the retirement path, so the fix
// is the plumbing from step 2, not a new line here. This file is the test
// todo 212 asks for BECAUSE the plumbing must not be assumed to carry it.
```

## line 39

```
// seedLeadRow's default tmux_target ('%not-a-real-pane') is a dead-looking
// pane on purpose: this process's own isolated tmux server genuinely has no
// such pane, so a matching-socket probe answers a real, definite `false`
// (not null) - the case this file's control needs to prove the retirement
// path still fires exactly as before this lane.
```

## line 46

```
// A plain user session, deliberately: agent_close's worker-refusal check
// (currentActor().startsWith("agent:")) sits ABOVE the probe this file is
// about, and only a spawned worker trips it. A human at a terminal (a
// "user:" identity, the McpClient default with no HIVE_AGENT_ID) reaches the
// isLive() check this file actually tests.
```
