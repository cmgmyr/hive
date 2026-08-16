# Attic: test/agent-close-lead-guard.test.mjs

Comments removed from `test/agent-close-lead-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// PR #68 review gate finding, verified against the code. Issue #27 gave the
// lead a real agents row, which makes it a valid target for every generic
// agent_* tool: findAgent (src/tools/agents.ts) selects any RUNNING row in
// the project by name, with no kind filter. Before this lane that lookup
// simply found nothing for "lead". confirm_self does not help here either -
// it only fires when the CALLER is closing itself (agent.actor_id ===
// currentActor()), not when one actor closes a DIFFERENT one. So any worker
// could call agent_close({name: "lead"}) and silently end the one session
// with no supervisor above it.
//
// agent_send, agent_output and agent_status stay open on a lead:
// addressability is the point of #27's design (issue #27's L4 fix round,
// DECISION 4 - counselors recommended a blanket kind='agent' filter in
// findAgent and the lead rejected it for exactly this reason). Only the
// verbs that are DESTRUCTIVE or NONSENSICAL for a lead are refused:
// agent_close here, agent_rename (test/agent-rename-lead-guard.test.mjs) and
// wake_when_idle (test/wake-when-idle-lead-guard.test.mjs) elsewhere.
//
// Issue #27's L4 fix round R9, todo 176 item 2. agent_close used to refuse
// ANY lead target outright, unconditionally - which is why this file used
// to seed every lead row with a target no server has ever heard of
// ('%not-a-real-pane') and expect a refusal regardless. That target now
// reads as CONFIRMED DEAD (a real tmux server answers "can't find pane",
// not "unreachable"), which is exactly the new retirement path, so the
// refusal tests below need a genuinely LIVE pane instead: a lead row is
// immortal otherwise (the janitor exempts kind='lead', DECISION 3, and
// nothing else can ever close one), which is what made `hive restore`
// latch shut permanently on any store that ever ran a lead (todo 165, then
// todo 176's own finding after R8's liveness-probing attempt). The refusal
// itself is unchanged in spirit: nothing supervises a LIVE lead, so ending
// its session has to be a decision made from its own terminal.
```

## line 64

```
// idx_agents_running_name allows only one RUNNING "lead" per project, and
// each test's own seeded row survives a refused close (it must still be
// running) - so the next test's seed has to clear the last one first,
// rather than colliding with it.
```

## line 72

```
// A target no real tmux server has ever heard of: list-panes answers
// "can't find pane", which reads as CONFIRMED dead, not unreachable -
// exactly the state the new retirement path exists for.
```

## line 85

```
// A genuinely live pane, so agent_close's own probe finds it alive - the
// still-refused case. One shared session across this describe block's
// "live" tests; each seeds a fresh row against whatever pane currently
// exists there.
```

## line 116

```
// Issue #27's L4 fix round R10, todo 182 item 3 (opus F6). /lead.*live/
// also matches probeFailed's "tmux could not be probed, so liveness is
// unknown" - a null probe leaves the row running and the pane alive
// too, so the other two assertions below would still pass, making the
// whole test vacuous under exactly the flake (a failed probe) it exists
// to catch. /still live/ pins the actual refusal text and costs
// nothing.
```

## line 142

```
// Same fix as the test above: /still live/, not /lead.*live/, which
// also matches probeFailed's "liveness is unknown" text.
```

## line 166

```
// Issue #27's L4 fix round R10, todo 182 item 3 (opus). findAgent's
// closed-row message used to say "Spawn a new worker" unconditionally -
// impossible advice for a retired LEAD, since "lead" stays reserved
// (isReservedAgentName) and agent_spawn refuses it outright. Newly
// reachable at all because todo 176 let agent_close retire a
// confirmed-dead lead in the first place; before that a lead row could
// never be closed, so this branch could never see one.
```

## line 182

```
// No fake claude needed: a plain command is enough to prove agent_close's
// normal path still works once a kind check sits in front of it.
```

## line 197

```
// Issue #27's L4 fix round R10, todo 180. Before the fix targetLive('')
// read TRUE (tmux resolves an empty target to the caller's own current
// session rather than erroring), so a '' lead row read as live forever:
// this exact close would have hit the "pane is still live" refusal
// instead, and the row would have been immortal - defeating todo 176's
// whole retirement path.
//
// A real session has to exist for that old bug to bite at all - "no
// server running" already answered false honestly, even before this
// fix. spawnLivePane stands in for some OTHER live agent sharing the
// server, so this test cannot pass by accident just because nothing is
// running.
```

## line 237

```
// Issue #27's L4 fix round R10, todo 180's second consequence. Before
// the fix, isLive('') read TRUE, so agent_close's kill branch ran `tmux
// kill-pane -t ''` against a row that was never aimed at any real pane -
// and an empty target resolves to whichever window tmux considers
// CURRENT for the session, not to any specific row. Reproduced on this
// file's own isolated scratch server, never the real one: agent_spawn's
// own window claims "current" first, then a second window (the
// "bystander", standing in for some other live agent) takes it over -
// the exact position a buggy kill-pane -t '' would reach instead of the
// row it was actually aimed at.
```

## line 267

```
// Simulate the row losing track of its own pane (the shape a lost CAS
// or a stale row leaves): overwrite tmux_target to '' directly, the
// same value ensureLeadRow (src/cli.ts) seeds a fresh row with.
```

## line 292

```
// Issue #27's L4 fix round R10, todo 181 item 1 (BOTH SEATS). R9's own
// residual text asserted "closing this one deliberately (a human choosing
// to run agent_close)" as if that were already enforced. It was not:
// nothing checked the caller, so a WORKER could retire a lead exactly like
// a human at a terminal. Every test above in this file runs as the default
// McpClient, which sets no HIVE_AGENT_ID and so is a `user:<name>` (human)
// caller - these tests are the ones that actually exercise the new gate.
```

## line 345

```
// A different actor id than seedDeadLeadRow's own ('lead:999'), or this
// would exercise confirm_self instead of the guard under test.
```
