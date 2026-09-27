# Interview design

Read this before asking a follow-up question, choosing a write target, or
writing `hive.yml`. It is a reference for `SKILL.md`, not a second skill:
everything here is optional detail behind the five rules in that file.

## 1. Discovery topics and openers

Start with the work, not with profile structure: "Tell me about a recent
task you did with an agent - what happened from start to finish?" Follow
the answer into current agent use, handoffs, checking, review, and
permissions, and into what already works. Ask "Where do you spend effort
repeating yourself or correcting the agent?" and "What would you want to
keep exactly as it is?" only if the first answer did not already establish
them.

For an edit, open with "What should change, and what should stay?" and read
the selected profile and this project's `hive.yml` first, so you never ask
about a fact already on record. Do not reopen a rule the user did not
mention.

**Budget:** at most six discovery questions before summarising what you
know; one focused question at a time, since a detailed initial answer may
need none of the rest. After that summary, at most three targeted
follow-ups toward one draft. Anything past that is optional, offered in a
user-chosen batch of up to three questions, never an automatic loop. An
unknown optional preference is left out of the draft, never filled with
invented policy. A missing target, an unclear edit boundary, or an unknown
required check is stated in the summary and resolved before any dependent
write. A project with no automated checks gets an explicit manual
verification step written into its profile instead of an assumed command.

## 2. Signals for each route

**Simple** fits one active agent, sequential tasks, the user directly
controlling the work, or a case where coordinating several sessions would
cost more than it saves. **Orchestration** fits someone who already
delegates, needs independent work to run in parallel, or names a concrete
coordination problem they are trying to solve. Treat both as signals to
weigh, never as a rule to apply mechanically.

Summarise your recommendation with one reason tied to what the user said,
and offer the other route without framing it as an upgrade or a downgrade.
No stated preference means recommend simple, as the smaller thing to start
from, while noting delegation is available later through an edit. If
different kinds of project the user described need conflicting policies,
offer separate profiles for them; do not offer several profiles just
because both bases exist. Share discovery once, then confirm each profile's
own differences and its selection separately.

## 3. Optional follow-up map

Every row below is optional. A row with no answer signal in what the user
already said produces no question and no policy - it is not a form to
complete. "Neutral default" is what to propose when the user has no
preference of their own; never treat it as house style to recommend.

| # | Dimension | Answer signal | Optional question | Neutral default | Destination |
|---|---|---|---|---|---|
| 01 | Responsibility | Several sessions, or repeated supervision. | Who should coordinate work, and who answers a blocked session? | Keep your current responsibility split. | posture.md, worker.md |
| 02 | Coordinator edits | The user already delegates changes. | Should the coordinating session make any commits itself? | Keep your existing boundary. | posture.md |
| 03 | Work categories | The user describes several kinds of task. | Which tasks need code, a document, or only a decision? | Use only the categories the user named. | runbook.md |
| 04 | Plan approval | The user wants delegation. | When should you approve a plan before it is assigned? | Confirm scope before assigning work. | runbook.md |
| 05 | Plan fidelity | Unexpected findings interrupt work in progress. | Can a session change its approach on its own, or should it bring the choice back to you? | Ask on a material approach change. | runbook.md, worker.md |
| 06 | Assignment detail | Repeated instructions are painful to write. | What must every assignment contain, and what is already standing policy? | Goal, files, checks, and the evidence that counts as done. | runbook.md, worker.md |
| 07 | Preparation order | Overlapping branches run at once. | When do you prepare a branch and its dependencies? | Prepare immediately before work starts. | runbook.md |
| 08 | Checkout location | The user already has a convention. | Where do you keep temporary checkouts? | Keep the user's current location. | hive.yml vars, runbook.md |
| 09 | Push ownership | A remote is in use. | Who may push a completed branch, and when? | Keep the user's existing permission policy. | posture.md, worker.md |
| 10 | Request state | Pull requests are in use. | Do you want a draft while checks run, or a ready request after review? | Use the user's present practice. | runbook.md |
| 11 | Merge authority | Merge friction comes up. | Who approves merging, and may that approval be reused across changes? | Require the user's own merge instruction each time. | posture.md, runbook.md |
| 12 | Completion definition | The user describes what "done" means to them. | What evidence makes a change finished for you? | Checks, plus the outcome the user named. | runbook.md, worker.md |
| 13 | External actions | Sessions touch issue trackers or review tools. | Which external actions are already authorised, and which need your say each time? | Retain current permissions; assume none beyond what was stated. | posture.md, worker.md |
| 14 | Tracking systems | A tracker is already in use. | Where is work recorded, and who updates each system? | hive's own records plus whatever the user already uses. | hive.yml vars, runbook.md |
| 15 | Check commands | The user names existing checks. | Which command proves this project is ready, and which covers just a small change? | Use the commands the user already runs and can name. | hive.yml vars |
| 16 | Suite coordination | Parallel checks would contend for a resource. | Do simultaneous checks share a database, port, or other resource? | Serialise only the resource that is genuinely shared. | runbook.md, worker.md |
| 17 | Automation cadence | Automated checks are already scheduled. | When do checks run, and what stands in for them when none exist? | Keep the project's current cadence. | hive.yml vars, runbook.md |
| 18 | Review location | Review already happens somewhere useful. | Where does your useful review happen today? | Preserve the review that is already useful to the user. | runbook.md |
| 19 | Review selection | Review cost or coverage is a stated problem. | What review do you want for routine work, and what for a consequential change? | Only tools the user actually has and chooses. | hive.yml vars, runbook.md |
| 20 | Review decisions | Review feedback feels noisy. | What makes a finding worth acting on, and who decides? | A concrete failure or a broken requirement. | runbook.md |
| 21 | Review budget | Review passes repeat without concluding. | When should another review pass stop, or come back to you instead? | Do not add a numeric budget unless asked. | runbook.md |
| 22 | Runtime verification | Green checks have missed a real failure before. | What real action demonstrates the change actually works? | The outcome the user described, exercised with a realistic input. | hive.yml vars, runbook.md |
| 23 | Visual evidence | The project has a visible interface. | Which visible states do you need to see before accepting a change? | Only the states relevant to this project. | hive.yml vars, runbook.md |
| 24 | Agent applications | More than one agent application is already in use. | Which applications are available, and which can use your tools? | Keep whatever is already working for the user. | top-level hive.yml `agents` |
| 25 | Model selection | The user has a model preference. | Do you want a default model, or to choose one per task? | Keep current settings; propose no model ranking of your own. | posture.md, runbook.md |
| 26 | Model identifiers | The user's setup routes models by a custom name. | Does your installed application expect an alias, or an exact identifier? | Use an identifier the user has verified works. | top-level hive.yml `lead`, runbook.md |
| 27 | Reasoning effort | The user has an effort preference. | Should tasks inherit the default effort, or use a level you choose? | Inherit current settings. | top-level hive.yml `lead`, runbook.md |
| 28 | Escalation | A session repeatedly gets stuck. | When do you want a fresh session, or a different model? | Return a blocked choice to the user. | runbook.md, worker.md |
| 29 | Capacity accounting | Usage limits already affect the user's day. | Does capacity change scheduling for you, and how do you check it today? | Use measured capacity only; assume nothing about any specific provider. | runbook.md; top-level hive.yml `lead_turn_budget` only if asked |
| 30 | Checkpoint recipient | Long delegated work has lost context before. | Who should receive a checkpoint, and decide whether to continue? | The person or session the user already designated. | worker.md; top-level hive.yml `context_checkpoint_percent` |
| 31 | Child-session authority | Nested sessions have already caused a surprise. | May a nested helper edit, or should it only report back? | Read-only helpers unless the user explicitly assigns writes. | worker.md |
| 32 | Commit conventions | The repository has commit conventions. | What commit format and signing does this repository require? | Keep the repository's own conventions. | runbook.md, worker.md |
| 33 | Handoff ownership | State is lost between sessions. | What should survive a session, and who records it? | The outcome and the next action, in whatever record the user already keeps. | runbook.md, worker.md |
| 34 | Information boundaries | Generated text gets published or shared. | What belongs in private notes but must never reach external text? | Respect the audience and policy the user already stated. | runbook.md, worker.md |
| 35 | Outcome measurements | The user wants evidence for future model or process choices. | Which outcomes would help you improve this process later? | No new tracking system for a first profile. | runbook.md |
| 36 | Reviewer feedback | The user maintains or tunes a reviewer. | Do review outcomes need to be recorded anywhere for future tuning? | Keep feedback in whatever record already exists. | runbook.md |
| 37 | Supporting artifacts | Repeated long instructions are becoming hard to use. | Would one optional reference file help, and when should it be read? | No extra artifact without a concrete, stated need. | runbook.md, an optional profile `.md` |
| 38 | Fork provenance | The user edits an existing fork, or shares one across projects. | Should this change affect every project on this profile, or only this one? | Preserve provenance; offer a separately named copy for isolation. | profile selection, minimal file edits |
| 39 | Status messages | The user says updates are noisy or unhelpful. | What do you need to see in a status update? | A short outcome, the active work, and any open decision. | posture.md |
| 40 | Startup routine | Setup gets repeated every time a session reopens. | What must a new session read before it starts work? | Existing project context plus live hive state. | runbook.md |
| 41 | Waiting and deadlines | Time is lost to silent waits. | Which waits need a finish notice, or a deadline? | Completion wakes for real delegated work; no timer machinery by default. | runbook.md |

**For simple**, skip the coordination-only dimensions unless the user asks
to add delegation: 01-02, 04, 06-08, 16, 24, 28, 30-31. Every other
dimension still needs its own answer signal before it becomes a question -
simple does not mean asking less carefully about checking, review, or
permissions, it means there is no second session to coordinate.

**Common candidate defaults**, useful across both routes but never
mandatory: keep the user's existing habits that already work, keep
project-specific facts out of shared prose (route them to `vars` instead),
use hive's own state for durable work records, ask on unclear scope,
isolate concurrent file writes, and verify completion with something real
rather than trusting a clean status line. Do not import a default just
because it is common; every row above still needs its own answer signal
from this user.

## 4. Convergence and confirmation

Stop discovery once you can describe: the current task flow, at least one
pain or wanted change, one habit to preserve, who owns which actions, how
completion will be verified, and who the profile is for (this project, or
every project on this machine). Summarise earlier if the question budget is
reached or the user asks to proceed. Keep observations, proposed
improvements, and unresolved required inputs visibly distinct in that
summary. Offer no more than three improvements, each linked to something
the user said; the first draft includes only the ones they accepted.

Before writing anything, show: profile name(s), the base each starts from,
the intended scope (this project, or global), any permission change, the
target files, any `hive.yml` change, and - for an edit - a concrete diff.
Confirm this proposal once. For several profiles, confirm the whole batch
but identify each profile separately.

After writing and validating, explain how to restart the affected
session(s) so the change takes effect, and invite one small edit after they
try it. Do not dispatch actual project work, change which agent application
is in use, install a third-party tool, or publish anything as part of this
interview.

## Scope: "this project" versus "every project"

There is no way today to make a profile live as files inside a project's
own repository; hive's profile loader only resolves named directories
under a store's profiles directory or under hive's own shipped `profiles/`,
and a profile name cannot contain a path separator. So:

- **"This project only"** means: pick (or create) a distinct, named profile
  and set it with `profile: <name>` in *this project's* `hive.yml`. Other
  projects are unaffected.
- **"Every project on this machine"** means: set `profile: <name>` in the
  user's own `~/.hive/hive.yml` (the global defaults file), which every
  project without its own `profile:` then inherits. Offer this only when
  the user explicitly asks for it, and say plainly that it changes the
  default for every project that does not already set its own `profile:`.

Never suggest that a profile can live inside the project's own repository;
that is a different, larger change this skill does not make.

## Target selection: whose file are you about to write?

Two possible write targets exist for any profile name, and they are not
interchangeable:

- **The user's own override**: a directory under the configured hive data
  directory's `profiles/<name>/` (normally `~/.hive/profiles/<name>/`,
  respecting `HIVE_DATA_DIR` if the user has set it - never assume the
  default location). This always wins at read time over anything shipped.
- **The shipped source**: the actual template files under `profiles/<name>/`
  in a hive source checkout - available only when the current project *is*
  a hive checkout (this repository, or another clone of it), never the
  files an installed hive package ships.

Recognise a hive source checkout by its own profiles directory together
with its package identity and where its loader code lives, not by
directory name alone. If you are not sure, ask; do not infer it from a
folder simply being called `hive`.

**Creating a new name** always writes to the user's own override, using the
shipped template as the starting content for a chosen base (or a minimal
new `posture.md` when starting from nothing). It never creates a new name
under the shipped source.

**Editing an existing name** offers both targets when both are available
and lets the user choose, showing the absolute writable path for each and
what it affects before confirmation:

- Editing the **user's override** changes only what this user's machine
  resolves; it never touches the shipped checkout.
- Editing the **shipped source** changes tracked product text everyone who
  updates that checkout will get. It must stay generic - no project-specific
  fact, no personal name or path, values still routed through `vars` - and
  it does not authorise a commit or a publish; that is a separate, explicit
  step the user takes themselves. If the user's own override for that same
  name already exists, say so explicitly: the override will keep hiding the
  edit at read time until the user deals with it, so never silently edit
  both, or edit one and call it done.

**Validating a source-target edit** must not read through the ordinary
store, because that would resolve the user's override instead of the
change you just made. Read that checkout's own template file directly for
authoring, and validate the *rendered* result using a scratch store that
has no override in it - never the user's usual `hive doctor` or `hive
profile read`, which resolve overrides first.

**Reading for authoring never means reading a rendered file.** A rendered
read drops any conditional block whose var is unset, so it is never a safe
source for an edit - it can only look like the whole file when it is not.
Read the raw template (`hive profile path <name> <file>` shows where it is)
for authoring, and use `hive profile read`, `hive runbook`, and `hive
posture` only to verify the rendered result afterward.

**Splitting a shared profile.** If the user wants a change for one project
only, but the profile is currently shared, propose a separately named copy
that carries every one of that profile's existing valid `.md` files, not
just the three known ones, rather than editing the shared original.

**Preflight, then write.** For several new names or edits in one session,
check every proposed name and destination for conflicts (an existing
directory, an invalid name, a rejected reuse of a shipped name) before the
first write. A profile name must start with a letter or digit, and every
remaining character must be a letter, digit, dot, dash, or underscore, with
no `..` anywhere in it; reject `none` as a name outright, since it means "no
profile" to hive's own loader. If one item in a batch fails, leave the
successful ones written and reported, and resume only the unfinished ones -
never redo work that already succeeded.

## Preserving what the interview did not touch

Before writing an edit, re-read the actual target file (not a cached copy
from earlier in the conversation): unrelated sections, comments, any extra
`.md` file the profile carries, and `hive.yml`'s own keys and comments all
carry through unchanged. Patch only the discussed rule and any dependent
instruction the user explicitly approved; never regenerate a whole file
from its base just to make one change. If the file changed since the
proposal was shown, re-read it, present the revised diff, and confirm again
before writing - never write over a change you have not seen.

When selecting one project's `profile:` key in `hive.yml`, treat each
project's selection as independent: writing one project's key must never
overwrite, or be reported as though it overwrote, another project's
selection.

## `hive.yml` routing

- `profile: <name>` selects the profile; write it to the project's own
  `hive.yml` for "this project", or to `~/.hive/hive.yml` only on an
  explicit ask for "every project" (see Scope, above).
- `agents: [<harness>, ...]` selects which agent applications this project
  allows; write it only when the user names more than the default.
- `vars:` holds project facts referenced as `{{var}}` from the profile's
  own text - reuse shipped names before inventing one: `check` (the
  before-you-report-done gate), `repo`, `install`, `ticket_prefix`,
  `start_command`. This lane's own additions, each a plain string
  substituted into prose and never executed by hive itself, are:
  `test_command` (scoped tests), `suite_command` (the full suite),
  `verify_command` (a real, observable outcome check), and
  `review_command` (an existing review the user already runs). Write one
  only when a generated template actually references it - an unreferenced
  var is dead weight, not a feature.
- `context_checkpoint_percent` (an integer from 1 to 100) and
  `lead_turn_budget` (a `{warn, stop}` pair, `stop` greater than `warn`) are
  optional and written only when the user asks for them.

Never write a `hive.yml` key this skill does not know, and never invent a
model name, an effort flag, a reserved identity var, or an `agents_*` /
`harness_*` var - those are hive's own, computed at spawn time, and a
project-defined one is stripped before it ever reaches a template.

## 5. Recipes

`recipes/index.md` links a small library of optional patterns, each tied to
one or more dimensions above: verification (15, 17, 22), a shared test
resource (16, 15), a review decision (18-21), session continuity (33, 40,
35), and a worker context checkpoint (30, 28, orchestration only). Read the
matching recipe when its dimension's signal shows up in discovery; it is
never a required stop on the way to a first profile.

## Known traps

- Reading a *rendered* profile file drops unset-var sections; never use it
  as the source for an edit (see above).
- Conditional markers (`<!--if:var-->` / `<!--end-->`) each need their own
  line and must nest symmetrically; there is no inverse or else-branch, so
  never introduce a derived var meant to flip a section the opposite way.
- A new `hive.yml` var only starts working once the code that renders it
  ships and the server restarts; a var referenced in a profile before that
  is simply absent from every render in the meantime, silently, since a
  presence-conditional has no error state.
- Copying "the known three files" when isolating a shared profile drops any
  extra `.md` file that profile carries; enumerate what actually exists
  instead of assuming the three.
- `hive doctor`'s global exit code mixes in unrelated environment checks;
  judge a profile by its own reported lines, never by that exit code alone.
- Never fill an identity var (a worker's own name, actor id, working
  directory) with a project value just to quiet a var-usage report; those
  are supplied per spawn, not from `hive.yml`.
