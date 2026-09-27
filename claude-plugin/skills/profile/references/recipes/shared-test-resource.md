# Shared test resource

## Problem

Two sessions run a full check at the same time and collide on a database,
a port, or a device the checks both need, producing a failure that looks
like a broken change but is really two runs fighting over one resource.

## Offer when

The user describes simultaneous test runs colliding on something shared.
Interview dimensions 16, 15. Both routes, including several solo sessions
sharing one machine.

## Requirements

The name of the actual shared resource (a database, a port, a device) and
who or what should coordinate access to it - a named person, or "whoever
holds it first."

## Add

A runbook rule naming the resource and the coordination habit:

```markdown
SHARED TEST RESOURCE
<name of the shared resource> is shared across sessions on this machine.
Run one full check against it at a time; ask <coordinator> for the slot
before starting one. Scoped checks that do not touch it can still run
independently.
```

For orchestration, give workers the same obligation - asking the lead for
the slot rather than assuming it is free - in `worker.md`.

```yaml
vars:
  suite_command: <existing full-suite command, if templating helps>
```

## Verify

Walk through two proposed runs and confirm both name the same
coordinator and the same resource, and that the second is described as
waiting for the first rather than running alongside it. This is a stated
process, not an enforced lock; nothing in hive itself serializes it.

## Remove

Delete the added runbook rule (and the worker.md line on orchestration).
Leave any existing runner-level lock the project already has untouched;
this recipe only adds the human process on top of it.

## Boundaries

This does not implement a real lock, a queue, or a CI concurrency guard. It
only gives the people and sessions involved one agreed rule to follow.
