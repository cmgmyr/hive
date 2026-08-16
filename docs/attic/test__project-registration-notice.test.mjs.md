# Attic: test/project-registration-notice.test.mjs

Comments removed from `test/project-registration-notice.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Ad-hoc lane off pad 71 "tmux-placement-design". resolveHomeProject's
// registration fallback (src/context.ts) silently creates a project for a cwd
// no project covers, and run() (src/result.ts) used to say nothing about it.
// These tests drive a REAL MCP server over stdio against scratch state, not a
// helper: test/CLAUDE.md's false-green shape #4 and
// .claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md
// are both about a unit test whose inputs the real caller can never produce.
// mcp.request() is used directly here, not mcp.call(), because call() only
// ever reads content[0].text - exactly the thing this lane is pinning does
// NOT change - and the notice is a second block.
```
