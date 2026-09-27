CREATE TABLE migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
, tmux_pane TEXT);

CREATE TABLE "pads" (
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
, archived_at TEXT, slug TEXT NOT NULL DEFAULT '');

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

CREATE TABLE "leases" (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lock_key TEXT NOT NULL,
  owner TEXT NOT NULL REFERENCES actors(id),
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, lock_key)
);

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
, agent_state TEXT NOT NULL DEFAULT 'unknown', state_changed_at TEXT, kind TEXT NOT NULL DEFAULT 'agent', tmux_socket TEXT NOT NULL DEFAULT '', pane_pid TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', parked_at TEXT NOT NULL DEFAULT '', parked_branch TEXT NOT NULL DEFAULT '', resumed_at TEXT NOT NULL DEFAULT '', codex_home TEXT NOT NULL DEFAULT '', exit_tail TEXT NOT NULL DEFAULT '', transcript_path TEXT NOT NULL DEFAULT '');

CREATE INDEX idx_agents_project ON agents(project_id, status);

CREATE TABLE "wakes" (
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
, typed_at TEXT, held_at TEXT, held_reason TEXT, confirmed_at TEXT, typed_busy INTEGER, watch_scope TEXT, parent_wake_id INTEGER REFERENCES "wakes"(id) ON DELETE CASCADE, typed_seen TEXT, first_held_at TEXT);

CREATE TABLE command_trust (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  trusted_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, name, config_hash)
);

CREATE UNIQUE INDEX idx_agents_running_name
  ON agents(project_id, name COLLATE NOCASE) WHERE status = 'running';

CREATE TABLE agent_state_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  event TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX idx_agent_state_log_actor ON agent_state_log(actor_id, id);

CREATE INDEX idx_agent_state_log_created ON agent_state_log(created_at);

CREATE INDEX idx_agents_actor_id ON agents(actor_id);

CREATE TABLE dashboard_meta (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_attempt_at TEXT,
  last_mark TEXT
);

CREATE TABLE wake_block_notices (
  wake_id INTEGER NOT NULL REFERENCES "wakes"(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  blocked_since TEXT NOT NULL,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wake_id, agent_id, blocked_since)
);

CREATE TABLE wake_idle_notices (
  wake_id INTEGER NOT NULL REFERENCES "wakes"(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  condition TEXT NOT NULL,
  episode TEXT NOT NULL,
  notice_wake_id INTEGER,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wake_id, agent_id, condition, episode)
);

CREATE INDEX idx_wake_idle_notices_notified ON wake_idle_notices(notified_at);

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

CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  from_actor TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_agent_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);

CREATE INDEX idx_agent_messages_project ON agent_messages(project_id, id);

CREATE INDEX idx_pads_project ON pads(project_id, archived, name);

CREATE UNIQUE INDEX idx_pads_active_name
  ON pads(project_id, name) WHERE archived = 0;

CREATE TRIGGER guard_pads_content_update
BEFORE UPDATE ON pads
FOR EACH ROW
WHEN NEW.content IS NOT OLD.content AND NEW.updated_at IS NOT datetime('now')
BEGIN
  SELECT RAISE(ABORT, 'Refused: this UPDATE changes pads.content but leaves updated_at unchanged, which every hive pad tool (pad_write, pad_edit, pad_append) stamps in the same statement. To overwrite a large pad, use hive pad <name> --save <file>, which does this correctly. If you must run SQL directly, address the row BY PRIMARY KEY (id), never by name: pad names are unique per project, not globally, so a name-only WHERE clause matches every project''s pad with that name and silently overwrites the wrong project''s data.');
END;

CREATE INDEX idx_wakes_active ON wakes(project_id, kind)
  WHERE cancelled_at IS NULL;

CREATE INDEX idx_wakes_parent ON wakes(parent_wake_id) WHERE parent_wake_id IS NOT NULL;

INSERT INTO migrations (version, applied_at) VALUES (1, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (2, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (3, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (4, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (5, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (6, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (7, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (8, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (9, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (10, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (11, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (12, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (13, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (14, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (15, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (16, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (17, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (18, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (19, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (20, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (21, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (22, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (23, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (24, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (25, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (26, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (27, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (28, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (29, '2026-09-26 00:00:00');
INSERT INTO migrations (version, applied_at) VALUES (30, '2026-09-26 00:00:00');
