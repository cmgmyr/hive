# Attic: test/lost-cas-report.test.mjs

Comments removed from `test/lost-cas-report.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Todo 369. classifyLostCas (src/tools/agents.ts) is the shared classifier
// agent_close and agent_park both call after their own kill-then-CAS loses
// the write: it turns the row read AFTER the loss into one of exactly two
// facts (no third `status` value exists - schema CHECK, src/db.ts) - already
// retired by someone else (parked or not), or running again on a fresh pane.
//
// Pure and exported for exactly this reason: the "running again" case is a
// genuine race between findAgent's SELECT and the write, and
// test/close-agent-row-target-guard.test.mjs's own header already explains
// why that race has no reliable hook to interject on through the live MCP
// surface. This pins the classification by construction instead - the
// integration tests in test/agent-close-honest-cas.test.mjs and
// test/agent-park.test.mjs cover the "already retired" half end-to-end,
// where a pre-mutated row is reachable through the real tool.
```

## line 37

```
// parked_at is cleared in the SAME statement that flips a row back to
// running (resumeAgent's own CAS, src/spawn.ts) - never observable
// alongside status='running' in the real store - but the classifier is
// keyed on status alone, not on parked_at, so a row that somehow carried
// both must still read as revived rather than as a parked retirement.
```
