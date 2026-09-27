# Review decision

## Problem

Review already happens, but feedback keeps churning because nobody agreed
what makes a finding worth acting on, or who gets to decide.

## Offer when

The user already has some form of review, and says feedback is noisy,
repeats, or has no clear owner. Interview dimensions 18-21. Both routes.

## Requirements

Where useful review already happens today, and who should decide whether a
finding gets acted on. A review command is optional - only include one if
the user names a real, installed tool they already run; human review needs
none.

## Add

A runbook block naming the reviewer, the timing, and the decision owner:

```markdown
REVIEW
Review happens at <existing point in the process>.
<!--if:review_command-->
Run: {{review_command}}
<!--end-->
A finding is worth acting on when it points to a concrete failure or a
broken requirement, not a style preference. <decision owner> decides;
record the decision where this project already keeps its work record.
```

## Verify

Walk a sample real finding through the block and confirm it reaches the
named decision owner, and that the decision gets recorded somewhere the
project already tracks work - not a new location this recipe invents.

## Remove

Delete the added block. Leave `review_command` in `vars` if another part
of the profile still references it.

## Boundaries

This does not install a new review tool, define a severity scale, or set a
numeric limit on review passes. It only names who decides and what counts,
using review the user already has.
