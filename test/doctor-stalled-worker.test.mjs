import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  promotedCount,
  REPO,
  runCli,
  scratchDirs,
  warningCount,
} from "./helpers.mjs";

// TODO 391, THE SECOND SURFACE. The push half (noteStalledCrew,
// src/scheduler.ts) reaches a lead that has ARMED A STANDING WATCH. This todo
// was filed from a report where the lead had every check it knew about
// running, and the machine that most needs the fact may have no watch at all -
// so `hive doctor` is a required half of the lane rather than a follow-up, as
// todo 391's own body proposed in terms.
//
// WHAT THIS FILE PINS:
//   1. IT FIRES, by name, with the sentence that says what hive OBSERVED - the
//      latch's age AND the transcript's silence, which are two different facts.
//   2. THE DISCRIMINATION IS THE TRANSCRIPT, NOT THE LATCH. A worker with an
//      equally ancient latch and a fresh transcript is working normally: of
//      four such workers checked against the live store, THREE WERE ALIVE.
//   3. BOTH ARMS. A `waiting` worker whose pane shows no dialog is reported;
//      one whose pane cannot be read is not. Narrowing this check to
//      `working` alone must fail here.
//   4. IT IS INFORMATION, NEVER A GATE. Plain warn(), so --strict does not
//      promote it (decisions/2026-08-07-strict-promotes-only-gating-warns.md).
// Plus the zero case, printed rather than silent, and the same two skips the
// push half has.
const { hasTmux, cleanup } = isolateTmux("the doctor stalled-worker tests");
clearHiveEnv();

const { dataDir, projectDir, tmp } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
// Claude Code relocates its whole state tree - transcripts included - when
// this is set, so hive resolves a worker's transcript under a directory this
// file owns rather than the developer's real ~/.claude.
const configDir = join(tmp, "claude-config");
const opts = {
  cwd: projectDir,
  env: { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR, CLAUDE_CONFIG_DIR: configDir },
};

await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

writeFileSync(join(projectDir, "hive.yml"), "profile: orchestration\n");
const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);

const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id;

// The same convention test/doctor-unbriefed-worker.test.mjs uses: a path that
// cannot exist, so foreignSocket() answers true with no real server involved.
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const WORKER_CWD = "/tmp/stalled-worker";
const STALE = 30 * 60;
const FRESH = 5;

// ONE REAL PANE FOR THE WHOLE FILE, and only arm 2 needs it: its evidence is a
// FRESH, DEFINITE `awaitingChoice === false`, which no synthetic fixture can
// supply. A bare session with one pane showing a captured idle screen is
// enough - no MCP server and no fake claude, because nothing here is about
// spawning.
const SESSION = "stall-doctor-pane";
let livePane = "%9600";
if (hasTmux) {
  const screen = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");
  execFileSync("tmux", [
    "new-session", "-d", "-s", SESSION, "-x", "220", "-y", "50",
    "sh", "-c", `cat '${screen}'; sleep 600`,
  ]);
  livePane = execFileSync("tmux", ["list-panes", "-t", `=${SESSION}`, "-F", "#{pane_id}"], {
    encoding: "utf8",
  }).trim();
}

after(() => cleanup(SESSION));

// created_at is left at its default (now) deliberately, exactly as the sibling
// file does: it keeps the row inside janitor()'s spawn-race guard, so doctor's
// own janitor call cannot close the row out from under the assertion. The
// latch age under test is an independent column.
function worker(name, latchedAgo, { state = "working", socket = "", command = "claude", sessionId, pane } = {}) {
  const changedAt =
    latchedAgo === null ? null : new Date(Date.now() - latchedAgo * 1000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind,
        agent_state, state_changed_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 'agent', ?, ?, ?)`,
  ).run(
    project,
    `agent:${name}`,
    name,
    pane ?? "%9600",
    socket,
    command,
    WORKER_CWD,
    state,
    changedAt,
    sessionId === undefined ? `sid-${name}` : sessionId,
  );
}

// The transcript Claude Code would have written, at a chosen age.
function transcript(sessionId, ageSeconds) {
  const dir = join(configDir, "projects", WORKER_CWD.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"assistant"}\n');
  const when = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, when, when);
}

const reset = () => db.exec("DELETE FROM agents;");

describe(
  "hive doctor names a worker whose turn appears to have stopped progressing",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("names the worker, its latch age, and how long its transcript has been quiet", async () => {
      reset();
      worker("dead-turn", 47 * 60);
      transcript("sid-dead-turn", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}worker dead-turn: has claimed `working` for 47m and its transcript has not been written for 30m/,
        `the warn must carry BOTH facts, since one without the other is the reading that is wrong 3 times in 4; got: ${stdout}`,
      );
      assert.match(
        stdout,
        /worker dead-turn:[^\n]*(\n {8}[^\n]*)*TELL IT WHAT STATE YOU FOUND/,
        "the remedy worker-state.md prescribes has to be in the report, not left to the reader to remember",
      );
    });

    // THE DISCRIMINATING CASE. Identical latch, different transcript. F1
    // measured this against the live store: of four workers with an ancient
    // `working` latch checked against their own transcripts, three were alive
    // and writing. A check keyed on the latch fires four times and is wrong
    // three times, which is a check a reader learns to skip.
    it("says nothing about a worker with an equally ancient latch and a live transcript", async () => {
      reset();
      worker("busy", 47 * 60);
      transcript("sid-busy", FRESH);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker busy: has claimed/,
        `a worker inside one long tool call is not a stall; got: ${stdout}`,
      );
      assert.match(
        stdout,
        /info {2}stalled workers: 1 worker\(s\) latched working\/waiting, none stalled past 15m/,
        "the count still has to be reported, or a healthy run reads as a check that never ran",
      );
    });

    // A MISSING FILE IS NOT A SKIP: the turn died before its first transcript
    // write, which is an API error at turn start and one of the two failures
    // this feature was filed for. Its own sentence, because a report that
    // mis-describes its own evidence is one a reader stops believing.
    it("reports a worker that never wrote a transcript, with its own sentence", async () => {
      reset();
      worker("never-wrote", 47 * 60);

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /warn {2}worker never-wrote: has claimed `working` for 47m and has never written a transcript/);
      assert.doesNotMatch(
        stdout,
        /never-wrote:[^\n]*transcript has not been written for/,
        "it must not claim a staleness it never measured",
      );
    });

    // ARM 2 IN DOCTOR. Without this row, narrowing the check to
    // `agent_state = 'working'` passes every other case in this file - and arm
    // 2 covers the commonest death shape on a machine that actually prompts,
    // since a turn that dies after a permission prompt is latched `waiting`.
    it("reports a `waiting` worker whose real pane shows no dialog", async () => {
      reset();
      worker("prompted", 47 * 60, { state: "waiting", pane: livePane });
      transcript("sid-prompted", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}worker prompted: has claimed `waiting` for 47m, its pane shows no dialog, and its transcript has not been written for 30m/,
        `arm 2 must fire, and must say what it actually checked; got: ${stdout}`,
      );
    });

    // AN UNANSWERED PROBE IS NO FACT, NEVER "no dialog". This row's pane id
    // exists on no server this process can reach, so paneChoiceCheck answers
    // null - and being wrong in the permissive direction means telling a
    // reader that a worker sitting on a live dialog has a dead turn.
    it("says nothing about a `waiting` worker whose pane could not be read", async () => {
      reset();
      worker("unreadable", 47 * 60, { state: "waiting" });
      transcript("sid-unreadable", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker unreadable: has claimed/,
        `an unanswered probe is not evidence that no dialog is up; got: ${stdout}`,
      );
      // It is still COUNTED - the row is latched and past the bound, and the
      // count is about the population this check looked at, not about what it
      // could conclude.
      assert.match(stdout, /info {2}stalled workers: 1 worker\(s\) latched working\/waiting/);
    });

    it("prints its line at zero too, rather than going silent", async () => {
      reset();
      worker("idle-worker", null, { state: "idle" });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /info {2}stalled workers: 0 worker\(s\) latched working\/waiting/);
      assert.doesNotMatch(stdout, /worker idle-worker: has claimed/);
    });

    // THE SKIP LIST IS EXACTLY TWO, and it is the push half's. A bash worker
    // fires no hooks and writes no transcript, so it would be named on every
    // run for the life of the row with a remedy that cannot work; a row with
    // no session_id has no transcript path to resolve at all.
    it("says nothing about a non-claude worker or one with no session id", async () => {
      reset();
      worker("shell", 47 * 60, { command: "bash" });
      worker("nosid", 47 * 60, { sessionId: "" });
      // The bash worker even has a stale transcript sitting exactly where hive
      // would resolve one for it, so the gate is doing the work here.
      transcript("sid-shell", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /worker shell: has claimed/, `a row with no state channel cannot be judged; got: ${stdout}`);
      assert.doesNotMatch(stdout, /worker nosid: has claimed/);
      assert.match(stdout, /info {2}stalled workers: 0 worker\(s\) latched working\/waiting/);
    });

    // THE FOREIGN-SOCKET RULE IS ARM 2'S, NOT THE POPULATION'S, and these two
    // cases are a PAIR: one pins each direction, and either alone leaves the
    // rule unpinned on the other side.
    //
    // THIS FILE ASSERTED THE OPPOSITE UNTIL THE PR GATE FOUND IT. The single
    // case here seeded a `working` foreign-socket row and asserted doctor said
    // NOTHING about it - pinning the defect rather than the behaviour, which is
    // test/CLAUDE.md's "a test asserting the OLD behaviour" verbatim. The
    // filter ran before the arm split, so a worker latched `working` on a
    // socket this process cannot see into, with a transcript quiet past the
    // bound, was reported by the standing watch and silently dropped by doctor
    // - in the no-watch-armed population doctor is the half FOR.
    it("reports a `working` worker on a socket this process cannot see into", async () => {
      // ARM 1 MAKES NO CLAIM ABOUT A PANE. The evidence is the row's own latch
      // and a statSync on a transcript path built from `cwd` and `session_id`,
      // and neither of those becomes unreadable because the pane lives on
      // another server. Foreign-socket conservatism is about not believing a
      // PANE, so it has nothing to say here.
      reset();
      worker("elsewhere", 90 * 60, { socket: FOREIGN_SOCKET });
      transcript("sid-elsewhere", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}worker elsewhere: has claimed `working` for 1h and its transcript has not been written for 30m/,
        `arm 1 judges the store and the transcript, both readable from here; got: ${stdout}`,
      );
      // The control that keeps this honest about which report said what:
      // doctor's stuck-row warn still fires for the same row, and it says a
      // DIFFERENT thing - that liveness cannot be judged from here, never that
      // the turn appears to have died. A reader acts on the two differently,
      // which is why one cannot stand in for the other.
      assert.match(stdout, /warn {2}agent elsewhere: recorded on tmux socket/);
    });

    it("still says nothing about a `waiting` worker on a socket it cannot see into", async () => {
      // ARM 2's evidence IS a pane read, and this pane cannot be read from
      // here at all: probing that pane id against THIS process's server would
      // capture whatever stranger's pane happens to hold it (issue #73). So
      // the refusal stays - it just belongs to this arm rather than to the
      // whole population.
      reset();
      worker("elsewhere-waiting", 90 * 60, { state: "waiting", socket: FOREIGN_SOCKET });
      transcript("sid-elsewhere-waiting", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker elsewhere-waiting: has claimed/,
        `arm 2 cannot say "its pane shows no dialog" about a pane it cannot see; got: ${stdout}`,
      );
      // COUNTED, NOT CONCLUDED ABOUT, and this is the assertion that carries
      // the pair. The row is latched and past the bound, so it is part of the
      // population this check looked at - which is exactly what a
      // population-wide filter destroys. Restoring that filter turns this 1
      // into a 0 and takes the case above red at the same time, so the two
      // together pin the rule in both directions. Proven by running that
      // mutation.
      assert.match(stdout, /info {2}stalled workers: 1 worker\(s\) latched working\/waiting/);
      assert.match(stdout, /warn {2}agent elsewhere-waiting: recorded on tmux socket/);
      // SAY WHAT THIS DOES NOT PIN. The silence above is satisfied by TWO
      // indistinguishable causes: arm 2's foreign-socket refusal, and a
      // `paneChoiceCheck` that runs anyway and answers null because no such
      // pane exists on this process's server. Deleting the refusal alone
      // leaves this test green. That is test/CLAUDE.md's "an assertion
      // satisfied by two indistinguishable causes", and it is recorded rather
      // than papered over: separating them needs a live stranger's pane
      // answering `false` under the foreign row's own id, which is the
      // cross-server confusion issue #73 exists to prevent and not something
      // this suite can stage. The COUNT above is the half that does
      // discriminate, and it is why this case asserts it.
    });

    it("is information, never a gate: --strict does not promote it", async () => {
      // A DELTA ACROSS TWO RUNS, NOT AN EXIT CODE. Comparing exit codes proves
      // nothing on a box already failing for an unrelated reason, and this
      // suite's own environment carries a pre-existing gating warn
      // (test/CLAUDE.md's "a saturated comparison").
      reset();
      const before = await runCli(["doctor", "--strict"], opts);
      worker("stalled-strict", 90 * 60);
      transcript("sid-stalled-strict", STALE);
      const after = await runCli(["doctor", "--strict"], opts);

      assert.match(after.stdout, /worker stalled-strict: has claimed `working` for 1h/);
      assert.equal(
        warningCount(after.stdout) - warningCount(before.stdout),
        1,
        "the control: this run must differ from the previous one by exactly this warn",
      );
      assert.equal(
        promotedCount(after.stdout) - promotedCount(before.stdout),
        0,
        "--strict must not promote this warn",
      );
    });
  },
);
