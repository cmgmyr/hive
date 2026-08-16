# Attic: src/projectYml.ts

Comments removed from `src/projectYml.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 9

```
// hive.yml: minimal repo-controlled project config.
//
//   lead: claude --model opus      # optional command for the lead window
//   profile: orchestration         # standing instructions this project runs under
//   lead_branches: [main, master]  # branches where a lead gets the kickoff
//   dashboard: true                # write a generated, auto-refreshing HTML
//                                   # dashboard to .claude/dashboard/index.html.
//                                   # Default false; absent, null, and false
//                                   # all mean off.
//   vars:                          # substituted into the profile runbook
//     repo: owner/name
//   processes:
//     npm:dev: npm run dev         # shorthand form
//     queue:                       # expanded form
//       command: php artisan queue:work
//       dir: ./api                 # relative to the project root
//       auto_start: false          # default true
//       env:
//         APP_ENV: local
//
// Unknown keys are ignored, so configs copied from similar tools parse.
```

## line 42

```
// The profile whose standing instructions this project runs under.
// null means the key is absent ("never asked", so `hive init` may offer it);
// "none" means the human decided this project is runbook-pad only.
```

## line 46

```
// Branches where a lead session gets the kickoff. null means unset, and
// callers apply DEFAULT_LEAD_BRANCHES.
```

## line 49

```
// Whether the scheduler writes .claude/dashboard/index.html for this
// project. Always a concrete boolean, never null: absent, null, and false
// in the YAML all collapse to the same false here, so a caller never has
// to ask "is null falsy" the way profile's own null/none distinction
// requires - Chris asked for false to be the answer in every one of those
// cases, with no third state to carry.
```

## line 63

```
// The profile a project actually runs under, or null. Decoding the sentinel
// belongs next to it: every consumer that reads config.profile raw is one
// that can forget "none" is not a profile name.
```

## line 138

```
// != null covers both absent (undefined) and explicit `null` in one check,
// so neither has to be special-cased to reach the same false default -
// Chris called out `null` specifically as a case that must not slip
// through to a truthy path, and a `!= null` guard is the same guard that
// already keeps every other optional key here from acting on an absent
// one, not a new pattern invented for this key.
```

## line 209

```
// A command's trust is tied to everything that affects what it executes.
// Any change requires re-approval.
```

## line 217

```
// Repo-controlled working dirs must stay inside the project root.
```
