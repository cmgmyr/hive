import { z } from "zod";

// WHY EVERY INTEGER PARAMETER IN THIS SURFACE CARRIES AN EXPLICIT LOWER BOUND,
// and why a new one that does not is a bug rather than a style choice.
//
// zod 4 (issue #105 lane C) emits a bound for every `z.number().int()`. A bare
// one emits minimum: -9007199254740991 AND maximum: 9007199254740991. Only the
// MAXIMUM is a fact about the tool: past Number.MAX_SAFE_INTEGER a JSON integer
// stops round-tripping through a double, so 9007199254740993 arrives as ...992,
// and refusing it is right for every field.
//
// THE MINIMUM IS NOT A FACT ABOUT ANY TOOL HERE. It is the same fact about
// doubles, mirrored, and no parameter in this surface has a valid negative
// value - they are all ids, counts, offsets, revisions, delays and line counts.
// zod 3 emitted a bare {"type": "integer"} and claimed nothing about sign;
// zod 4 turned that silence into an ADVERTISEMENT that the negative half is
// in-contract, and it is not. Measured, before this was fixed:
//   agent_output({lines: -5})  schema says valid; Math.min(-5, 200) is -5, and
//     `tmux capture-pane -S "--5"` is rejected by tmux. The tool errors on
//     input its own schema calls valid.
//   pad_list({offset: -1})     schema says valid; rows.slice(-1, 49) silently
//     returns the LAST row and the receipt echoes offset: -1.
// So `.positive()`, `.nonnegative()`, or a real domain bound goes on every
// integer parameter, and the emitted schema stops advertising a half-range no
// handler accepts. `.positive()` emits exclusiveMinimum: 0 and keeps the honest
// maximum; `.nonnegative()` emits minimum: 0.
//
// AN UPPER BOUND GOES ON ONLY WHERE A DESCRIPTION ALREADY STATES ONE, so the
// two halves of the wire stop contradicting each other - agent_send.wait_ms
// says "(250-10000)" in its description and agent_output.lines says "max 200".
// Inventing a cap for a field whose description promises none would be writing
// a new contract under cover of fixing an old one; pad_list's undocumented
// internal clamp at 200 is deliberately left unadvertised.
//
// test/wire-surface.test.mjs asserts over the GENERATED surface that no integer
// schema admits a negative, so a new tool declaring a bare z.number().int()
// fails there rather than relying on anyone reading this comment. That
// assertion is the guard; this comment is the reason.

// A row id: SQLite rowids start at 1, so zero and below can never address a
// row. Shared so a new tool's id parameter cannot arrive without the bound -
// see .claude/sessions/common-issues/a-fix-applied-to-only-some-call-sites.md,
// which is about exactly this shape across 42 tools. Deriving a per-site
// description with .describe() does not mutate this base: zod 4 registers
// metadata per schema instance, verified rather than assumed.
export const idParam = z.number().int().positive();

// Shared across every project-scoped tool; the description carries scope
// policy, so it must not drift between tools.
export const projectIdParam = idParam
  .optional()
  .describe(
    "Different project override. Use ONLY when the user explicitly asks for another project by name; otherwise stay in the current scope, even when results are empty.",
  );

// The preferred way to address a worker, so it is listed first everywhere and
// described the same way everywhere. Ids still work; they are just not the
// handle a human remembers.
export const agentNameParam = z
  .string()
  .optional()
  .describe(
    "The worker's name, e.g. \"impl\" or \"DEVX-123\". Preferred over agent_id. A partial name works when it matches exactly one running worker, so \"123\" finds DEVX-123.",
  );

export const agentIdParam = idParam
  .optional()
  .describe("Numeric agent id. Use name instead unless you have the id to hand.");

// A page size. Positive because a limit of zero asks for nothing; no upper
// bound, because no list tool's description advertises one (each clamps
// internally at 200, which is an implementation detail, not a promise).
export const limitParam = z.number().int().positive().optional();

// A page offset. Zero is the first page and is the default, so this is
// nonnegative rather than positive.
export const offsetParam = z.number().int().nonnegative().optional();
