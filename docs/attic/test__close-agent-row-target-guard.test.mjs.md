# Attic: test/close-agent-row-target-guard.test.mjs

Comments removed from `test/close-agent-row-target-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #27's L4 fix round R10, todo 181 item 3 (codex F1). closeAgentRow()
// used to guard only on id and status='running', so a caller that reads
// tmux_target, decides the pane is dead, and calls this later can race a
// DIFFERENT writer recording a fresh pane on the SAME row in between - the
// real case is `hive lead`'s own CAS restarting a lead agent_close just
// probed as confirmed-dead. id and status alone would still match, closing a
// row that is genuinely running again on the strength of a probe that is no
// longer true. expectedTmuxTarget makes the close conditional on the row
// still naming the pane the caller actually probed.
//
// No tmux, no server, just the SQL: closeAgentRow does not touch tmux at
// all, and the race it guards against is a DB write racing a DB write, not
// anything tmux-shaped. Reproducing the real end-to-end race (a concurrent
// `hive lead` CAS landing between agent_close's probe and its own close) has
// no reliable hook to interject on - there is no SQL write between
// findAgent's SELECT and closeAgentRow's UPDATE inside agent_close to hang a
// trigger off, and a real race between two separate processes cannot be
// pointed at that exact gap without either process cooperating with the
// test. This pins the mechanism itself deterministically instead: exactly
// what closeAgentRow does when the column it is asked to expect does or does
// not match what is actually there. agent_close's own existing tests already
// cover the ordinary (non-raced) success path through the real MCP surface.
```

## line 67

```
// Stands in for a concurrent `hive lead` CAS recording a fresh pane on
// this exact row after agent_close's own probe but before its close.
```
