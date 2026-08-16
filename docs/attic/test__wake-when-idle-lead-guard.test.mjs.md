# Attic: test/wake-when-idle-lead-guard.test.mjs

Comments removed from `test/wake-when-idle-lead-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #27's L4 fix round, DECISION 4. A lead has no idle/working state
// channel: its hook writes only agent_state_log, never agents.agent_state
// (worker-state.md, src/hook.ts's UPDATE is scoped to kind = 'agent'). Before
// this guard, wake_when_idle(agents:["lead"]) would silently degrade to
// firing only at max_wait_seconds, reported as "max wait reached" - a loud,
// immediate error turned into exactly the silent failure this lane exists to
// remove. wake_when_idle now refuses a lead target before scheduling anything.
```

## line 41

```
// Not /lead/i: resolveDelivery's own "not running inside tmux" error also
// contains the word "lead" ("Start the lead inside tmux..."), and this
// guard's whole point is to fire BEFORE resolveDelivery runs at all - a
// loose pattern would pass on that unrelated error and never notice the
// real refusal was missing. deliver_to is passed explicitly for the same
// reason: it keeps resolveDelivery from ever being reached, so a failure
// here can only be this guard.
```
