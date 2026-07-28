// SessionStart entry point for the plugin.
//
// Why this file exists instead of pointing the hook straight at
// "${CLAUDE_PLUGIN_ROOT}/../dist/kickoff.js": ${CLAUDE_PLUGIN_ROOT} is the
// path the plugin was FOUND at, which for the documented install is the
// symlink ~/.claude/skills/hive, not the checkout. node normalizes ".."
// lexically before it touches the filesystem, so that path collapses to
// ~/.claude/skills/dist/kickoff.js and fails with MODULE_NOT_FOUND. (The
// kernel would have resolved it; node does not ask it to. Verified against
// Claude Code 2.1.220 and node 24.)
//
// A path with no ".." in it has nothing to collapse, so the symlink resolves
// normally, and node realpaths the main entry -- which puts import.meta.url
// on the real file inside the checkout and makes this relative import land in
// the real dist/. That keeps the live-pointer property: git pull && npm run
// build upgrades the hook with everything else, and no absolute path is ever
// written into a committed file.
const { runKickoff } = await import("../dist/kickoff.js");
await runKickoff(process.argv.slice(2));
