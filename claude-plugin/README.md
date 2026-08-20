# hive plugin

Registers one SessionStart hook. When you open a session in a hive project's
root, on a lead branch, with a profile hive can resolve, it injects the
project's live state (board pad, in-flight and dispatchable todos, running
workers, pending wake-ups) and asks the lead to run triage. Everywhere else it
prints nothing.

The gates live in `hive kickoff`, not here, so they upgrade with the binary
instead of going stale in a copied script. Run `hive kickoff --explain` in any
directory to see what it decided and why.

## Install

```
ln -s <checkout>/claude-plugin ~/.claude/skills/hive
```

That is the whole install. A folder under a skills directory holding
`.claude-plugin/plugin.json` loads as a plugin on the next session, discovered
in place rather than copied, so `git pull && npm run build` upgrades the hook
along with the rest of hive. `rm ~/.claude/skills/hive` uninstalls it.

The hook lives here, and so does a skill (`skills/cleanup`, `/hive:cleanup`).
hive's posture and worker briefs still travel as command-line flags from
`hive lead` and `agent_spawn`, because a plugin has no way to ship always-on
instructions: plugin `CLAUDE.md` is not loaded as context, and the one
always-on mechanism a plugin has, a `force-for-plugin` output style, would
override whatever output style you have selected - hive must never do that. A
skill is not always-on, which is exactly why it is fine here where an output
style is not: it costs nothing on a session that never matches it, and it
overrides nothing the user chose. It only acts when its own description
matches the moment, the same as any other skill.

## Why kickoff.mjs exists

`${CLAUDE_PLUGIN_ROOT}` is the path the plugin was found at. For the install
above that is the symlink, `~/.claude/skills/hive`, not the checkout. node
normalizes `..` lexically before touching the filesystem, so a hook command of
`node "${CLAUDE_PLUGIN_ROOT}"/../dist/kickoff.js` collapses to
`~/.claude/skills/dist/kickoff.js` and fails with MODULE_NOT_FOUND, even
though the kernel would have resolved that same path fine.

`kickoff.mjs` sidesteps it. The hook command has no `..` in it, so the symlink
resolves normally; node then realpaths the main entry, which puts the shim's
own `../dist/kickoff.js` import inside the real checkout. No absolute machine
path is ever written into a committed file.
