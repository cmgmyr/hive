import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
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
const storePath = join(dataDir, "hive.db");
export const db = new Database(storePath);

// Issue #49: restoreSnapshot renames a new file into place, which orphans
// any process that already opened the old one - same path, different inode,
// no error either side. The inode recorded here is the one this process
// actually committed to; a later mismatch means the file at storePath is no
// longer the file `db` is writing to.
const openedInode = statSync(storePath).ino;
let storeReplacedLatch = false;

// Latched: once true, stays true without re-stat'ing. The answer cannot
// change back (a second replacement is still a replacement), and a cheap
// failure path matters here since callers check this on every tool call and
// every scheduler tick. A missing file (statSync throws ENOENT, or ENOTDIR
// if a path segment stopped being a directory) counts as changed, not as an
// error to propagate - restoreSnapshot's rename-then-unlink-sidecars
// sequence can observe the old inode already gone.
//
// Every OTHER errno fails OPEN rather than latching. ENOENT/ENOTDIR are the
// only codes a genuine replace or delete can produce: a rename always
// leaves a file at storePath, and a delete is exactly ENOENT. Anything else
// (EIO, ESTALE, EACCES - a flaky disk, a network home, something chmod'ing
// the store) is a transient failure to answer, not evidence the store was
// replaced. Latching on it would permanently brick an otherwise-healthy
// session with no way to recheck, which is a worse outcome than the rare
// tick that reads a transient error as "unreplaced" and simply asks again.
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
  // fired_at is the CLAIM timestamp: the atomic one-shot claim (or the
  // repeating due_at UPDATE) sets it, before deliver() ever types into a
  // pane. It does not mean "delivered" and never has; issue #27's typed_at
  // (added in a later migration, below) is the attempt that follows it, set
  // only after sendText returns without throwing. Do not rename, repurpose,
  // or add a claimed_at that duplicates this column: it sits inside
  // ACTIVE_TIMER_WHERE, which the scheduler's own tick reads, it sits inside
  // idx_timers_active, a partial index, and already-running MCP servers keep
  // executing old code against a newer schema, so they keep writing fired_at
  // with this exact meaning until their sessions restart. A column whose
  // meaning changes under a fleet of live writers is data corruption, not a
  // refactor.
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
  // Issue #27: delivery is a keystroke, not a confirmation. fired_at (defined
  // above, at the timers CREATE TABLE) is the CLAIM; these four columns let
  // the scheduler report what happened after the claim without changing when
  // a wake fires or where it is typed. All nullable, all additive, nothing in
  // src/ reads or writes them yet - that lands in a later commit.
  //
  //   typed_at       hive typed it at the pane. An assertion, set only after
  //                  sendText returns without throwing, never before it is
  //                  called. A throwing sendText must leave this NULL: that
  //                  is the whole reason the column exists.
  //   held_at        + held_reason. The most recent hold, not a count.
  //                  Recorded when deliverable() returns false for a modal
  //                  pane; deliverable()'s answer itself does not change, the
  //                  timer stays pending and retries on a later tick exactly
  //                  as it does today. Cleared or superseded once delivery
  //                  succeeds.
  //   confirmed_at   reserved for the positive observation that a
  //                  UserPromptSubmit row arrived for deliver_actor at or
  //                  after typed_at. Whether it is written here or computed
  //                  at query time against agent_state_log is decided in a
  //                  later step; either way it is an observation, never
  //                  inferred from silence. Absence of an ack is not evidence
  //                  of loss.
  `
ALTER TABLE timers ADD COLUMN typed_at TEXT;
ALTER TABLE timers ADD COLUMN held_at TEXT;
ALTER TABLE timers ADD COLUMN held_reason TEXT;
ALTER TABLE timers ADD COLUMN confirmed_at TEXT;
`,
  // Issue #75. A wake typed into a session that is already mid-turn is
  // received and acted on, but Claude Code fires no UserPromptSubmit for text
  // absorbed into a running turn, so no `prompt` row is written for it and
  // confirmed_at often stays NULL - before this column, that read
  // byte-identical to "unconfirmed", the field's alarm value and also what a
  // genuinely lost wake produces (issue #27's own motivating case).
  //
  // Counselors round 1 (todo 209, item B): typed_busy is NOT a prediction of
  // whether that wake will ever confirm. An earlier version of this comment
  // claimed a busy delivery "structurally" cannot - .claude/rules/tmux-and-
  // panes.md:43 and this project's own board disagree about whether a queued
  // paste confirms late once the target's turn ends, both claiming
  // verification, and this column does not need to settle that (see
  // src/scheduler.ts's deliver() for the full argument). It is the
  // scheduler's own OBSERVATION of the target's last recorded hook state,
  // made at the moment of typing, so a reader can tell "typed at a target
  // whose last recorded state was idle" from "typed at a target whose last
  // recorded state was mid-turn" - two facts hive can see - rather than a
  // claim about acknowledgement, which hive cannot make. NULL/0/1 rather
  // than a boolean: NULL means hive has no hook row for deliver_actor at all
  // (never instrumented, or none written yet) and must read as unknown,
  // never coerced to "not busy" - see the column's own write site for why
  // that coercion is exactly the inference .claude/rules/worker-state.md
  // rules out.
  `
ALTER TABLE timers ADD COLUMN typed_busy INTEGER;
`,
  // Issue #73. A pane id only means something relative to the tmux server it
  // came from, and nothing on a row said which server that was - the missing
  // fact behind every finding #68's five review rounds surfaced. Recorded
  // wherever tmux_target is written (src/spawn.ts, src/cli.ts), from
  // tmuxSocketPath(), the same function untrustedTmuxServer() already decides
  // server identity with.
  //
  // DEFAULT '' means "no fact recorded", not "foreign". Every row that
  // exists before this migration reads '', and reading that as foreign would
  // make the janitor silently stop sweeping every one of them forever with
  // no message - trading a latent unsoundness for an immediate silent
  // regression. Pre-upgrade rows drain on their own as their agents close;
  // read-side callers (src/tools/agents.ts, src/scheduler.ts, src/cli.ts)
  // treat '' as "behaves exactly as today", never as foreign.
  //
  // Counselors round 1 (#73, A3) corrected an overclaim here: this migration
  // running does NOT mean every '' row is now a pre-upgrade leftover. Each
  // hive MCP server instance runs its own process against this shared
  // database (CLAUDE.md), so a server already running OLD code at the
  // moment this migration lands keeps inserting fresh '' rows for the rest
  // of its own session's lifetime - it has no idea tmux_socket exists. That
  // is exactly why a restart is mandatory after this lane merges (see the
  // lane's own plan pad), not optional.
  //
  // Counselors round 2 (#73, A3) corrected a second overclaim in that fix:
  // restarting every such session is NECESSARY but not SUFFICIENT. A row
  // itself is never rewritten after it is written - only a fresh
  // INSERT/UPDATE at spawn or restart time writes tmux_socket - so an old
  // `hive start web` launched by pre-upgrade code leaves a long-lived
  // kind='command' row carrying '' that outlives the session that spawned
  // it entirely: restarting the MCP server does nothing to a command
  // process it never touches. That row keeps reading as "no fact recorded"
  // until it is itself stopped and restarted, same as any other pre-upgrade
  // row (D2), and the guard's full strength is bounded by whichever
  // outlives the other: the last old session, or the last old long-lived
  // command it started.
  `
ALTER TABLE agents ADD COLUMN tmux_socket TEXT NOT NULL DEFAULT '';
`,
  // /simplify pass on issue #73's own diff (efficiency finding): the
  // migration above made agents.actor_id a JOIN key on two of the
  // scheduler's hottest queries (the janitor's timers sweep and tick()'s
  // per-tick candidates fetch, both in src/scheduler.ts, both joining
  // timers.deliver_actor to agents.actor_id for D6's socket check), and
  // nothing indexed that column - every other lookup already keying on it
  // (agentProjectPin in src/context.ts, src/hook.ts, src/tools/wakes.ts,
  // src/spawn.ts) predates this migration and shares the same gap. A table
  // scan per tick is cheap while a project runs a handful of agents; it is
  // the wrong shape to leave unindexed in code whose own comments call it
  // "the hottest loop hive has".
  `
CREATE INDEX idx_agents_actor_id ON agents(actor_id);
`,
  // Issue #15. archived_at marks a todo as retired without deleting it: NULL
  // means still active, a timestamp means archived at that moment. This
  // deliberately does not mirror scratchpads' own `archived INTEGER` flag
  // (this file's first migration, above): a boolean needs nothing else, but
  // this column also has to record WHEN, since todo_archive is reversible
  // (archived=false clears it back to NULL) and a plain flag would lose that
  // fact on every toggle. Nullable with no default: NULL is "not archived"
  // with no backfill and no second column to keep in sync.
  //
  // Archived and completed are independent axes (#15's own design note, not
  // this repo's convention): never set or clear archived_at as a side effect
  // of completed_at changing, or the other way around. A todo can be
  // completed and still visible, or archived and never completed - an
  // abandoned todo is exactly what this column is for.
  //
  // todo_archive (landing in a later commit) is the only writer, in both
  // directions, mirroring pad_archive's own signature. Never derive "is this
  // archived" from anything but this column being non-NULL.
  `
ALTER TABLE todos ADD COLUMN archived_at TEXT;
`,
  // Todo 309 (dashboard v1 step 2). Bookkeeping for the scheduler's dashboard
  // generator, mirroring backup_meta's shape (an atomic conditional UPDATE
  // rate-limits which of N concurrent server instances actually acts) but
  // per PROJECT rather than one singleton row: each project opts into the
  // dashboard independently (hive.yml's `dashboard` key, superseding this
  // comment's original directory-presence design after Chris's later call -
  // see plan-dashboard-v1's decision 3), and its own file needs its own
  // claim so one busy project's writes cannot starve or rate-limit an idle
  // one's.
  //
  // last_mark is a project-scoped "did anything the dashboard renders
  // actually change" signal. It has gone through three designs, in order,
  // each measured rather than assumed and each wrong for reasons only
  // visible once tried:
  //
  //   1. PRAGMA data_version, the pad's own suggestion. Measured directly:
  //      two fresh connections with no intervening write read the identical
  //      value, and a second connection's reading visibly advances the
  //      moment a DIFFERENT connection commits - so far, as described. But a
  //      connection's OWN write never advances what that SAME connection
  //      reads back afterward, which the pad did not anticipate. A single
  //      active hive session editing its own project would then never see
  //      its own edits as dirty by this column alone.
  //   2. SQLite total_changes(), tried as a per-process supplement to cover
  //      exactly that gap. This one failed a real test, not a thought
  //      experiment: total_changes() counts every row this CONNECTION has
  //      ever changed, on every table, which includes the claim UPDATE this
  //      very generator issues on every attempt it wins. That UPDATE is a
  //      real, successful write, so it moved the counter every time,
  //      permanently pinning "something changed" to true after the first
  //      write ever succeeded - the dirty check was defeated by its own
  //      bookkeeping, forever, for any project that had been written once.
  //   3. A hand-picked set of per-column MAX() sweeps (one per table/column
  //      the render functions read), which shipped and then failed
  //      counselors: it was a SHADOW of what src/dashboard.ts's five render
  //      functions actually read, and the shadow was already wrong in
  //      several ways a real edit could hit (a body-only wake_update, an
  //      unstamped agent_rename, a hard pad_delete, two writes landing in
  //      one whole-second timestamp) - and its most expensive clause,
  //      state_log_mark, ran the same costly join the render itself does,
  //      once per agent_state_log row, defeating the entire point of a
  //      cheap pre-check.
  //
  // Replaced with a hash of the RENDERED CONTENT itself
  // (renderDashboardForWrite, src/dashboard.ts) - correct by construction,
  // since there is no second query that can drift out of sync with what
  // actually gets rendered. See that function's own comment for how it
  // deliberately excludes the page's "generated at" stamp from the hash, to
  // avoid repeating exactly the self-defeating-bookkeeping failure design 2
  // above already shipped once.
  //
  // No last_error/last_error_at the way backup_meta carries: a failed
  // generate-and-write is retried practically for free on the very next
  // claim window (five seconds, not backup's hour), and CLAUDE.md already
  // requires the write path to swallow its own failures rather than take the
  // scheduler down, so there is no operator-facing signal here worth a
  // column - unlike a failed backup, nothing is lost by a dashboard staying
  // one cycle stale. Counselors raised this again (brief-dashboard-successor
  // item C: a persistent failure is indistinguishable from an idle
  // project) and it is still accepted rather than fixed, for the same
  // reason; todo 311 (hive doctor should report PTY headroom) is the
  // proposed place for a doctor-level signal instead of a column nothing
  // reads.
  `
CREATE TABLE dashboard_meta (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_attempt_at TEXT,
  last_mark TEXT
);
`,
  // Todo 314, issue #28. One row per (wake, blocked agent, block episode) the
  // scheduler has told the wake's owner about. It exists to answer exactly
  // one question - "have we already said this?" - across the concurrent
  // scheduler instances that each session runs, which is why it is a table
  // with a primary key rather than a flag in a process.
  //
  // WHY NOT AN EXISTING COLUMN. The narrow half of this feature (a DUE wake
  // held on a dialogged pane) keys its debounce off timers.held_reason, and
  // that is genuinely all it needs. The wide half fires for a wake that is
  // NOT due and NOT held - a wake_when_idle whose watched worker is sitting
  // on a dialog, which is why it never becomes due at all - so there is no
  // hold to hang a marker on, and writing held_at for it would make
  // wake_list and `hive status` report "(1 held)" for a wake nothing ever
  // attempted to deliver. That is precisely the class of misreporting #69,
  // #70 and #75 exist to stop, so this pays for a table instead.
  //
  // blocked_since IS THE RE-ARM, and it is the whole reason this is not a
  // boolean. It is the agent's own state_changed_at at the moment hive saw
  // the dialog, so blocked -> answered -> blocked again produces a DIFFERENT
  // key (the answer moves the agent's state, and the next block stamps a new
  // time), the owner is told again, and nothing has to remember to clear a
  // flag. A boolean would report the first block of a worker's life and then
  // go quiet forever. COALESCE'd to '' by the writer for an agent whose
  // state_changed_at is NULL, so the key is never NULL and the PRIMARY KEY
  // still de-duplicates.
  //
  // ON DELETE CASCADE on both sides is bookkeeping hygiene rather than a
  // live path: nothing in src/ deletes a timers row today, and agents rows
  // are closed rather than deleted. Retention is by age, in the scheduler's
  // own pruner - see pruneStateLog (src/scheduler.ts) for why the window
  // is the state log's rather than something new.
  `
CREATE TABLE wake_block_notices (
  timer_id INTEGER NOT NULL REFERENCES timers(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  blocked_since TEXT NOT NULL,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (timer_id, agent_id, blocked_since)
);
`,
  // Todo 315, the standing watch. wake_when_idle is a one-shot: it fires once
  // and stops watching, so at three to five workers a lead that sets one and
  // goes quiet - which is what the runbook tells it to do - is structurally
  // guaranteed to miss a finish. These three schema changes are what a watch
  // that KEEPS watching needs.
  //
  // watch_scope IS A NULLABLE FLAG ON AN idle_any ROW, deliberately NOT a new
  // timers.kind value. THE REASON IS THE SCHEMA CHANGE, AND THE FIRST VERSION
  // OF THIS COMMENT GAVE A DIFFERENT REASON THAT WAS FALSE - corrected here
  // rather than quietly reworded, because it was attached to a test assertion
  // and a false reason in that position is permanent.
  //
  // THE TRUE REASON. kind carries CHECK (kind IN ('delay','idle_any',
  // 'idle_all')) above. SQLite cannot ALTER a CHECK constraint, so a new kind
  // needs the full 12-step table rebuild - on `timers`, which carries a
  // partial index and has live writers in every concurrent session, mid-flight,
  // while this migration runs. That alone is enough, and it is the whole
  // argument.
  //
  // WHAT THE FIRST VERSION CLAIMED, AND WHY IT WAS WRONG. It said an old
  // scheduler treats any non-idle_any kind as idle_all and would therefore
  // claim a standing watch as a one-shot "the moment every watched agent read
  // idle", losing every later finish. The premise is true and the conclusion
  // does not follow: maybeFireIdle's idle_all branch reads
  // `states.length > 0 && states.every(...)`, and that length guard predates
  // this lane. A standing watch stores watch='[]' under EITHER design, because
  // its membership is a query rather than a list, so an old scheduler computes
  // an empty states array and the length guard is false. Both designs degrade
  // identically: no early firing at all, one late wake at max_wait_at. The
  // flag buys nothing here that a new kind would not also buy.
  //
  // WHAT AN OLD SCHEDULER ACTUALLY DOES WORSE, which is the honest
  // mixed-version cost and is NOT about kind at all: it has no
  // noticeStillDeliverable (src/scheduler.ts), so it will type a notice whose
  // parent watch was already cancelled, or one that has sat pending for hours,
  // into a lead's pane - the exact orphan the parent link below exists to
  // prevent. That window is self-closing and ends when every session has
  // restarted onto this code, the same family as the mixed-version windows
  // #71 and #75 already accept.
  //
  // ONE COLUMN, NOT A `standing` FLAG PLUS A SCOPE. Membership is a parameter
  // - project / group / list (.claude/sessions/decisions/2026-08-08-watch-
  // membership-is-a-parameter.md) - and only 'project' ships. Two columns
  // could disagree with each other (standing with no scope, a scope that is
  // not standing) and would need a rule for what that means; one column cannot.
  // NULL means "the explicit list in `watch`, fire once", which is every row
  // written before this migration and every one-shot written after it. No
  // CHECK constraint, because ALTER TABLE cannot add one; src/tools/wakes.ts
  // is the single writer and validates the value there.
  //
  // parent_timer_id: a standing watch never fires itself, it FILES a due-now
  // notice timer to its owner. Those notices were orphans in todo 314's
  // version of this mechanism - wake_cancel updates only the row it is given,
  // and `hive lead`'s restart re-points every active lead-owned timer at the
  // fresh pane (src/cli.ts), so a stale notice could type into a lead's pane
  // days after the watch that filed it was cancelled. The link is what lets
  // wake_cancel reach the children and lets delivery refuse a notice whose
  // parent is gone. Nullable, and NULL for every notice todo 314 files, so
  // that path is unchanged. The partial index exists because the cascade in
  // wake_cancel looks rows up BY this column.
  //
  // wake_idle_notices is the CURSOR, and it is a separate table from
  // wake_block_notices rather than a fourth column on it, for two reasons.
  // Widening that table's PRIMARY KEY needs a 12-step rebuild, and - the real
  // one - a block notice and a finish notice about the same (wake, agent) in
  // the same second would collide on a shared key and one of them would be
  // silently dropped. Two tables make the discrimination structural. The
  // `condition` column then discriminates WITHIN this table, between the two
  // things a standing watch reports:
  //   'idle'  episode = the agent's own state_changed_at, the same latch
  //           wake_block_notices keys on and for the same reason: blocked ->
  //           answered -> blocked again, or working -> idle -> working ->
  //           idle, produces a different key with nothing to clear.
  //   'gone'  episode = the agent's closed_at. THIS IS THE KEY A DYING WORKER
  //           WOULD OTHERWISE NOT HAVE, and it is not optional polish: under
  //           the explicit-list wake this replaces, a watched worker that goes
  //           away fires the wake through watchedStates' GONE branch, so
  //           shipping without it would be a STRICT REGRESSION on the case
  //           that motivated watching a worker from outside at all (a turn
  //           that dies mid-response cannot report itself). Project scope
  //           makes it sharper: membership is a query over RUNNING agents, so
  //           a dead worker does not merely lack a fresh latch, it drops out
  //           of the watched set entirely. GONE's own `since` is null by
  //           construction (src/scheduler.ts) and agent_close never touches
  //           state_changed_at, so closed_at is the only moving value there
  //           is.
  // notice_timer_id records WHICH notice carried this episode, so a claim that
  // was spent without ever being typed can be told apart from one that was
  // delivered. Nullable only for the instant between the claim and the notice
  // insert inside one transaction; nothing outside that transaction ever
  // observes it NULL.
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
  // Todo 315, from the /simplify pass on this lane's own diff, and A SEPARATE
  // ENTRY RATHER THAN A LINE ADDED TO THE ONE ABOVE because MIGRATIONS is
  // append-only (.claude/rules/store-and-datadir.md). The entry above has
  // already been applied to real stores; editing it would leave those stores
  // without this index forever, since a version already in the migrations
  // table is never re-run.
  //
  // WHAT IT FIXES. pruneStateLog's retention gate reads
  // "SELECT 1 FROM wake_idle_notices WHERE notified_at < ... LIMIT 1" on every
  // tick, in every session on the machine. Without an index that is a SCAN,
  // and with it a SEARCH on a covering index - checked with EXPLAIN QUERY PLAN
  // over a 5,000-row scratch store, which is the whole argument. An earlier
  // version of this comment also carried a millisecond figure for the scan;
  // it was relayed from a /simplify agent rather than measured by anyone who
  // wrote this line (.claude/sessions/decisions/2026-08-06-a-relayed-finding-
  // is-not-a-verified-one.md), and a number that reads as evidence and is not
  // is worse here than no number. The plan difference is the evidence. The
  // wake_block_notices gate beside it has the same shape and no index, and
  // that was fine on the evidence available: its own migration comment says
  // notified_at is not indexed and the matching case is a scan, accepted
  // because the table is empty on nearly every machine. THIS TABLE IS THE ONE
  // WHERE THAT ARGUMENT DOES NOT HOLD - a standing watch writes a row per
  // crew member per finish for its whole life, and retention keeps them for
  // seven days, so the table is designed to be non-empty during exactly the
  // workflow this lane is asking leads to adopt. The scan would grow with
  // adoption, which is the wrong direction for a per-tick read.
  `
CREATE INDEX idx_wake_idle_notices_notified ON wake_idle_notices(notified_at);
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
