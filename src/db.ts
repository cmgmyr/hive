import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { guardAbi } from "./abi.js";
import { guardStoreDir } from "./dataDir.js";
import { maybeBackupBeforeMigrations } from "./backup.js";
import { errorMessage } from "./result.js";

export const dataDir = guardStoreDir();
mkdirSync(dataDir, { recursive: true });

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

guardAbi();
const storePath = join(dataDir, "hive.db");
export const db = new Database(storePath);

const openedInode = statSync(storePath).ino;
let storeReplacedLatch = false;

export function storeReplaced(): boolean {
  if (storeReplacedLatch) return true;
  let current: number;
  try {
    current = statSync(storePath).ino;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return false;
    storeReplacedLatch = true;
    return true;
  }
  if (current !== openedInode) storeReplacedLatch = true;
  return storeReplacedLatch;
}

db.pragma("busy_timeout = 5000");

for (let attempt = 0; ; attempt++) {
  try {
    db.pragma("journal_mode = WAL");
    break;
  } catch (e) {
    if (attempt >= 40 || !(e instanceof Error) || !/database is locked/.test(e.message)) throw e;
    sleepSync(25);
  }
}
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

  `
CREATE TABLE agent_state_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  event TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
-- (actor_id, id) is for the human forensic query, which is this table's whole
-- purpose: "show me every state this worker was recorded in, in order, with the
-- event and payload that decided it". Nothing in src/ reads it, deliberately.
-- Named here so it does not read as an index nobody uses.
CREATE INDEX idx_agent_state_log_actor ON agent_state_log(actor_id, id);
CREATE INDEX idx_agent_state_log_created ON agent_state_log(created_at);
`,

  `
ALTER TABLE timers ADD COLUMN typed_at TEXT;
ALTER TABLE timers ADD COLUMN held_at TEXT;
ALTER TABLE timers ADD COLUMN held_reason TEXT;
ALTER TABLE timers ADD COLUMN confirmed_at TEXT;
`,

  `
ALTER TABLE timers ADD COLUMN typed_busy INTEGER;
`,

  `
ALTER TABLE agents ADD COLUMN tmux_socket TEXT NOT NULL DEFAULT '';
`,

  `
CREATE INDEX idx_agents_actor_id ON agents(actor_id);
`,

  `
ALTER TABLE todos ADD COLUMN archived_at TEXT;
`,

  `
CREATE TABLE dashboard_meta (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_attempt_at TEXT,
  last_mark TEXT
);
`,

  `
CREATE TABLE wake_block_notices (
  timer_id INTEGER NOT NULL REFERENCES timers(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  blocked_since TEXT NOT NULL,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (timer_id, agent_id, blocked_since)
);
`,

  `
ALTER TABLE timers ADD COLUMN watch_scope TEXT;
ALTER TABLE timers ADD COLUMN parent_timer_id INTEGER REFERENCES timers(id) ON DELETE CASCADE;
CREATE INDEX idx_timers_parent ON timers(parent_timer_id) WHERE parent_timer_id IS NOT NULL;

CREATE TABLE wake_idle_notices (
  timer_id INTEGER NOT NULL REFERENCES timers(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  condition TEXT NOT NULL,
  episode TEXT NOT NULL,
  notice_timer_id INTEGER,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (timer_id, agent_id, condition, episode)
);
`,

  `
CREATE INDEX idx_wake_idle_notices_notified ON wake_idle_notices(notified_at);
`,

  `
CREATE TRIGGER guard_scratchpads_content_update
BEFORE UPDATE ON scratchpads
FOR EACH ROW
WHEN NEW.content IS NOT OLD.content AND NEW.updated_at IS NOT datetime('now')
BEGIN
  SELECT RAISE(ABORT, 'Refused: this UPDATE changes scratchpads.content but leaves updated_at unchanged, which every hive pad tool (pad_write, pad_edit, pad_append) stamps in the same statement. To overwrite a large pad, use hive pad <name> --save <file>, which does this correctly. If you must run SQL directly, address the row BY PRIMARY KEY (id), never by name: pad names are unique per project, not globally, so a name-only WHERE clause matches every project''s pad with that name and silently overwrites the wrong project''s data.');
END;

CREATE TRIGGER guard_todos_content_update
BEFORE UPDATE ON todos
FOR EACH ROW
WHEN (NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body) AND NEW.updated_at IS NOT datetime('now')
BEGIN
  SELECT RAISE(ABORT, 'Refused: this UPDATE changes todos.title or todos.body but leaves updated_at unchanged, which todo_update stamps in the same statement. Use todo_update, or if you must run SQL directly, address the row BY PRIMARY KEY (id) and stamp updated_at yourself.');
END;

CREATE TRIGGER guard_kv_content_update
BEFORE UPDATE ON kv
FOR EACH ROW
WHEN NEW.value IS NOT OLD.value AND NEW.updated_at IS NOT datetime('now')
BEGIN
  SELECT RAISE(ABORT, 'Refused: this UPDATE changes kv.value but leaves updated_at unchanged, which kv_set stamps in the same statement. kv''s primary key is (project_id, key), not key alone: a key-only WHERE clause matches every project''s row with that key. Use kv_set, or if you must run SQL directly, filter on project_id too and stamp updated_at yourself.');
END;
`,

  `
ALTER TABLE agents ADD COLUMN pane_pid TEXT NOT NULL DEFAULT '';
`,

  `
ALTER TABLE agents ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
`,

  `
ALTER TABLE agents ADD COLUMN parked_at TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN parked_branch TEXT NOT NULL DEFAULT '';
`,

  `
ALTER TABLE agents ADD COLUMN resumed_at TEXT NOT NULL DEFAULT '';
`,

  `
ALTER TABLE todos ADD COLUMN slug TEXT NOT NULL DEFAULT '';
`,

  `
ALTER TABLE timers ADD COLUMN typed_seen TEXT;
`,

  `
ALTER TABLE timers ADD COLUMN first_held_at TEXT;
`,

  `
CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  from_actor TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_agent_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
-- AUTOINCREMENT is load-bearing, not decoration: sqlite_sequence keeps the highest id ever
-- issued even after the janitor deletes every row, and that is the only thing that lets
-- agent_message_get tell a PRUNED id from one that never existed (src/leadMessage.ts).
CREATE INDEX idx_agent_messages_project ON agent_messages(project_id, id);
`,

  `
ALTER TABLE agents ADD COLUMN codex_home TEXT NOT NULL DEFAULT '';
`,

  `
ALTER TABLE agents ADD COLUMN exit_tail TEXT NOT NULL DEFAULT '';
`,
];

function readAppliedVersions(): Set<number> {
  return new Set(
    (db.prepare("SELECT version FROM migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
}

const MIGRATE_LOCK_MAX_ATTEMPTS = 24;
function retryOnBusy<T>(fn: () => T, label: string): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const busy =
        e instanceof Error && ((e as NodeJS.ErrnoException).code === "SQLITE_BUSY" || /database is locked/.test(e.message));
      if (!busy || attempt >= MIGRATE_LOCK_MAX_ATTEMPTS) {
        console.error(
          `hive: ${label} did not complete after ${attempt} attempt(s): the store's write lock never freed ` +
            "up. Another hive process is likely still applying a migration (or is stuck); check for a " +
            `wedged hive process and try again. Underlying error: ${errorMessage(e)}`,
        );
        process.exit(1);
      }

    }
  }
}

export function migrate(): void {
  retryOnBusy(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    db.exec(`CREATE TABLE IF NOT EXISTS backup_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      last_error_at TEXT
    )`);
    db.prepare("INSERT OR IGNORE INTO backup_meta (id) VALUES (1)").run();
  }, "preparing the store's bookkeeping tables");

  const before = readAppliedVersions();

  maybeBackupBeforeMigrations(db, dataDir, MIGRATIONS.length - before.size);

  const applyPending = db.transaction(() => {
    const applied = readAppliedVersions();
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (applied.has(version)) return;
      db.exec(sql);
      db.prepare("INSERT INTO migrations (version) VALUES (?)").run(version);
    });
  });

  retryOnBusy(() => applyPending.immediate(), "applying pending migrations");
}
