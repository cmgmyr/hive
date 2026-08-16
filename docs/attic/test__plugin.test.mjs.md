# Attic: test/plugin.test.mjs

Comments removed from `test/plugin.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 28

```
// The trap this plugin exists to avoid. ${CLAUDE_PLUGIN_ROOT} is the path
// the plugin was FOUND at, which for the documented symlink install is
// ~/.claude/skills/hive. node normalizes ".." lexically before touching
// the filesystem, so "<root>/../dist/kickoff.js" collapses to
// ~/.claude/skills/dist/kickoff.js and dies with MODULE_NOT_FOUND.
```

## line 48

```
// Exactly the documented install: a symlink whose target is the checkout.
// Running the shim through it is what proves the path resolution above.
```

## line 73

```
// The literal string the hook would have carried, unnormalized: node is
// what collapses it, not the kernel. `test -f` on this same path succeeds.
```
