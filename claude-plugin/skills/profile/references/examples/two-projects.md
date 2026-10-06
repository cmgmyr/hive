# One profile, two projects

This example assumes what `README.md` lists: hive, git and one stock harness. The projects are invented.

Both projects use the shipped orchestration profile unchanged. Only `hive.yml` `vars` differ, so the same three template files read differently in each repo. An unset var drops its section; a set one fills a placeholder or opens a section.

## Project A: a personal repo

Install and a scoped test command. No tracker, no suite, no review command.

```yaml hive.yml personal
profile: orchestration
vars:
  install: npm install
  test_command: npm test -- test/<file>.test.js
```

What the lead's runbook says (`hive runbook`):

```text rendered personal runbook
- Use absolute paths in edits and `git -C <worktree>`. A relative path after a `cd` resolves against the wrong tree.
- A fresh worktree has no dependencies installed: npm install
```

```text rendered personal runbook
CHECKS
Run the named checks. A green summary or a stale build is not a working result.
- Scoped checks: npm test -- test/<file>.test.js
```

What a worker sees (`hive profile read worker.md`). With no `check` var set, the scoped-checks step has no gate line under it:

```text rendered personal worker
2. Rebuild before any screenshot, browser check, or measurement.
3. Run the scoped checks again after your last edit, and the full suite once if the brief asks for it.
4. Commit; do not push. Research lanes record findings on the todo and need no commit. Publish only where the brief grants it; otherwise ask the lead.
```

## Project B: a work repo

A ticket prefix, a gate, a full suite, a review command and a worker model.

```yaml hive.yml work
profile: orchestration
vars:
  ticket_prefix: PAY
  check: make lint test
  suite_command: make ci
  review_command: /review
  worker_model: the gateway's mid-size tier
```

The lead's posture gains one line:

```text rendered work posture
- Default worker model: the gateway's mid-size tier.
```

The runbook gains a ticket lane, a worker model, a gate, a suite and a review command:

```text rendered work runbook
- Ticket (PAY-NNN): link the ticket from the todo. Do not copy its body, or the two drift apart. Name who updates the ticket and which states they set.
```

```text rendered work runbook
   Worker model: the gateway's mid-size tier.
```

```text rendered work runbook
- Gate command for this project: make lint test
- Full suite: make ci. Run it once before handback and again after a rebase.
```

```text rendered work runbook
- This project's review command: /review
```

The worker's report-done list gets a gate line under the scoped-checks step, and the numbering does not change:

```text rendered work worker
3. Run the scoped checks again after your last edit, and the full suite once if the brief asks for it.
   Also run this project's gates and fix what they find: make lint test
4. Commit; do not push. Research lanes record findings on the todo and need no commit. Publish only where the brief grants it; otherwise ask the lead.
```

## What to change for your project

1. List what your project actually has: an install step, a scoped test command, a full suite, a gate, a review command, a ticket prefix, a remote.
2. Write only those into `hive.yml` `vars`. Use the names in the examples; the shipped profile renders `check`, `install`, `repo`, `ticket_prefix`, `start_command`, `test_command`, `suite_command`, `verify_command`, `review_command` and `worker_model`.
3. Do not set a var you cannot fill. Leave it out.
4. Set `worker_model` only to a model the user named.
5. Read the result: `hive runbook`, `hive posture`, and `hive profile read worker.md`.
6. Run `hive doctor` and restart any running lead so it reloads.

To change a rule itself, fork first: `hive profile fork orchestration`, then edit the files under `hive profile path orchestration`.

## Paste-ready prompt

```text
I use hive with the shipped orchestration profile. Here is my project: <one line on what it is>.
Commands I actually run: install = <cmd or none>, scoped tests = <cmd or none>, full suite = <cmd or none>, lint/gate = <cmd or none>, review = <cmd or none>.
Ticket prefix: <PREFIX or none>. Remote: <owner/name or none>.
Write a hive.yml for this repo with `profile: orchestration` and a `vars:` block holding only the commands above that are not "none". Do not invent commands.
Then run `hive runbook`, `hive posture` and `hive profile read worker.md` and tell me which sections appeared and which dropped. Do not edit the profile files.
```
