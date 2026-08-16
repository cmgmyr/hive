# Attic: test/transcript-field.test.mjs

Comments removed from `test/transcript-field.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #5, todo 90: agent_status and agent_list wiring for the transcript
// directory. Pure encoding and existence gating are pinned in
// transcript.test.mjs with no server involved; this file pins the policy
// choices layered on top -- D2 (agent_status always reports it for a claude
// worker), D3 (agent_list only for a row that is not confirmed alive), and D4
// (never for a non-claude command) -- against the real tools.
```

## line 16

```
// sessionName tags itself from HIVE_DATA_DIR, so the test process has to
// resolve the same store the server does to name the session cleanup targets.
```

## line 22

```
// A private CLAUDE_CONFIG_DIR for this file, so the assertions below do not
// depend on (or risk misreading) whatever the real ~/.claude/projects holds.
```

## line 27

```
// One real directory a worker can be spawned into, with its transcript
// directory pre-created under the scratch config dir, so the "found it" path
// is tested against an actual resolved value, not just presence of the key.
```
