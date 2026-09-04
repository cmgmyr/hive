`CLAUDE.md` carries the prohibition (`profile` cannot escape the profile
directories). This file carries why, and what todo 339/454 measured while
widening resolution from three named files to any `.md` a profile carries.

## Why the widening was mostly free, and the guard was the whole risk

`ProfileFile` was a three-value TypeScript union (`"posture.md" |
"runbook.md" | "worker.md"`), not a filesystem rule. `resolveProfileFile`
already checked the user directory before the shipped one
(`src/profiles.ts:31-35`), so a file existing only in
`~/.hive/profiles/<name>/` resolved correctly and returned `source: "user"`
before this lane touched anything. Widening `resolveProfileFile` /
`readProfileFile` / `renderProfileFile` from `ProfileFile` to `string` is a
type change with no new filesystem behavior on its own.

What is new is that a filename now reaches `join(dir, name, file)` from
something that used to be a compile-time-checked literal. Proven RED first:
with the type widened and no filename check added,
`resolveProfileFile("orchestration", "../secret.md")` returned a resolved
path one directory above the profile's own, reading a file it should never
have reached. `isValidProfileFileName` (mirroring `isValidProfileName`'s
shape: `^[A-Za-z0-9][A-Za-z0-9._-]*\.md$` plus an explicit `!includes("..")`
check, since the character class alone admits a `..` that isn't at the
start or end) closed it; the same traversal attempt then resolved to `null`.

## `profileFileNames` is the one place "what's present" gets computed

`profileFileNames(name)` unions the shipped and user directories, keeps only
files passing `isValidProfileFileName`, and orders the three named files
first (in `PROFILE_FILES` order, which happens to already be alphabetical)
with any extras sorted after. `profileStatus`, `hive profile list`, `hive
doctor`'s renderedText scan, and `hive doctor`'s unset-var scan all iterate
this instead of the fixed `PROFILE_FILES` array now. That single function is
also what makes `profileStatus`'s existing divergence math correct for an
extra with no free code: an extra has no shipped counterpart, so
`contentHash(shippedPath)` is `null`, `divergence` stays `null`, and
`upstreamMoved` is `false` - "no drift to report," which is the exact
behavior wanted, arrived at because the extra simply never matches the
shipped-file lookups the existing loop already did.

## Why the unset-var scan pointedly does not iterate `profileFileNames` unfiltered

Doctor's referenced-vs-defined scan exists to catch a `{{var}}` that
`hive.yml`'s `vars` never sets. `worker.md` ships with `{{agent_name}}`,
`{{actor_id}}`, `{{project_name}}`, `{{project_path}}`, `{{cwd}}`, and
`{{install}}` - all supplied by `src/brief.ts` at spawn time from the
worker's own identity, never from `hive.yml`. Running the scan over
`profileFileNames(name)` unfiltered was tried and produces a false-positive
flood: every project using the shipped `worker.md` would report six vars as
"not set here" on every `hive doctor` run, because none of those six are
meant to live in `hive.yml` at all. The exclusion (`.filter((f) => f !==
"worker.md")`) was already implicit in the pre-widening code, which
hardcoded the scan to `["runbook.md", "posture.md"]`; the widening had to
carry that exclusion forward explicitly rather than drop it by iterating
everything.

## The pads/paths scan is deliberately not the same filter

`hive doctor`'s `referencedPads`/`referencedPaths` scan reads
`renderedText`, built from every file `profileFileNames(name)` returns,
`worker.md` included - unchanged from before this lane, when it was built
from all of `PROFILE_FILES`. A pad or path token inside `worker.md` is still
worth catching; it is the per-spawn *identity* vars specifically that don't
belong in the other scan, not `worker.md` as a whole.

## `hive doctor`'s referenced-but-missing check already covered extras for free

That check scans rendered prose for pad/path shapes rather than reading a
declared list, which is why it covers whatever text it is handed. Once an extra's rendered text is folded into `renderedText` (the
change above), the scan needs no changes of its own to catch a pad or path
referenced only by that extra - it was already reading whatever text it was
handed.

## The two design calls the lead made, and why

- `hive profile list` shows fork-only extras (source, path, no drift
  column) rather than hiding them from every surface but doctor. The
  alternative left `ls` as the only way to discover one, and doctor already
  knows they exist by the time list would need to.
- `hive profile read <file> [--profile <name>]` defaults to the *current
  project's* profile and vars rather than taking a profile name
  positionally the way `fork` and `path` do. It exists to be called from a
  runbook line, where the caller is a project, not a profile - matching how
  `hive runbook` and `hive posture` already default.

Both are cheap to reverse if that turns out wrong.

## A profile commit and its var-setting code deploy on different schedules, and todo 527 hit it live

`~/.hive/profiles/<name>/worker.md` is a plain file, read and rendered fresh
on every spawn - no build, no gate, live the instant it's committed. The code
that computes a NEW template var (`mergedBriefVars`, `src/brief.ts`) lives in
`dist/`, which only ships to a running MCP server on merge and restart. Todo
527 wrapped worker.md's review/CI steps in `<!--if:harness_claude-->` /
`<!--if:harness_codex-->` pairs and committed that to the profiles repo
before its matching `src/tools/agents.ts`/`src/brief.ts` change had merged.

MEASURED, not theorized: the lead spawned a real codex worker (agent 381)
against the still-unmerged branch and read its generated
`CODEX_HOME/config.toml` directly. `developer_instructions` carried worker.md
with BOTH of its harness-conditional blocks stripped - a grep for a marker
unique to each one returned nothing. The running server's `dist/brief.js` had
no `mergedBriefVars` (`grep -c mergedBriefVars dist/brief.js` on `main` was
`0`), so no `harness_claude`/`harness_codex` var was ever set on that spawn,
and `renderConditionals`'s presence check (`src/profiles.ts`) has no else:
every `<!--if:...-->` block with an unset var is silently omitted. Same
symptom class `harnessBriefVars`'s claude-default was built to prevent (an
unrecognised harness getting neither block), arriving through a route
neither the design nor the review pass had considered - a deploy-order gap,
not a harness-identity gap - and it degrades a CLAUDE worker's brief too,
since the OLD server also fails to set harness_claude for a claude spawn.

REJECTED FIX, so it isn't re-proposed: leave the claude side of a new pair
unwrapped and wrap only the new (codex) branch. That protects an old
server's CLAUDE workers (unwrapped text always renders) but breaks CODEX
under an old server the same way - the unwrapped claude text renders for
codex too, since there is no "unless" conditional, only presence. Both sides
of a new pair must stay wrapped together; the fix is sequencing the deploy,
not asymmetric wrapping.

THE OPEN WINDOW IS OPERATIONAL, NOT STRUCTURAL: it lasts from the profile
commit until the matching code is merged and the server restarts, and it is
whoever holds that merge's job to close, not a runtime guard's. See
`.claude/rules/profile-files.md`'s "A new conditional var needs its code
deployed first" for the prohibition this earns.

SINCE TODO 787, `developer_instructions` CAN CARRY A SECOND SECTION AFTER
worker.md: when the primary checkout has an `AGENTS.local.md` or
`CLAUDE.local.md` (first found wins), `ensureCodexHome` appends it under a
heading naming the file's absolute path. A grep for worker.md's own markers
inside `developer_instructions`, as the incident above does, still finds
them - the append happens after the rendered brief, never in place of it -
but a reader diffing `developer_instructions` against worker.md alone should
expect a trailing section this file's rendering never produces.
