---
paths:
  - "src/profiles.ts"
---

# Profile files: any `.md`, one guard, three that stay required

## The filename guard is not optional

Any function that takes a filename and joins it into a profile directory
(`resolveProfileFile`, `readProfileFile`, `renderProfileFile`) must refuse
anything that is not a plain `<name>.md`: no path separator, no `..`, no
leading dot, no missing `.md` suffix. `isValidProfileFileName` is the one
place this is enforced. **Do not add a second call site that joins a filename
without going through it first.** CLAUDE.md's trust invariant already states
that `profile` cannot escape the profile directories; this is where that
would be lost.

## Rendering is at read time, never at fork or write time

One forked profile directory is resolved by multiple projects with different
`vars`. Baking a var at fork or write time hands one project another
project's values. Substitution only happens inside `renderProfileFile`,
called by whatever is reading the file for a specific project.

## A new conditional var needs its code deployed first

A profile file is live the moment it is committed; the code that sets a new
template var ships only on merge and server restart. In the window between,
the var is never set - and a presence-conditional has no else, so every
worker silently gets the block stripped, not an error. Merge and restart
before relying on a new conditional var in a profile file.

## `.md` only, no dotfiles

`.hive-origin.json` is hive's own metadata, not a profile artifact. Never
treat a dotfile as one.

## The three named files stay required and known; everything else is optional

`posture.md`, `runbook.md`, and `worker.md` are injected (`hive lead`,
`agent_spawn`) or checked for (`hive doctor` fails a profile with no readable
`runbook.md`). Any other `.md` present is resolved, rendered, and reported by
`hive doctor` and `hive profile list` / `hive profile read`, but it is never
required and never auto-injected anywhere. Do not make a stray `.md` become
something hive believes it must have.

## `worker.md` is excluded from doctor's unset-`{{var}}` scan, on purpose

Its identity vars (`agent_name`, `actor_id`, `project_name`, `cwd`, ...) are
per-spawn, supplied by `src/brief.ts` at spawn time. A project's `hive.yml`
`vars` merge into the same render too, with the reserved `harness_*` and
`agents_*` families stripped first (`mergedBriefVars`) so neither can flip
which conditional block a worker sees. Folding worker.md into the scan that
checks `hive.yml`'s `vars` against a profile's referenced vars would still
report every identity var as missing on every project.
`profileFileNames(name).filter((f) => f !== "worker.md")` is the shape to
keep.

## Do not build drift/divergence reporting for a file with no upstream

`profileStatus` compares a user copy against a shipped one by content hash. A
file that exists only in `~/.hive/profiles/<name>/` has no shipped
counterpart, so it correctly reports no divergence and no drift. That is not
a gap to close.

## A profile artifact is read through `hive profile read`, never by path

Anything consuming a profile file - a runbook line, a brief, a doc, an agent
following an instruction - must go through `hive profile read <file>`, which
resolves it against the reading project's profile and substitutes that
project's vars. Reading the path directly (`cat`, a Read tool, an editor)
returns the template with literal `{{braces}}` in it, and nothing in the
output says it was meant to be rendered. That failure is silent, which is
why it is a prohibition rather than a preference. The three named files have
their own commands (`hive runbook`, `hive posture`); every other artifact
uses `hive profile read`.

See `.claude/skills/hive-internals` for the mechanism and measurements behind
these.
