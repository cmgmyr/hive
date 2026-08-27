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

const { hasTmux, cleanup } = isolateTmux("the doctor stalled-worker tests");
clearHiveEnv();

const { dataDir, projectDir, tmp } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;

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

const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const WORKER_CWD = "/tmp/stalled-worker";
const STALE = 30 * 60;
const FRESH = 5;

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

function worker(
  name,
  latchedAgo,
  { state = "working", socket = "", command = "claude", sessionId, transcriptPath = "", pane } = {},
) {
  const changedAt =
    latchedAgo === null ? null : new Date(Date.now() - latchedAgo * 1000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind,
        agent_state, state_changed_at, session_id, transcript_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 'agent', ?, ?, ?, ?)`,
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
    transcriptPath,
  );
}

function transcript(sessionId, ageSeconds) {
  const dir = join(configDir, "projects", WORKER_CWD.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"assistant"}\n');
  const when = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(path, when, when);
}

// Codex hands hive the exact rollout file through its own hook payload (agents.transcript_path),
// never a cwd-resolved directory - written anywhere, deliberately outside configDir.
function codexTranscript(path, ageSeconds) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, '{"type":"response_item"}\n');
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

      assert.match(stdout, /info {2}stalled workers: 1 worker\(s\) latched working\/waiting/);
    });

    it("prints its line at zero too, rather than going silent", async () => {
      reset();
      worker("idle-worker", null, { state: "idle" });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /info {2}stalled workers: 0 worker\(s\) latched working\/waiting/);
      assert.doesNotMatch(stdout, /worker idle-worker: has claimed/);
    });

    it("says nothing about a non-claude worker or one with no session id", async () => {
      reset();
      worker("shell", 47 * 60, { command: "bash" });
      worker("nosid", 47 * 60, { sessionId: "" });

      transcript("sid-shell", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /worker shell: has claimed/, `a row with no state channel cannot be judged; got: ${stdout}`);
      assert.doesNotMatch(stdout, /worker nosid: has claimed/);
      assert.match(stdout, /info {2}stalled workers: 0 worker\(s\) latched working\/waiting/);
    });

    it("says nothing about a codex worker with no transcript_path recorded yet, with no transcript() call at all - proving the row is excluded before transcriptStaleness ever runs, not merely that its wrong claude-shaped path happens to miss", async () => {
      reset();
      worker("codex-worker", 47 * 60, { command: "codex" });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker codex-worker: has claimed/,
        `no hook payload has ever carried a transcript_path for this row to corroborate against; got: ${stdout}`,
      );
      assert.match(stdout, /info {2}stalled workers: 0 worker\(s\) latched working\/waiting/);
    });

    it("reports a codex worker whose stored transcript_path file has gone quiet (todo 591)", async () => {
      reset();
      const path = join(tmp, "codex-home", "sessions", "rollout-stale.jsonl");
      worker("codex-stale", 47 * 60, { command: "codex", transcriptPath: path });
      codexTranscript(path, STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}worker codex-stale: has claimed `working` for 47m and its transcript has not been written for 30m/,
        `codex's stored path corroborates a stall exactly like claude's resolved one; got: ${stdout}`,
      );
    });

    it("says nothing about a codex worker whose stored transcript_path file is fresh", async () => {
      reset();
      const path = join(tmp, "codex-home", "sessions", "rollout-fresh.jsonl");
      worker("codex-fresh", 47 * 60, { command: "codex", transcriptPath: path });
      codexTranscript(path, FRESH);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /worker codex-fresh: has claimed/, `got: ${stdout}`);
      assert.match(stdout, /info {2}stalled workers: 1 worker\(s\) latched working\/waiting, none stalled/);
    });

    it("never reports a codex worker whose stored transcript_path file is gone -- a missing file is never a stall", async () => {
      reset();
      worker("codex-reaped", 47 * 60, {
        command: "codex",
        transcriptPath: join(tmp, "codex-home", "sessions", "reaped-away.jsonl"),
      });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker codex-reaped: has claimed/,
        `unlike claude's 'never wrote a transcript at all', a stale recorded path pointing nowhere ` +
          `must not read as a stall - agent_close reaps CODEX_HOME; got: ${stdout}`,
      );
      assert.match(stdout, /info {2}stalled workers: 1 worker\(s\) latched working\/waiting, none stalled/);
    });

    it("reports a `working` worker on a socket this process cannot see into", async () => {

      reset();
      worker("elsewhere", 90 * 60, { socket: FOREIGN_SOCKET });
      transcript("sid-elsewhere", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}worker elsewhere: has claimed `working` for 1h and its transcript has not been written for 30m/,
        `arm 1 judges the store and the transcript, both readable from here; got: ${stdout}`,
      );

      assert.match(stdout, /warn {2}agent elsewhere: recorded on tmux socket/);
    });

    it("still says nothing about a `waiting` worker on a socket it cannot see into", async () => {

      reset();
      worker("elsewhere-waiting", 90 * 60, { state: "waiting", socket: FOREIGN_SOCKET });
      transcript("sid-elsewhere-waiting", STALE);

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker elsewhere-waiting: has claimed/,
        `arm 2 cannot say "its pane shows no dialog" about a pane it cannot see; got: ${stdout}`,
      );

      assert.match(stdout, /info {2}stalled workers: 1 worker\(s\) latched working\/waiting/);
      assert.match(stdout, /warn {2}agent elsewhere-waiting: recorded on tmux socket/);

    });

    it("is information, never a gate: --strict does not promote it", async () => {

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
