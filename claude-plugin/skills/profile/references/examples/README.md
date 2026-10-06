# Worked examples

Open one of these only when the user asks to see an example or wants to adapt one. Do not open them during discovery, and do not add an interview question to reach them. The interview in `../interview.md` stays the way a profile gets built.

| File | What it shows | Open it when |
|---|---|---|
| [two-projects.md](two-projects.md) | One orchestration profile and two `hive.yml` files, a personal repo and a work repo. Every "rendered" block is real output from the shipped profile. | The user asks how one profile differs per project, or what `vars` do. |
| [skeleton.md](skeleton.md) | The three profile files cut down to their seams: who dispatches, where review lands, what a brief carries, which facts belong in `vars`. | The user wants a different method and needs the places where it would diverge. |

## What they are not

- They are illustrations to read and adapt. hive never forks, runs or injects them. Only `posture.md`, `runbook.md` and `worker.md` inside a profile directory are rendered.
- The projects in them are invented. Nothing is copied from a real setup.
- A rendered block is checked by `test/profile-examples.test.mjs`, which renders the shipped orchestration profile with the example's `hive.yml` and fails when a block no longer matches. If the shipped profile changes, regenerate the block from the real output; do not edit it by hand.

## Every example assumes

- hive is installed and the project is a git repository registered with `hive init`.
- One stock harness (Claude Code or Codex) and nothing else: no extra skills, plugins, CI, tracker tooling or scripts.
- Commands such as `npm test` are placeholders for the user's own. A var left unset drops its section; nothing is required.

If the user has none of this, use the simple profile instead.

## Trust

`hive.yml` `vars` land in the lead's posture and every worker's brief with no approval step. Read a cloned repo's `hive.yml` the way you would read its `CLAUDE.md`.
