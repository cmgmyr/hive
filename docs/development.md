# Development

```bash
npm run build    # compile to dist/
npm run watch    # compile on change
npm test         # run the suite against dist/ (build first)
```

Run `npm run check:mermaid` to render every Mermaid diagram in `README.md` and `docs/`.

The project `hive.yml` is gitignored, so a project's lead command, profile or
vars do not ship to anyone else. Copy `hive.example.yml` to `hive.yml` and edit
it; hive works without one, and every key in it is optional. Machine-wide
defaults live separately in `$HIVE_DATA_DIR/hive.yml`; see
[global defaults](configuration.md#global-defaults).

Tests use Node's built-in runner and exercise the real MCP server and CLI as child processes against scratch data directories. CI (`.github/workflows/ci.yml`) runs build plus tests on every pull request, on every push to `main`, on the Monday 08:42 UTC schedule, and on `workflow_dispatch`, covering both ubuntu and macOS legs plus a Mermaid docs check.

Smoke test without touching your real data:

```bash
HIVE_DATA_DIR=/tmp/hive-test node dist/index.js
# then speak JSON-RPC on stdin, or just register it with Claude Code
```

## Releasing

You cut a release with the `release` skill in `.agents/skills/release`. It gates on a local full suite, then tags with `np`.

The publish workflow (`.github/workflows/publish.yml`) runs on `v*` tags only and publishes with npm trusted publishing, so no token is stored. It also creates the GitHub release from the matching section in `CHANGELOG.md`. Nothing publishes on push or pull request.
