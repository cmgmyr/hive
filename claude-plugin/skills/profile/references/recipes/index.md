# Recipe index

A recipe is an optional pattern a profile can adopt: a short, named block of
text (and sometimes a `hive.yml` var) that solves one recurring problem.
Read the matching recipe only after discovery reveals its signal - this
index exists so you know which one to open, not as five more required
interview questions. Propose a recipe's benefit and cost, then apply it
only if the user accepts it. Declining leaves the draft unchanged.

| Recipe | Signal | Benefit | Route |
|---|---|---|---|
| [verification.md](verification.md) | Sessions finish without proving the outcome, or a known check gets repeated by hand. | A completion step that actually runs the user's own check and reports a real result. | Both |
| [shared-test-resource.md](shared-test-resource.md) | Simultaneous test runs collide on a shared database, port, or device. | One agreed coordinator for the shared resource, so runs stop colliding. | Both |
| [review-decision.md](review-decision.md) | Review already happens, but feedback causes churn or has no clear owner. | A named decision owner and evidence bar for acting on a finding. | Both |
| [session-continuity.md](session-continuity.md) | A reopened session repeats decisions or loses the next action. | A small finish/start habit that carries the next action across sessions. | Both |
| [worker-context-checkpoint.md](worker-context-checkpoint.md) | Delegated work runs long enough that a worker loses useful context. | A checkpoint threshold and a designated recipient who decides whether to continue. | Orchestration only |
