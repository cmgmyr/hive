# Attic: test/agent-close-honest-cas.test.mjs

Comments removed from `test/agent-close-honest-cas.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Todo 369, measured live tearing down issue #156's own lane: agent_close
// kills the pane, then takes closeAgentRow's conditional close (id +
// status='running' + tmux_target). When that CAS loses, the row already says
// what actually happened - closed by someone else (the caller's real
// question, and the pane this call itself killed is still dead either way),
// or running again on a fresh pane (the only case that deserves a refusal).
// The old message claimed "Nothing was closed" unconditionally, which was
// FALSE for the case that was actually measured: this call's own kill-pane
// cannot be undone by a lost CAS.
//
// The real race (a concurrent writer landing between findAgent's SELECT and
// closeAgentRow's UPDATE) has no reliable hook to interject on -
// test/close-agent-row-target-guard.test.mjs's own header explains why. What
// IS reproducible through the real MCP surface is a row that is ALREADY
// retired by the time this call reads it: findAgent's agent_id branch does
// not filter by status, so a caller targeting by id reaches the identical
// lost-CAS code path whether the row became inconsistent a millisecond ago
// or was already that way when the call started. Same code, same report.
```

## line 50

```
// Stands in for a concurrent closer (the janitor, or another agent_close)
// that retired this row before this call ever reached its own write -
// the same lost-CAS code path a genuinely concurrent close would hit.
// DELIBERATELY the row only - the pane is left genuinely ALIVE, which is
// exactly what the counselors fix round below is about.
```

## line 67

```
// Counselors (all three seats, same commit as this test). isLive returns
// false WITHOUT ever probing tmux whenever agent.status !== "running",
// so the FIRST version of this note claimed "this call found the pane
// already dead" here - false, since no probe ever happened, and this
// line proves it: the pane is still genuinely ALIVE, because nothing in
// this test ever killed it. The note must say it never checked, not
// that it checked and found the pane dead.
```

## line 77

```
// Real state, not just the receipt (test/CLAUDE.md's own rule: a receipt
// is the handler's claim about itself).
```

## line 81

```
// Cleanup: the pane this test deliberately left alive. Restore the row
// to 'running' (matching the pane's real state) so the real agent_close
// path - probe, kill, CAS - actually tears it down, rather than leaving
// an orphan for isolateTmux's own exit-time leak report to catch.
```

## line 89

```
// The lost-CAS branch above also carries a `report.parked` case for
// "already retired as a park" - but agent_close cannot reach it through
// this file's own pre-mutation trick the way the unparked case above does.
// findAgent(agent_id) reads the row ONCE, and agent_close's pre-existing
// "if (agent.status === 'closed' && agent.parked_at)" gate (the park
// ABANDONMENT path, tested below and in agent-park.test.mjs's own file)
// runs against that same read, before isLive or closeAgentRow are ever
// reached - so a row that is ALREADY closed+parked at the moment this call
// starts takes that path instead, correctly, and never reaches the CAS at
// all. The lost-CAS "parked" branch is only reachable through a genuine
// race (read running, kill, LOSE the write to a concurrent agent_park that
// completes in between) - the identical class of race
// test/close-agent-row-target-guard.test.mjs's own header explains has no
// hook to interject on through the live MCP surface. Its classification is
// pinned by construction instead, in test/lost-cas-report.test.mjs's
// "reads a closed row carrying a park stamp as retired AND parked".
```
