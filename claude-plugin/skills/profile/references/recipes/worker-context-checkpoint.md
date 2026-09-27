# Worker context checkpoint

## Problem

A worker's context keeps growing across a long delegated task and never
resets on its own; run long enough with no checkpoint and it loses useful
earlier context, or gets stuck and needs a successor that has to relearn
everything.

## Offer when

The user describes delegated work running long enough to lose context, or
a session repeatedly needing a fresh replacement. Interview dimensions 30,
28. Orchestration only - there is no worker to checkpoint in simple.

## Requirements

A context-fill threshold (a percentage), and who should receive a
checkpoint and decide whether the worker continues, splits, or hands off
to a fresh session - usually the lead, keep an existing threshold if the
user already has one instead of asking again.

## Add

`context_checkpoint_percent` at the top level of `hive.yml`:

```yaml
context_checkpoint_percent: <the user's chosen or existing threshold, 1-100>
```

A block in `worker.md`:

```markdown
AT THE CONTEXT CHECKPOINT
Commit what works. Write what is done, what is left, and anything you now
know that the assignment did not say, onto the todo. Report to
<decision owner>, then wait: do no further work until they answer with one
of continue, split, or hand over to a fresh session.
```

And the recipient's obligation in `runbook.md`:

```markdown
When a worker reports its context checkpoint, read what it wrote and
answer with continue, split, or hand over - do not leave it waiting.
```

## Verify

`hive doctor` reports the configured threshold, and the generated
`worker.md` names the confirmed recipient. Exercise a synthetic checkpoint
handoff - a worker reporting the checkpoint and the recipient answering -
without spawning real project work, to confirm the instruction is legible
end to end.

## Remove

Restore the previous `context_checkpoint_percent` value, or delete the key
entirely if this recipe introduced it. Remove the inserted `worker.md` and
`runbook.md` blocks. This does not stop a worker already running; restart
or newly start workers to pick up the change.

## Boundaries

The threshold only informs; hive does not stop a worker at it. The
behavior at the checkpoint comes entirely from the instruction this recipe
adds, not from any enforcement hive performs on its own.
