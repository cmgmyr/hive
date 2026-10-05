RUNBOOK: how work runs here. Read this when the human asks you to orchestrate. Live state belongs in todos and their comments, not in this file.

This is hive's starting point. Fork it and edit it:

    hive profile fork orchestration runbook.md
    $EDITOR ~/.hive/profiles/orchestration/runbook.md

Doubled-brace placeholders are filled from `vars:` in the project's hive.yml, and a section can be conditional on a var. Edit the raw template (`hive profile path orchestration runbook.md`). Read what an agent sees with `hive profile read runbook.md`, since a fork can mask the file you think you are reading.

THE ONE RULE
The lead supervises and accepts; a worker never completes its own todo. A worker that marks its own work done reports done on work you have not accepted.

LANES
Say which lane you are in before acting.
- Change: a worker edits in its own worktree and returns commits plus evidence. It ends at your acceptance.
- Research: a worker reads and reports findings. It ends when you accept the findings. It needs no commit, build or merge. Spawn it with `read_only` so it cannot edit by accident.
- Review: a fresh-context reader reports findings on a diff. It ends with your triage.
- Smoke test: you or a worker exercises the running result. It ends with the observed outcome.
<!--if:ticket_prefix-->
- Ticket ({{ticket_prefix}}-NNN): link the ticket from the todo. Do not copy its body, or the two drift apart. Name who updates the ticket and which states they set.
<!--if:start_command-->
Start ticket work with: {{start_command}}
<!--end-->
<!--end-->

HOW A LANE RUNS
1. Read the request and the project's own rules. Name the lane and who accepts. A lane without an acceptance owner stalls on the first question.
2. Write the brief (shape below). Put it on the todo, or in a pad when it is long.
3. Prepare the worktree and any shared runtime (WORKTREES, SHARED RESOURCES). A worker started before this edits the wrong place.
4. Spawn the worker with agent_spawn: `cwd` set to the worktree, `name` set, and `model` set to the worker tier from `vars:` when you have named one. Send the brief. Then wake_when_idle(scope="project").
5. When it reports, read the todo comments, the diff and agent_output. Run the change yourself. Triage findings (REVIEW).
6. Reconcile with the base branch, read any conflict resolution, and rerun the checks the merge could affect. A merge that was never rerun ships a break that each side passed alone.
7. Accept, then close out (CLOSING A LANE). Record the next action on the todo.

THE BRIEF
Every brief names, in this order:
- Goal and deliverable (change, research or review).
- Decisions already made, which the worker must not reopen.
- Files it owns and what is out of scope.
- Input limits when reading could touch private or unapproved data: allowed sources, prohibited sources.
- Base branch and worktree path.
- Checks to run, and the observable result that means done.
- Who reviews and who accepts.
- Authority for pushes, PRs and posts. When the brief says nothing, the worker returns commits and evidence and does not publish.
- Open questions.
A short lane is one todo. A large one gets a pad. The failure each line prevents is the same: a worker fills a gap with its own guess.

SCOPE
A worker records evidence and asks you before it widens its files or reopens a decision. Choices inside the brief stay with the worker. Otherwise an improvement quietly replaces the approved approach. Human steering beats these defaults.

WORKTREES
- A git worktree resolves to the primary checkout's project, so every worktree shares one store.
- Parallel file edits need one worktree per worker, passed as agent_spawn's `cwd`. Two workers in one checkout overwrite each other.
- Use absolute paths in edits and `git -C <worktree>`. A relative path after a `cd` resolves against the wrong tree.
<!--if:install-->
- A fresh worktree has no dependencies installed: {{install}}
<!--end-->

SHARED RESOURCES
Name each shared runtime (a dev database, a port, a device) and who holds it. A worker takes lease_acquire on it before use and releases it after. Run one full check against a shared resource at a time, and give the slot out yourself. Two runs on one resource produce a failure that looks like a broken change. When nothing is shared, add no serialisation.

CHECKS
Run the named checks. A green summary or a stale build is not a working result.
<!--if:check-->
- Gate command for this project: {{check}}
<!--end-->
<!--if:test_command-->
- Scoped checks: {{test_command}}
<!--end-->
<!--if:suite_command-->
- Full suite: {{suite_command}}. Run it once before handback and again after a rebase.
<!--end-->
<!--if:verify_command-->
- Exercise the real outcome with: {{verify_command}}
<!--end-->
- Rebuild before any browser check or measurement. A stale build is the commonest false result.
- With no suite, name a manual check in the brief. Do not invent a test runner.
- The worker reports each command, its result, and what it did not cover.
- You exercise one acceptance case yourself. A worker's pass says nothing about a case it never ran.

REVIEW
- Read the real diff on every lane. Run a fresh-context reviewer, such as your harness's review command or a read-only helper, when the change is risky or the human asks. Extra review on every change is cost without signal.
- Keep the reviewer's findings as written. Record fix, accept or defer for each with a reason you can check. A filtered list hides the finding you disagreed with.
- Ask for a defect, a reachable bad input, or a false claim about a contract. Engage decisions already recorded on the todo. Style churn wastes rounds.
- Ask a reviewer to say what it read versus what it ran. Silence is not runtime evidence.
- After a fix, recheck that fix and what it touched. Do not reopen the whole review.
<!--if:review_command-->
- This project's review command: {{review_command}}
<!--end-->

PERMISSIONS
Pushes, PRs, external posts, merges and tracker updates happen only where the brief or the human grants them. One setup's approval does not authorise another. Review locally first, then the authorised owner publishes. Where a human PR review is required, it stays required. Never change tool or permission settings to rescue a lane.
<!--if:repo-->
This project's remote is {{repo}}.
<!--end-->

WAITING
Await everything a phase started and read the results before you move on. Unfinished helpers change code you already checked. Keep commands in the foreground. wake_when_idle reports workers going idle; it does not prove every helper finished.

CONTEXT CHECKPOINT
Where `context_checkpoint_percent` is set in hive.yml, a worker that crosses it commits safe work, writes done, left and new facts onto the todo, and stops for you. Answer with continue, split or hand over. A worker left waiting loses the time it saved. Read a worker's fill from agent_status (`context_fill`), never from a guess. hive signals the threshold and does not stop anyone.

HANDBACK AND RECORD
A handback on the todo lists: files and commits, checks and results, outcome, risks, and the next action. A session that restarts reads the todo, so the next action cannot live only in memory. Keep handoffs on the todo, not in a new file, ledger or pad format.
Text that leaves the machine describes the change and the evidence only. Keep coordination records out of it.

CLOSING A LANE
1. Accept the result. Confirm the merge when delivery was required.
2. todo_complete, with the evidence in the comment.
3. Capture anything still only in the worker's pane, then agent_close.
4. Remove only the worktrees and branches that lane made. Release its leases. Cancel wakes it set (wake_cancel).
5. Leave dirty or uncertain work in place and say so. Teardown that destroys live work loses the author's only copy.

COLD BOOT (after a crash, a reboot, or a closed terminal)
- `hive status` shows what the store still thinks is running. `hive doctor` sweeps rows whose panes are gone.
- A dead pane keeps nothing. Results exist only in todo comments, pads and commits.
- Read todo_list(status="in_progress") and its comments before you redispatch. Assume nothing about what the last session was mid-way through.

STANDING RULES
- Do not poll workers. wake_when_idle(scope="project") once; wake_when_idle(agents=[...]) is a one-shot and stops watching after the first finish.
- Read real diffs and agent_output before calling a lane done.
- Capture handoffs on todos before agent_close.
- Anything outward-facing waits for authority the human has given.
- Keep project facts in `vars:`, not in prose, so a copied rule does not go stale.
