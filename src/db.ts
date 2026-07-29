import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { guardAbi } from "./abi.js";
import { guardStoreDir } from "./dataDir.js";

// This module is the only one allowed to touch the store at load time, and
// that is the invariant to keep, not the const. Line 25 opens the database in
// the module body, so importing db.js IS choosing a store; the const below
// only writes down a commitment the module has already made. dataDir.ts
// holding one was different in kind: it decided the store for every process
// that imported anything in the graph, including the ones that never opened
// a store at all.
//
// Because the commitment is made during an import, the failure has to be
// reported the way abi.ts reports its own: printed and exited, not thrown.
// A throw out of an ESM module body reaches the user as a stack trace with
// hive's sentence buried in it, which is the shape CLAUDE.md says to avoid.
export const dataDir = guardStoreDir();
mkdirSync(dataDir, { recursive: true });

// The import above does not load better-sqlite3's native addon; `new
// Database` does. This is the last point where a mismatched interpreter can
// be named instead of surfacing as an ERR_DLOPEN_FAILED stack trace. See
// abi.ts.
guardAbi();
export const db = new Database(join(dataDir, "hive.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const MIGRATIONS: string[] = [
  `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'human',
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scratchpads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]',
  archived INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scratchpads_project ON scratchpads(project_id, archived, name);
CREATE UNIQUE INDEX idx_scratchpads_active_name
  ON scratchpads(project_id, name) WHERE archived = 0;

CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'backlog', 'completed')),
  locked_by TEXT REFERENCES actors(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_todos_project ON todos(project_id, status, updated_at DESC);

CREATE TABLE todo_blockers (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  blocker_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  PRIMARY KEY (todo_id, blocker_id),
  CHECK (todo_id != blocker_id)
);
CREATE INDEX idx_todo_blockers_blocker ON todo_blockers(blocker_id);

CREATE TABLE todo_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_todo_comments_todo ON todo_comments(todo_id, created_at);

CREATE TABLE kv (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  PRIMARY KEY (project_id, key)
);

CREATE TABLE locks (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lock_key TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES actors(id),
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, lock_key)
);
`,
  `
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  tmux_target TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  parent_actor_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX idx_agents_project ON agents(project_id, status);
`,
  `
ALTER TABLE agents ADD COLUMN agent_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE agents ADD COLUMN state_changed_at TEXT;
ALTER TABLE actors ADD COLUMN tmux_pane TEXT;

CREATE TABLE timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'delay' CHECK (kind IN ('delay', 'idle_any', 'idle_all')),
  watch TEXT NOT NULL DEFAULT '[]',
  deliver_actor TEXT NOT NULL,
  deliver_pane TEXT NOT NULL,
  due_at TEXT,
  max_wait_at TEXT,
  repeat_every_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at TEXT,
  cancelled_at TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_timers_active ON timers(project_id, kind)
  WHERE cancelled_at IS NULL;
`,
  `
ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';

CREATE TABLE command_trust (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  trusted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, name, config_hash)
);
`,
  // A worker's name is how a lead addresses it, so two running agents in a
  // project may never share one. requireNameFree is the primary rule and
  // stays; this is the backstop for the one thing it cannot see. Every
  // session runs its own server against one shared WAL store, so two leads
  // spawning the same name can both pass the check and both insert. Only the
  // store can refuse that.
  //
  // The fold here is SQLite's NOCASE, which covers ASCII only, while
  // requireNameFree folds with JS toLowerCase, which is Unicode-aware. They
  // deliberately do not agree. The index sits BEHIND the application check,
  // so everything it catches is a subset of what the app already rejects and
  // it can never refuse a name the app would allow. The residual gap is
  // narrow: two sessions racing to spawn a non-ASCII case pair ("café" and
  // "CAFÉ") would both get through. Closing it needs a JS-written folded
  // column and a backfill, which buys very little for a real schema change.
  //
  // Rows that already violate the rule are renamed rather than closed, since
  // closing a row whose pane is alive makes hive forget a running worker,
  // while renaming keeps it addressable. The loser keeps its pane and gains
  // its id as a suffix; the lowest id keeps the original name.
  `
UPDATE agents
   SET name = name || '-' || id
 WHERE status = 'running'
   AND EXISTS (
     SELECT 1 FROM agents AS other
      WHERE other.project_id = agents.project_id
        AND other.status = 'running'
        AND other.name = agents.name COLLATE NOCASE
        AND other.id < agents.id
   );

CREATE UNIQUE INDEX idx_agents_running_name
  ON agents(project_id, name COLLATE NOCASE) WHERE status = 'running';
`,
];

export function migrate(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(version);
    })();
  });
}
