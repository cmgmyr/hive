# Attic: test/dashboard-yml.test.mjs

Comments removed from `test/dashboard-yml.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Chris's scope change, superseding plan-dashboard-v1's original
// directory-presence switch: hive.yml's `dashboard` key is now the enable
// gate for the dashboard lane (todos 308/309). Pure filesystem parsing, no
// tmux and no store, so this file needs neither isolateTmux nor
// HIVE_DATA_DIR the way test/layout.test.mjs (its structural sibling) does.
```

## line 29

```
// Called out by name in the scope change: null must not reach a truthy
// path. YAML's bare `dashboard:` (no value) parses to null, not to the
// key being absent, so this is a genuinely different case from the one
// above and needs its own assertion.
```

## line 51

```
// A test that only checked the boolean would still pass if the warning
// silently disappeared - the scope change calls this out by name.
```
