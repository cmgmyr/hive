# Reviewer preamble

This file is the one place this project's invariants, finding bar, and
false-green test shapes are written for a reviewer, so any reviewer of this
codebase, human or automated, can cite it instead of restating the same
material. It is written for a reviewer who has never seen this project
before, so it names things rather than linking them.

## 1. This repo's invariants

hive is an MCP server plus CLI giving multiple Claude Code sessions one
shared, project-scoped state store, backed by one SQLite database. A change
that violates one of these is a defect even if it is well-tested and reads
cleanly. Full statements live in `CLAUDE.md`'s Invariants section; the
short form:

- **Strict project scoping.** State resolves from the working directory.
  Cross-project access happens only on an explicit request; nothing falls
  back silently to an unrelated project's data.
- **A worker's files and the store that records its work can live in
  different projects, on purpose.** The files come from `cwd`; the store
  comes from the worker's own row. Treat that gap as intentional, not a bug
  to close.
- **Migrations are append-only.** Editing an existing `MIGRATIONS` entry in
  place, rather than adding a new one, is a defect regardless of whether it
  currently produces the same schema.
- **Write tools return slim receipts on purpose.** Do not flag a response as
  incomplete without naming a real caller that needs the missing field.
- **Concurrency is guarded, not assumed.** Shared-state writes carry
  optimistic revisions, TTLs, or atomic conditional updates. A read-then-write
  against shared state with none of these is a race, not a style note.
- **The scheduler must never throw and must stay unref()'d.** A throw there
  leaves an orphaned process running against a live store.
- **Wake-up bodies are delivered verbatim into a real terminal**, and become
  a user turn only if the target pane is idle. A busy pane absorbs the text
  with no hook firing, so "unconfirmed" does not mean "undelivered."
- **All process execution goes through argument-array exec, never a shell
  string built from data.** A shell string assembled from any variable input
  is a command-injection finding on its own.
- **Untrusted `hive.yml` commands never run without interactive
  re-approval**, tied to a hash of the config. `vars`, by contrast, reach
  system prompts with no gate, deliberately; that is a recorded decision, not
  an oversight, and it holds only because this is a single-user tool trusting
  its own workspace. Do not raise it as a finding without engaging that
  reasoning.
- **Every tool refuses an unknown argument key rather than stripping it.**
  A caller's typo (`expected_revison` for `expected_revision`) reaches the
  handler as if the field were omitted, not as an error; `src/strictInput.ts`
  closes that. Read a new tool's schema as strict, not as a loose shape that
  quietly drops what it doesn't recognize.
- **A hand-rolled driver can't write to the default store.** The entry point
  must be the CLI or the server; `HIVE_ALLOW_DEFAULT_STORE=1` is the
  deliberate opt-in for a one-off script, never something to add casually.
- **A content write that doesn't stamp `updated_at` is refused at the
  database**, not accepted silently: `src/db.ts`'s
  `guard_scratchpads_content_update`, `guard_todos_content_update`, and
  `guard_kv_content_update` triggers. Read a matching column update as a
  live invariant, not an ordinary write.
- Rule files under `.claude/rules/*.md`, where present in the checkout, tighten
  these invariants for the exact paths named in each file's frontmatter:
  `native-addon.md`, `project-scoping.md`, `store-and-datadir.md`,
  `tmux-and-panes.md`, `tool-contract.md`, `worker-state.md`. Open the one
  covering any changed path before reviewing it. A change against these
  often looks correct at the diff level and is wrong only against the
  invariant it exists to protect.

## 2. The finding bar

A finding names a `file:line` and describes a concrete failure scenario: the
input or call sequence that produces the wrong output, the crash, or the
silent corruption. Both parts, together, every time.

**Anything without both is not a finding.** Not "consider whether," not
"this could potentially," not a style preference dressed as a risk. If you
cannot point at a line and describe a run that breaks, keep looking or drop
it.

## 3. Tests are guilty until proven otherwise

This project has repeatedly shipped a green suite next to a live bug (see
`test/CLAUDE.md`, "Write tests that can fail"). Shapes that have actually
shipped here, not hypotheticals:

- A dead branch of a two-way check, kept alive by an earlier rename, so the
  assertion pins the surviving branch by accident.
- A saturated comparison, such as two exit codes compared against each other
  when the box is already failing for an unrelated reason; both read the
  same wrong value.
- A fixture that collides with reality on some machines, so the assertion
  meant to catch a bug inverts silently there.
- A fixture whose validity depends on the defect it tests, so fixing the bug
  makes the fixture meaningless instead of red.
- A test still asserting the old, buggy behavior, surviving a fix that
  should have broken it.
- A fixture too small to reach the bound it claims to test.
- A fix applied only at the call sites a bug report named, leaving sibling
  callers of the same guard unfixed; each reappearance then looks like a new
  bug.
- Sampling a single overwritten state column instead of asserting over an
  append-only event log, so a value that was briefly wrong and is now
  correct again reads as if it was always fine.

For any test you are pointed at, ask what would have to be true for it to
pass while the behavior it names is broken. If you cannot answer, treat it as
decoration, not evidence. A larger test count proves nothing by itself; ask
what each new test would actually catch, and whether a fix landed at every
call site of the thing it guards, not only the one a report happened to
name.

## 4. No style notes, no praise, no summary

Flag formatting, naming, or organization only when it hides or causes a
finding under rule 2. Do not open with, or include, a summary of what the
change does; the diff already says that. Do not write "looks good," or any
equivalent, about a hunk with no specific finding attached.

If the change is clean, say so by naming what you checked: which invariants
applied, which call sites of a changed guard or predicate you traced, and
which test claims you verified rather than took on faith. A silent approval
carries no information; a quiet review that names its checks does.

## Provenance

The shape of this preamble, the finding bar in section 2 and the ban in
section 4, comes from a locally kept review workflow record at
`.claude/sessions/workflows/running-counselors.md`; the false-green shapes in
section 3 draw on `.claude/sessions/common-issues/`. That directory is
gitignored on purpose, so it may be absent from the checkout you are reading
this in. Nothing above depends on it being present; those paths are cited as
provenance for a reader working from this project's own history, not as
links this file expects anyone else to follow. `CLAUDE.md`, the
`.claude/rules/*.md` files, and `test/CLAUDE.md` are tracked and are the
sources every invariant claim in section 1 and every test shape in section 3
actually traces to.
