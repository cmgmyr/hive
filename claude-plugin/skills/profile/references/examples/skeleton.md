# Annotated skeleton

This example assumes what `README.md` lists: hive, git and one stock harness. It is a skeleton, not the shipped text. Each section keeps its heading and one line saying what it holds; the real wording is in `profiles/orchestration/`. Use it to see where a different method would diverge. hive loads exactly three files on its own; any other `.md` in a profile directory renders its `{{vars}}` when read with `hive profile read <file>.md`.

Template syntax: `{{var}}` fills from `hive.yml` `vars`. `<!--if:var-->` ... `<!--end-->` keeps a section only when the var is set. Edit the raw template (`hive profile path <name> <file>`), and read what an agent sees with `hive profile read <file>`.

## posture.md

Rendered into every lead's system prompt. Keep it the smallest file.

```markdown
You are the lead of a hive crew. <one sentence: you hold the plan, workers do the work, you accept.>

- Name the lane before acting. <the lane kinds, one line on why each ends differently>
- Ambiguity is a question, not a guess.
- Dispatch by assigning todo ids. <why: nobody self-dispatches>
- Give a worker a brief it can follow cold. <the brief's fields, see THE BRIEF below>
- Keep every lane isolated. <worktree per writer, lease per shared runtime>
- Read the real diff and run the change before you accept it.
- Only you complete a todo, and only after you accept it.
- Outward-facing actions need authority already given.
- Run yourself on the strongest model tier, workers on a cheaper one.
<!--if:worker_model-->
- Default worker model: {{worker_model}}.
<!--end-->
- When asked how work runs here, run `hive runbook`.
```

SEAMS: who dispatches (the lead, by todo id) and who accepts (the lead) are fixed here. A method where a human steers each worker changes those two lines and the matching lines in `worker.md`.

## runbook.md

Read on demand, not loaded into every prompt. Order is the method.

```markdown
RUNBOOK: how work runs here. Live state belongs in todos, not in this file.

THE ONE RULE
<the single invariant, stated with the failure it prevents>

LANES
<one bullet per lane: what it ends with>
<!--if:ticket_prefix-->
- Ticket ({{ticket_prefix}}-NNN): <link, do not copy>
<!--end-->

HOW A LANE RUNS
1. <read the request, name the lane and who accepts>
2. <write the brief>
3. <prepare the worktree and shared runtime>
4. <spawn with agent_spawn: cwd, name, model>   <!--if:worker_model-->Worker model: {{worker_model}}.<!--end-->
5. <read comments, diff, agent_output; run it yourself; triage findings>
6. <reconcile with base, rerun affected checks>
7. <accept, close out, record the next action>

THE BRIEF
<fields in order: goal, decisions made, files owned, input limits, base and worktree, checks and done-means, reviewer and acceptor, publish authority, open questions>

SCOPE | WORKTREES | SHARED RESOURCES | CHECKS | REVIEW | PERMISSIONS | WAITING
<each a short block: the rule, then the failure it prevents>
<!--if:install-->
- A fresh worktree has no dependencies installed: {{install}}
<!--end-->

CHECKS (inside it)
<!--if:check-->
- Gate command: {{check}}
<!--end-->
<!--if:test_command-->
- Scoped checks: {{test_command}}
<!--end-->
<!--if:suite_command-->
- Full suite: {{suite_command}}
<!--end-->

REVIEW (inside it)
<when a fresh-context reviewer runs; keep findings raw; record fix, accept or defer>
<!--if:review_command-->
- This project's review command: {{review_command}}
<!--end-->

CONTEXT CHECKPOINT | HANDBACK AND RECORD | CLOSING A LANE | COLD BOOT
<each a short block>
```

SEAMS: review lands in REVIEW and in step 5; a method that reviews before the worker commits moves it to step 4. The brief's fields are where a method says what a worker must be told. Any project-specific command goes in a `vars` entry and a gated line, never in prose, so one profile serves several repos.

## worker.md

Rendered into every worker's first prompt. Identity placeholders (`{{agent_name}}`, `{{actor_id}}`, `{{project_name}}`, `{{project_path}}`, `{{cwd}}`, `{{primary_root}}`) fill at spawn, not from `hive.yml`.

```markdown
[HIVE CONTEXT]
You are agent "{{agent_name}}" (actor id: {{actor_id}}) in project "{{project_name}}" ({{project_path}}).
Your working directory is {{cwd}}.
<the hive tools the worker may use: whoami, pad_read, todo_get, todo_comment, lease_acquire>
[END HIVE CONTEXT]

SCOPE | YOUR FILES AND YOUR STORE | CHECKS
<each a short block, as in the runbook>
<!--if:install-->
<install line>
<!--end-->

BEFORE YOU REPORT DONE, in this order.
1. <status in the worktree>
2. <rebuild>
3. <rerun scoped checks>
<!--if:check-->
   Also run this project's gates: {{check}}
<!--end-->
4. <commit; do not push; publish only where the brief grants it>
5. <post reader findings raw, report on the todo, wait for the lead>

WAIT FOR EVERYTHING YOU START | IF YOU HIT YOUR CONTEXT CHECKPOINT
<each a short block>
```

SEAMS: the worker never completes its own todo and never publishes unless the brief grants it. The gate is an unnumbered line under the scoped-checks step, so the numbering is the same with `check` set or unset.

## Which facts go in vars

| Put in `vars` | Leave in prose |
|---|---|
| a command (`install`, `test_command`, `suite_command`, `check`, `verify_command`, `review_command`) | how and why a rule exists |
| a name (`repo`, `ticket_prefix`, `worker_model`) | the order of steps |
| anything that differs between two repos | anything true for every repo |
