# Contributing

hive is a personal daily-driver tool, released low-key. Issues and small pull requests are welcome.

## Before a large change

Open an issue or a discussion first. hive is single-user by design, and a change that widens that is easier to talk through before you write it.

## Build and test

```bash
npm install
npm run build
npm test
```

Tests run against the built `dist/`, so build first. [docs/development.md](docs/development.md) has the details.

There is no CI on pull requests. CI runs weekly, so run `npm test` locally before you open one.

## Writing and commits

Write short, active sentences. Use no em dashes, and write one line per paragraph in markdown; do not hard-wrap it.

Keep each commit to one concern, with a subject that says what changed and a body that says why. Unsigned commits are fine.
