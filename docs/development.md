# Development

```bash
npm run build    # compile to dist/
npm run watch    # compile on change
npm test         # run the suite against dist/ (build first)
```

Tests use Node's built-in runner and exercise the real MCP server and CLI as child processes against scratch data directories. CI (`.github/workflows/ci.yml`) runs build plus tests on macOS for every push and pull request.

Smoke test without touching your real data:

```bash
HIVE_DATA_DIR=/tmp/hive-test node dist/index.js
# then speak JSON-RPC on stdin, or just register it with Claude Code
```
