# Attic: src/strictInput.ts

Comments removed from `src/strictInput.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 4

```
// WHY EVERY TOOL'S INPUT IS PARSED STRICTLY, AND WHY THE CHANGE LIVES HERE
// RATHER THAN AT THE 42 CALL SITES.
//
// PR #123 found this: zod strips an unknown key
// silently, so `pad_delete({pad_id: 7, expected_revison: 3})` - one letter
// wrong - arrives at the handler as `{pad_id: 7}`. That is the SAME call a
// caller who deliberately omitted the guard makes, `checkRevision` returns
// without checking, and the pad is permanently deleted while the tool's own
// description promises the caller is guarded. The typo and the deliberate
// omission are indistinguishable, which is what makes it worth refusing.
//
// A raw shape (`inputSchema: { pad_id: idParam, ... }`) becomes a LOOSE object:
// the SDK's server/zod-compat.js objectFromShape always calls z.object, and
// takes no strictness parameter. A BUILT strict object reaches both halves of
// the wire at once, because mcp.js stores whatever getZodSchemaObject returns
// and both consumers - the tools/list emission and validateToolInput - read
// that same stored object. Measured at SDK 1.30.0 / zod 4.4.3:
//   raw shape       tools/list: no additionalProperties
//                   the typo above: SUCCEEDS, key silently stripped
//   z.strictObject  tools/list: "additionalProperties": false
//                   the typo above: isError, "MCP error -32602: Input
//                     validation error: Invalid arguments for tool pad_delete:
//                     Unrecognized key: \"expected_revison\""
// So the advertised schema and the runtime stop disagreeing, which is the
// state issue #105 found and removed for being dishonest in the other
// direction (it advertised strictness nothing enforced).
//
// THE SERVER IS THE CHOKE POINT, NOT THE CALL SITE. 42 registerTool calls
// across eight files in src/tools/ each pass a raw shape. Sweeping them works
// today and fails on the 43rd tool, which is exactly
// .claude/sessions/common-issues/a-fix-applied-to-only-some-call-sites.md -
// and its own prescription is to prefer the choke point where one exists. One
// exists: src/index.ts builds one McpServer and hands it to eight register
// functions. Wrapping registerTool there means a new tool is strict without
// its author doing anything, and test/wire-surface.test.mjs asserts
// additionalProperties over the GENERATED surface so a tool that escaped this
// fails there rather than relying on anyone reading this comment.
//
// "WITHOUT ITS AUTHOR DOING ANYTHING" IS TRUE OF registerTool, WHICH IS THE
// ONLY REGISTRATION PATH HIVE USES. SDK 1.30.0 still ships two others that go
// around it: the deprecated `server.tool(name, shape, cb)`, which calls
// _createRegisteredTool directly, and RegisteredTool.update({paramsSchema}),
// which re-derives a LOOSE object through objectFromShape. Nothing in hive
// calls either. A tool registered the deprecated way still fails the
// wire-surface assertion, so that half is caught; update() is covered by
// nothing, which is a reason not to reach for it rather than a reason to widen
// this wrapper to chase two paths no call site uses.
//
// PER-TOOL PERMISSIVENESS AUDIT, 2026-08-07. THE AUDIT RAN AND
// FOUND NONE: no tool in the surface has a reason to accept a key it does not
// declare, so there is no exemption list rather than an exemption list nobody
// filled in. A tool would need one only if it FORWARDED its arguments
// somewhere - a proxy or a pass-through - and three checks say none does.
// BOTH GREPS ARE SCOPED TO src/tools/, which is where handlers live, and the
// counts below are for that scope only. This audit is written to be RE-RUN, so
// the scope is part of the evidence:
//   grep -rnE "\.\.\.args|args\[|Object\.keys\(args\)|Object\.entries\(args\)" src/tools/
//     1 hit: `...args.keys` in agent_send, spreading a DECLARED array
//     parameter into tmux send-keys, not reading an undeclared one.
//   grep -rnE "z\.record\(|passthrough|catchall|z\.unknown\(" src/tools/
//     0 hits.
//   every handler destructures or reads named fields off `args`
// DO NOT WRITE DOWN A COUNT FOR EITHER GREP OVER ALL OF src/, and this is the
// reason rather than a preference: THIS COMMENT CONTAINS BOTH PATTERNS AS
// TEXT, so a src/-wide run MATCHES THIS FILE - three of its own lines - and
// every future edit here moves the number again. A version of this comment did
// write those counts down and both were already wrong, in OPPOSITE directions,
// because the two were measured at different edit states of the file being
// counted. Qualitatively the wider run adds cli.ts's argv, mcpConfig.ts's
// rendered command string, tmux.ts's rest parameters, tmux's own
// `allow-passthrough` option, and this comment. None is zod, and none is a
// handler.
//
// The four zero-parameter tools (whoami, project_list, project_prune,
// actor_prune) are strict too, deliberately: they declare `inputSchema: {}`,
// which the SDK treats as a raw shape, so they already went through an object
// parse and already refused a `tools/call` carrying no `arguments` key at all
// (-32602, measured before this change). Strictness costs them nothing new.
//
// THE ONE PLACE ARBITRARY KEYS STILL REACH A HANDLER, and it is not an
// exception to any of the above: `kv_set.value` is `z.any()`, so the object a
// caller stores under a key may carry whatever it likes. Those keys are INSIDE
// a declared parameter rather than beside it, which is the whole point of the
// tool. Strictness is a property of ONE object level and does not reach in.
// No tool DECLARES a nested object parameter as of this change - `grep -rnE
// "z\.object\(" src/tools/` returns 0, scoped for the same reason as the audit
// greps above, and the only composites in the surface are arrays and unions of
// primitives - so a future nested object parameter must be declared with
// z.strictObject where it is written. This interceptor cannot reach into a shape's values
// without rebuilding schemas it did not author. That is not left to this
// comment: test/wire-surface.test.mjs WALKS the generated surface and requires
// additionalProperties: false on every object node in it, nested ones
// included, so a z.object parameter fails there with its path named.
//
// ACCEPTED RESIDUAL, decided deliberately. Strict parsing costs
// hive a backward compatibility it had for free: a server running older dist
// used to IGNORE a newly added optional parameter, and now REFUSES the call.
// An MCP server loads dist once at session start, so the session that merges a
// lane adding a tool parameter keeps running the old code and will be refused
// until it restarts - see
// .claude/sessions/common-issues/stale-mcp-server-runs-old-code.md. Bounded by
// one restart, and loud (-32602 naming the key) rather than silent, which is
// the trade: it is the quiet half of this pair that was doing the damage.
```

## line 108

```
// Structural detection, matching how the SDK's own zod-compat.js recognises a
// schema, rather than `instanceof z.ZodType`: that is narrower (it misses a
// zod-mini or zod 3 instance from another physical copy) and this is a refusal
// guard, where over-catching is the safe direction.
//
// IT TESTS THE CONTAINER, so a raw shape with a PARAMETER NAMED `_def` or
// `_zod` is refused as though it were a built schema. That is a naming
// constraint on tool parameters, not a bug to work around with cleverer
// detection: the failure is loud, at startup, with a message naming the tool,
// and no parameter in this surface is plausibly named either. It is in
// .claude/rules/tool-contract.md too, where parameter naming belongs.
```

## line 123

```
// The three cases, each decided rather than defaulted:
//   absent      - the tool declares no parameters at all. The SDK skips
//                 validation entirely and calls the handler with (extra) alone,
//                 so synthesising a schema here would change that handler's
//                 arity. Nothing declared means nothing to be strict about.
//   raw shape   - the convention, and all 42 tools today. Built strict.
//   built schema- refused. A caller who builds their own schema has taken the
//                 strictness decision out of this file's hands, and silently
//                 accepting a loose one is how the guarantee above stops being
//                 true without anything failing. Converting instead is worse,
//                 not kinder: a built schema may be a union or a wrapped type
//                 with no strict form, so "convert" means either a partial
//                 conversion that quietly gives up on the shapes it does not
//                 recognise, or overriding a decision its author made on
//                 purpose. Registration runs at startup, so this throws before
//                 the server can serve a single call.
//
// WHAT THAT THROW ACTUALLY TAKES DOWN, since "it fails at startup" undersells
// it. src/index.ts calls startScheduler() AFTER the register functions, so an
// instance that throws here never starts its scheduler: that session's
// wake-ups never fire, and nothing in the store records why. The `hive` CLI
// keeps working, because it never imports index.ts - which is the bad part
// rather than a consolation, since the machine looks healthy from the
// terminal. It is still the right failure: the alternative is a server that
// serves a tool whose input nothing checks. Just do not read a silent lack of
// wake-ups as a scheduler bug without checking whether this threw.
```

## line 161

```
// Returns the same server, so src/index.ts can wrap the constructor call and
// leave no name for an unwrapped one. The ordering constraint - this must run
// before any register function - is then unexpressible rather than merely
// documented.
//
// Mutating the instance rather than returning a Proxy is deliberate: a Proxy
// would re-bind `this` for every method on McpServer to change exactly one.
// The cast is on the assignment only, so the wrapper's own parameters are
// contextually typed from the SDK's signature and an arity change upstream
// still fails to compile here.
```
