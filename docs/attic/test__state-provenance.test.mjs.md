# Attic: test/state-provenance.test.mjs

Comments removed from `test/state-provenance.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// L1 (design-l1, issue #38/#28/#27's design pad). deriveProvenance() is the
// one place every surface reads a worker's state, its age and where it came
// from. No tmux is touched by this file: deriveProvenance takes liveness as a
// plain argument rather than probing, so this suite needs no isolateTmux().
```

## line 29

```
// now() is fixed to noon on an arbitrary day so age math never depends on the
// wall clock the test happens to run under; every timestamp below is written
// relative to it.
```

## line 64

```
// created_at is written explicitly (milliseconds format) rather than left to
// the column default, so ordering between rows in one test is deterministic
// instead of racing the real clock.
```

## line 72

```
// Fix round 1, item 4. Every row literal below now sets kind: "agent"
// explicitly. Before this round the gate was a lead-specific blocklist, so a
// literal with no `kind` at all happened to read as an ordinary agent by
// accident (undefined !== "lead"); that never represented a real row, since
// agents.kind is NOT NULL DEFAULT 'agent' (src/db.ts) and every row read
// from the table always has one. reportsAgentStateLog's allowlist takes that
// accident away, correctly, so these fixtures now say explicitly what they
// always meant.
```

## line 103

```
// Retention case: the latch survives, its own row does not.
```

## line 137

```
// Issue #27's L4 fix round, DECISION 4. A lead DOES get --settings and its
// hook DOES fire (unlike the non-claude case above), but src/hook.ts's
// agent_state UPDATE is scoped to kind = 'agent' (worker-state.md), so a
// lead's agent_state never leaves its 'unknown' default. Without the kind
// check, isClaudeCommand(row.command) alone cannot tell that apart from a
// genuinely fresh worker that just has not reported in yet - which is
// exactly what "no-record" means - so a lead used to read as a worker on
// the verge of its first report, forever, rather than one with no state
// channel at all, permanently, by design.
```

## line 162

```
// Fix round 2, item 2 (both counselors seats). Fix round 1, item 4's own
// regression test never seeded this row through deriveProvenance itself --
// reportsAgentStateLog's unit test above covers the predicate in
// isolation, this covers the gate that actually calls it. A kind='command'
// row (a hive.yml process started by `hive start`, src/cli.ts) running
// claude gets no HIVE_AGENT_ID and no --settings (src/spawn.ts), so it can
// never write a hook row, exactly like a lead -- before item 4 this fell
// through to "no-record" forever, "a claude worker that hasn't checked in
// yet", which is precisely the misreport DECISION 4 fixed for the lead.
```

## line 188

```
// agentSummary already collapses "gone" from the tmux probe into the same
// field a hook writes (src/tools/agents.ts:282); this is the guard against
// this module attributing that observation to the wrong witness.
```

## line 208

```
// Issue #24's fix: Stop fires while subagents are still running, so the
// latch stays "working" even though the row that explains it is a stop.
```

## line 228

```
// stateForNotification returns null for idle_prompt, so hook.ts logs the
// literal state "unchanged" (src/hook.ts's UNCHANGED sentinel) and leaves
// the latch on whatever a real event wrote earlier. The unchanged row must
// not be picked as the explaining row -- it explains nothing -- so the
// derivation must reach past it to the real prompt|working underneath.
```

## line 251

```
// The real state-writing row can be pruned while a LATER unchanged row for
// the same actor survives, because retention deletes by a global id span,
// not per actor. This must read as absent provenance, never as "notify"
// explaining a state it did not write.
```

## line 270

```
// TODO 373, COUNSELORS F3. deriveProvenance is what `hive status` and the
// SessionStart digest describe a worker with, and the digest is INJECTED
// into a fresh lead's context beside the instruction to triage it. So "idle
// for 3m" about a worker nobody has briefed is not a display nit: a model
// reads that sentence and proposes lanes off it.
```

## line 290

```
// The raw latch is UNCHANGED for any caller reading JSON: this reports a
// fact beside the state, it does not rewrite the state.
```

## line 299

```
// OMITTED, not `false`, for the ordinary row - these fields ride in every
// agent_list and agent_status receipt.
```

## line 306

```
// A partial row literal is a caller bug, and the safe reading of it is "no
// fact recorded" rather than "awaiting": this predicate only ever
// SUPPRESSES, so reading an accident as SET would go silent about a worker
// that really finished. Same shape as this file's own `kind` lesson above.
```

## line 327

```
// False-green shape 7 (test/CLAUDE.md): a fixture with only one state
// cannot prove this picks the last of several. Three rows here, three
// different events, so a function that returned the first, or a fixed
// index, or the row matching some other state, goes red.
```

## line 341

```
// Fix round 1, item 5c: `at` was asserted nowhere in this suite, so
// `at: row.created_at` -> `at: ""` survived the whole suite while still
// shipping in agent_list's payload. A caller with a wrong timestamp has
// no way to notice one that is never checked.
```

## line 349

```
// Never a fabricated age of zero: absence is its own answer, distinct
// from a fresh row at age 0.
```

## line 355

```
// A function that ignored actor_id (e.g. always returned MAX(id) across
// every actor) would pass every other test here by accident and only
// fail this one.
```

## line 368

```
// Two rows logged in the same millisecond must still resolve to the
// truly-later one. Ordering by created_at string alone (rather than id)
// would leave this nondeterministic and could return either row.
```

## line 386

```
// Unlike deriveProvenance (which must reach past an "unchanged" sentinel
// to find the row that actually explains the latch), this function
// reports whatever the log's own last row says, raw. Reaching past it
// here would be the wrong behaviour for THIS question.
```

## line 418

```
// worker-state.md: a lead's hook DOES insert into agent_state_log (its
// state UPDATE is what's scoped to kind='agent', not the log write) --
// this predicate is deliberately about #72's worker-liveness surface,
// not about whether a row physically exists in the table.
```

## line 433

```
// Fix round 2, item 2 (both counselors seats). Every command-row fixture
// anywhere in this suite before this test used a non-claude command, which
// is false under BOTH this allowlist and the OLD lead-only blocklist it
// replaced (fix round 1, item 4) -- so a mutant reverting to
// `isClaudeCommand(row.command) && row.kind !== "lead"` passed the whole
// suite. This is the one row shape that disagrees: a kind='command' row
// (a hive.yml process started by `hive start`) running claude itself.
```

## line 464

```
// The pin: a naive Date parse of "YYYY-MM-DD HH:MM:SS" reads as LOCAL time
// on most engines, which would be off by the machine's UTC offset -- zero
// on a UTC box, which is exactly the case that would hide this bug on CI.
// Comparing against a known instant catches it regardless of the runner's
// own timezone.
```
