# Profiles

Standing instructions shared across projects, and the optional plugin that loads hive's live state into a session at startup.

## Profiles (standing instructions across projects)

A profile is a named set of standing instructions shared across projects. It is how a lead knows how you work before you tell it anything.

```
<checkout>/profiles/<name>/     hive's defaults, updated by git pull
~/.hive/profiles/<name>/        your overrides, copy-on-write
```

Resolution is per file, not per profile, so a file you never forked keeps tracking hive's default while the ones you did are yours. Three files make up a profile:

| File | How it reaches the model | What hive ships |
|---|---|---|
| `posture.md` | Appended to the lead's system prompt by `hive lead`; `hive posture` shows it | Real content: lead-not-IC, name the lane, ask on ambiguity, don't poll |
| `runbook.md` | On demand, `hive runbook` | A skeleton. Headers plus facts true of any hive project. Your process is yours to write |
| `worker.md` | Appended to each worker's system prompt by `agent_spawn` | The worker brief: identity, project lock, tool contract, lane discipline |

Two profiles ship: `orchestration` (a lead delegating to workers) and `simple` (one session doing the work itself, posture only).

```bash
hive profile list                      # what exists, where each file resolves, what drifted
hive profile fork orchestration        # copy hive's defaults into ~/.hive to edit
hive profile fork orchestration runbook.md   # or just one file
hive profile create mine --from simple
hive runbook                           # this project's process, vars resolved
hive posture                           # what your lead is actually running with
```

Pick one per project in `hive.yml`:

```yaml
profile: orchestration
lead_branches: [main, master]   # where the session-start kickoff fires
vars:
  repo: owner/name
  ticket_prefix: DEVX
  install: pnpm install
```

All three files take `{{repo}}` and friends from `vars`, and drop whole sections whose var is unset, so one profile serves a repo with a ticket tracker and one without. `posture.md` is delivered as a path, so `hive lead` renders it into a generated file under `~/.hive/postures/` (one per project, overwritten each run) and points the flag at that; `hive posture` prints the same text, which is the only way to see what your lead actually started with. An undefined var stays visible as `{{name}}` rather than silently emptying, and `hive doctor` reports which vars a runbook references and which the project defines.

`vars` are repo-controlled and land in system prompts, with no approval step. Commands in `hive.yml` do have one, because hive executes them; `vars` are only quoted into a prompt, and Claude Code's own workspace trust already governs the wider version of that channel by loading a repo's `CLAUDE.md`. The practical consequence: a `hive.yml` you did not write reaches your workers' system prompts as soon as you run hive in that checkout, so read one the way you would read that repo's `CLAUDE.md`. hive is not a defense against opening a checkout you do not trust and does not pretend to be.

Your forks are never overwritten. hive records the hash of what it shipped at fork time, so `hive profile list` and `hive doctor` can tell you when upstream moved and leave the decision to you.

## Session-start kickoff (optional plugin)

Symlink the plugin once per machine (not per project) and a session opened in a project root, on a lead branch, with a profile that resolves, starts with hive's live state already loaded: the board pad, in-flight and dispatchable todos, running workers, pending wake-ups, and an instruction to run triage.

```bash
ln -s <checkout>/claude-plugin ~/.claude/skills/hive
```

One symlink covers every project on the machine, so there is nothing to repeat when you add the next one. `hive init` checks for it and tells you which of the three states you are in: not installed, already installed, or pointing at a different hive checkout.

A folder under a skills directory holding `.claude-plugin/plugin.json` loads as a plugin on the next session, discovered in place rather than copied, so it upgrades with `git pull && npm run build` like everything else. It stays silent everywhere else: in a worker session, in a directory with no `hive.yml`, on a feature branch, below the project root, or when the profile named in a committed `hive.yml` is not on this machine. Run `hive kickoff --explain` anywhere to see which gate stopped it.
