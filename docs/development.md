# Development

```bash
npm run build    # compile to dist/
npm run watch    # compile on change
npm test         # run the suite against dist/ (build first)
```

`hive.yml` is gitignored, so nobody's lead command, profile or vars ship to
anyone else. Copy `hive.example.yml` to `hive.yml` and edit it; hive works
without one, and every key in it is optional.

Tests use Node's built-in runner and exercise the real MCP server and CLI as child processes against scratch data directories. CI (`.github/workflows/ci.yml`) runs build plus tests on the Monday 08:42 UTC schedule and on `workflow_dispatch` only, covering both ubuntu and macOS legs; it does not run on push or pull request, so a local full suite run is the merge gate.

Smoke test without touching your real data:

```bash
HIVE_DATA_DIR=/tmp/hive-test node dist/index.js
# then speak JSON-RPC on stdin, or just register it with Claude Code
```

## Releasing

You cut a release with the `release` skill in `.agents/skills/release`. It gates on a local full suite, then tags with `np`.

The publish workflow (`.github/workflows/publish.yml`) runs on `v*` tags only and publishes with npm trusted publishing, so no token is stored. It also creates the GitHub release from the matching section in `CHANGELOG.md`. Nothing publishes on push or pull request.
