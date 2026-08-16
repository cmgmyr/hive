# Attic: src/tools/kv.ts

Comments removed from `src/tools/kv.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 22

```
// The only z.any() in the codebase, and DO NOT make it .optional().
// Issue #105: under zod 3 this emitted required: ["key"] while
// z.any() also accepted a missing `value` at runtime, so a kv_set with
// no value at all SUCCEEDED and stored the key with JSON null in it -
// measured, not inferred. zod 4 treats a bare z.any() in a required
// position as nonoptional and refuses that call (-32602, "expected
// nonoptional, received undefined at value"), and emits
// required: ["key", "value"] to match.
//
// THIS IS A BREAKING INPUT-CONTRACT CORRECTION, not free compatibility,
// and it is worth keeping anyway. An external caller written against
// the zod 3 schema could send {"key": "maintenance"} and now gets a
// -32602. `value: null` expresses the same intent and still succeeds,
// but that is a caller migration, not an automatic upgrade path. What
// makes the trade right is that the only call newly refused is the one
// that was storing nothing under a key that then read back as a real
// JSON null.
```
