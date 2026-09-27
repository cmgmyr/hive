---
name: profile
description: Interviews the user about how they work with agents, then creates a new hive profile or edits an existing one - the posture, runbook, and worker files a lead and its workers read. Use when the user says /hive:profile, "set up a hive profile", "create a profile for this project", "edit our hive profile", "make hive lead/orchestrate here", or wants a project to go from no standing process to one hive can run, globally or per project.
---

# hive profile

You are interviewing someone to produce, or change, a hive profile: the standing instructions (`posture.md`, `runbook.md`, `worker.md`) that tell a lead and its workers how this person wants work to run. Read `references/interview.md` before you ask a follow-up question or write anything - it holds the discovery map, the target-selection rules, and the `hive.yml` routing this skill depends on.

## Read before you ask anything

Run `hive profile list` and `hive doctor` (or read this project's `hive.yml` directly) before the first question. If this is an edit, also read the named profile's current files with `hive profile read <file> --profile <name>` for each of `posture.md`, `runbook.md`, `worker.md`, and any other `.md` it carries - never the raw path, which shows unrendered `{{vars}}` and nothing that says so. Do not ask the user to repeat anything already answered by what you just read.

## Discovery first, not a checklist

Start with the work, not with profile structure: ask about a recent task they did with an agent, from start to finish. Follow what they say into current agent use, handoffs, checking, review, and permissions - what already works and where they repeat themselves or correct the agent. This is adaptive: choose the next question from the last answer, not from a fixed list. `references/interview.md` has a scored map of optional follow-up questions - each tied to an answer signal that makes it worth asking - and a question budget so discovery converges instead of running forever. Most of that map goes unused in any one interview; it is there so you know what to ask *if* the signal for it shows up, not a form to complete.

For an edit, ask "what should change, and what should stay?" first, and read the current profile before asking about anything it already states.

## Both routes are equally valid

Orchestration (a lead delegating to workers) and simple (one session doing its own work) are both first-class outcomes. Recommend one from what you heard, name the one reason tied to their answer, and offer the other without calling it an upgrade or a downgrade. No stated preference means recommend simple: it is the smaller thing to start from, and delegation is available later through an edit. `references/interview.md` lists the signals for each route.

## Several profiles are fine

The user may want more than one profile - a simple one and an orchestration one, or a different profile per kind of project. Handle building several in one session: preflight every name and destination before the first write, so a bad name is caught before anything is created, and keep each profile's own differences and confirmation separate even when the discovery was shared.

## Start small; editing is how a profile grows

A first profile carries only what this interview actually surfaced. A new simple profile is `posture.md` plus a short `runbook.md` written from the confirmed answers - not a copy of anything thicker. A new orchestration profile fills in the shipped orchestration template's placeholders from those same answers; it does not add sections nobody asked for. Depth comes from running this skill again later to edit, not from a bigger first pass. Do not add a mandatory extra `.md` file, a review tool, or a tracking artifact that nobody's answer called for.

## Converge, then confirm once

Stop discovery when you can state: the current task flow, at least one pain or wanted change, one habit to keep, who owns which actions, how they'll know work is done, and who the profile is for (this project only, or every project on this machine). Summarise that back, offer at most three improvements each tied to something they said, and let them accept, decline, or edit each one. Before writing anything, show: profile name(s), the base each starts from, the target(s) you are about to write to (see below), and - for an edit - a concrete diff. Confirm once. Do not keep discovering after the user asks to proceed.

## Know which file you are about to write

There are two possible write targets, and they behave differently:

- **The user's own override** (their machine's copy-on-write fork, normally under their hive data directory). This always wins at read time over anything shipped.
- **The shipped source**, only when you are running inside a hive checkout (this repository, or another clone of it) - the actual template files under this checkout's `profiles/<name>/`.

`references/interview.md` has the exact detection and confirmation rules. Never guess: an unclear target is a question, not a default. If the user's own override already exists for a name whose shipped source you are about to edit, say so - the override will keep hiding your change until they deal with it - rather than silently editing both or picking one.

## Preserve what you did not ask about

An edit changes only the rule that was discussed and any dependent instruction the user explicitly approved. Everything else - unrelated sections, an optional `.md` file, `hive.yml` comments and keys, loader-owned metadata - is read fresh immediately before writing and carried through unchanged. If the file changed since you proposed the edit, re-read it, show the revised diff, and confirm again before writing.

## Route project facts into `hive.yml` `vars`, not prose

A command, a repository name, a ticket prefix: these belong in `hive.yml` `vars` and get referenced from the profile as `{{var}}`, not hard-coded into the generated `posture.md`/`runbook.md`/`worker.md` text. This is what lets one profile serve several projects. `references/interview.md` lists the `hive.yml` keys and var names this skill knows how to write, and which existing shipped vars (`check`, `repo`, `install`, `ticket_prefix`, `start_command`) to reuse before introducing a new one.

## Offer a recipe only on its own signal

`references/recipes/index.md` links a small library of optional patterns - a verification step, a shared-resource rule, a review-decision habit, and so on - each written to solve one problem an interview signal points to. Read a recipe only after discovery actually surfaces its signal; propose its benefit and cost, and apply it only if the user accepts. A recipe with no signal in this interview does not get offered, and accepting one is never required to finish a profile.

## Validate before you tell them it's done

After writing, run `hive doctor` and `hive profile read <file> --profile <name>` for each file you touched, from the project the profile is meant to serve. A profile with no readable `runbook.md` fails `hive doctor` outright; `posture.md` and `worker.md` do not, but check them anyway. Tell the user to restart any running hive session so it picks up the change, and invite one small follow-up edit once they've tried it - that is the expected way a profile keeps improving.

## What this skill does not do

It does not dispatch project work, change which agent application or model a project uses beyond what was explicitly asked, install a third-party tool, or commit or publish anything. It edits `hive.yml`'s `profile`, `agents`, `vars`, `context_checkpoint_percent`, and `lead_turn_budget` keys only on an explicit ask, and only to values the user gave or confirmed.

