import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { guardAbi } from "./abi.js";
import { guardStoreDir } from "./dataDir.js";
import { maybeBackupBeforeMigrations } from "./backup.js";
import { errorMessage } from "./result.js";

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

// A genuine blocking sleep with no async machinery: Atomics.wait blocks this
// thread for `ms` on a throwaway buffer nothing else touches. Used once,
// below, to retry a specific startup race without turning module load async.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The import above does not load better-sqlite3's native addon; `new
// Database` does. This is the last point where a mismatched interpreter can
// be named instead of surfacing as an ERR_DLOPEN_FAILED stack trace. See
// abi.ts.
guardAbi();
export const db = new Database(join(dataDir, "hive.db"));
// busy_timeout FIRST: it has no effect on the pragma call that sets it, only
// on the ones after. Setting journal_mode first left a real window with
// zero lock tolerance - found while building a test that opens two brand
// new connections to the same not-yet-existing file at once (several hive
// processes launched together, the same scenario PR #36's migrate() race
// came from).
db.pragma("busy_timeout = 5000");

// A genuine, separate race, found by the same test: converting a brand new
// file to WAL needs a momentary exclusive lock, and two connections doing
// that at once can both get SQLITE_BUSY ("database is locked") on THIS
// pragma specifically, immediately rather than after busy_timeout's 5s -
// busy_timeout does not reliably cover this one operation. Retried here,
// not left to throw: this runs at module load, so an unhandled throw is the
// same "server starts with no tools" failure the migrate() race produced,
// just one step earlier. Bounded and brief - this only ever fires in the
// narrow window where two processes are converting the same not-yet-WAL
// file at once, never in ordinary single-connection startup.
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
  // Issue #24, twice. agents.agent_state is one row overwritten in place, so a
  // wrong value that corrects itself leaves no trace at all. On 2026-07-29 a
  // false "idle" was written at 13:27:39 and overwritten with "working" at
  // 13:27:41, the lead sampled at 13:28, saw "working", and recorded a PASS on
  // a lane that had already failed. No polling frequency anyone would really
  // run catches a two-second transition. What caught it was timers.fired_at, a
  // record of an event rather than a reading of a state.
  //
  // So: every hook invocation appends a row here and nothing ever updates one.
  // The payload sits next to the state it decided, which is the part that
  // matters. Both #24 lanes reasoned from "an idle was written" to
  // "stateFor(\"stop\") wrote it" without checking, and the truth was that the
  // notify branch wrote it. One column, `event`, answers that in a glance.
  //
  // No foreign key to agents, deliberately. The hook knows an actor_id and
  // nothing else, foreign_keys is ON, and a hook must never fail; a reference
  // to a row that has been closed and swept must not cost the log its evidence.
  // Join on actor_id when a query needs the agent or its project.
  //
  // created_at carries milliseconds while every other timestamp in this schema
  // is whole seconds. That is on purpose and it is this table's whole reason to
  // exist: the transitions worth reading here are the ones that happen inside
  // one second. The format is the same otherwise, so ordering and range
  // comparisons against datetime('now', ...) still work as plain string
  // comparisons. Ties break on id, which is monotonic.
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
];

function readAppliedVersions(): Set<number> {
  return new Set(
    (db.prepare("SELECT version FROM migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
}

// Second counselors pass, C1: busy_timeout (5s) alone is not enough for
// migrate()'s writes. A migration slow enough to hold the write lock past it
// - plausible on an upgrade that applies several at once, exactly what a
// second machine hits on upgrade day - left a write here throwing
// SQLITE_BUSY straight out of migrate(), the same "MCP server starts with no
// tools" failure B1 exists to remove, just reached by a different write.
// Retried here instead of widening busy_timeout itself: each attempt still
// gets its own 5s of internal SQLite retrying, and this loop adds
// MIGRATE_LOCK_MAX_ATTEMPTS more rounds of that on top, for a case that is
// rare and, when it happens, legitimately slow rather than stuck. A give-up
// is a clear message naming what to check, not a raw SQLITE_BUSY with a
// stack trace out of a module body.
//
// Covers every write in migrate() that can contend for hive's single WAL
// writer, not only the final apply transaction: the bootstrap INSERT OR
// IGNORE for backup_meta's seed row hit the identical error in testing, once
// a genuinely slow holder was involved rather than a microsecond gap. A
// plain SELECT (readAppliedVersions) is not wrapped - WAL readers proceed
// concurrently with a writer, so it has nothing to contend for.
const MIGRATE_LOCK_MAX_ATTEMPTS = 24; // ~2 minutes total at up to 5s/attempt
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
      // busy_timeout already spent up to 5s waiting inside this attempt;
      // loop straight into the next one rather than adding an extra sleep.
    }
  }
}

export function migrate(): void {
  retryOnBusy(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // Bootstrapped here, unconditionally, rather than as a MIGRATIONS entry
    // (PR #36, B2). Issue #23's pre-migration backup runs BELOW, before any
    // migration is applied - including on a brand new store, where every
    // migration is pending by definition. If backup_meta were created BY one
    // of those migrations, the very first backup a store ever takes would run
    // before that migration had applied, its bookkeeping UPDATE would hit "no
    // such table", and the failure would be silently swallowed: last_success_at
    // never set, for a real, valid snapshot already sitting on disk. Same
    // reasoning as the `migrations` table itself one line up: bookkeeping this
    // module depends on has to exist before anything can depend on it, not
    // whenever its turn comes up in an ordered list of schema changes.
    //
    // A backup is a property of the STORE, not of a project, which is the
    // other reason this cannot be kv (project-scoped, project_id NOT NULL
    // REFERENCES projects). One row (id fixed to 1 by the CHECK): when a
    // backup was last attempted (the hourly rate-limit clock, reused from the
    // wake-up claim shape), when one last succeeded, and the most recent
    // failure kept separately from success so a later success cannot erase
    // the evidence a backup failed at 10:00 even if another one succeeds at
    // 11:00 (`hive doctor` compares the two timestamps; see backupHealth in
    // backup.ts).
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
  // Before migrations, not after: a schema change is the classic
  // irreversible moment. Snapshotting only when something is actually
  // pending means an ordinary open (nothing new to apply) costs nothing.
  //
  // `before` is deliberately not reused past this call. VACUUM INTO refuses
  // to run inside a transaction, so this backup sits outside the one below,
  // and that gap is real elapsed time - a whole-store copy, not a read.
  // Two processes can both start here with the same `before`, both take
  // their (harmless, atomically-named) backup, and one of them can fully
  // apply every pending migration in that gap. Applying against a `before`
  // read above this comment would then re-run already-committed SQL - a
  // CREATE TABLE against a table the other process just created - and throw
  // out of migrate() at the top of a module body, with nothing to catch it:
  // an MCP server starting with no tools registered. PR #36 found this: it
  // widened a pre-existing microsecond race into one spanning a full store
  // copy, which gets worse as the store grows - exactly when the backup
  // this window opened around matters most.
  maybeBackupBeforeMigrations(db, dataDir, MIGRATIONS.length - before.size);

  // BEGIN IMMEDIATE takes hive's write lock before this callback's first
  // statement runs, so the re-read of applied versions and every migration
  // this process applies land as one atomic step. A second process blocked
  // on the same lock only gets its turn once this one commits, and its own
  // re-read then already reflects everything it did.
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
