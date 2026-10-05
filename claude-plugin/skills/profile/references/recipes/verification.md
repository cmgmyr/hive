# Verification

## Problem

A session reports a change "done" on a clean status line, but nothing actually ran the project's own check, or a known checking command gets retyped by hand every time because the runbook never wrote it down.

## Offer when

The user says work has finished without proving the outcome, or repeats a checking command they already have. Interview dimensions 15, 17, 22. Both simple and orchestration.

## Requirements

The user's confirmed scoped-check command (`vars.test_command` or the shipped `check`) and, if they have one, a real verification command (`vars.verify_command`) - a way to exercise the actual outcome, not just run a linter. Neither is invented; both come from the user or from a command you have watched them run.

## Add

A short completion block in `runbook.md`:

```markdown
BEFORE CALLING THIS DONE
<!--if:check-->
Run: {{check}}
<!--end-->
<!--if:verify_command-->
Then verify the actual outcome: {{verify_command}}
<!--end-->
Report a failing result as failing. A clean status line is not evidence by
itself.
```

On the shipped orchestration base, the runbook's CHECKS section already renders `check`, `test_command` and `verify_command` when they are set, and `worker.md` already asks for the named checks before a handback. So there, set the vars and add this block only if the user's own runbook lacks a completion step. For a forked or hand-written orchestration profile, add the same obligation to `worker.md`'s completion section rather than only the lead's runbook, since it is the worker who reports done.

```yaml
vars:
  check: <existing scoped-check command>
  verify_command: <existing real-outcome check, if any>
```

## Verify

Run `hive runbook` and confirm both commands render. On orchestration, also run `hive profile read worker.md` and confirm the worker text carries the check obligation. Never use `hive posture` for the worker copy: it prints the lead's file only. Then exercise it for real: pick a harmless, already-working change and confirm the block actually gets run and its result gets reported, not just written down.

## Remove

Delete the added block from `runbook.md` (and `worker.md` on orchestration). Leave `check` and `verify_command` in `vars` if anything else still references them; only drop a var once nothing does.

## Boundaries

This recipe does not install a review tool, a CI pipeline, or a numeric pass budget. It only makes an existing check part of what "done" means.

