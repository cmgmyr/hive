import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, describe, it } from "node:test";
import { assertScratchStore, clearHiveEnv, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
after(() => rmSync(dirname(dirs.dataDir), { recursive: true, force: true }));

const { codexHomeDir, findCodexFork, readCodexForkSeed, seedCodexFork } = await import("../dist/codexHome.js");
let serial = 0;

function sourceFixture({ sessionId = randomUUID(), metadataId = sessionId, transcriptPath, homeKey } = {}) {
  const key = homeKey ?? `source-${serial++}`;
  const home = codexHomeDir(key);
  const sessions = join(home, "sessions", "2026", "11", "01");
  mkdirSync(sessions, { recursive: true });
  const transcript = transcriptPath ?? join(sessions, `rollout-${sessionId}.jsonl`);
  if (transcriptPath === undefined) {
    writeFileSync(transcript,
      JSON.stringify({ type: "session_meta", payload: { id: metadataId, session_id: metadataId } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { text: "completed source turn" } }) + "\n" +
      "{\"type\":\"incomplete",
    );
  }
  return {
    row: {
      id: serial + 1,
      command: "codex",
      codex_home: key,
      session_id: sessionId,
      transcript_path: transcript,
    },
    home,
    transcript,
  };
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Codex fork seeding copies only complete source rollout records", () => {
  it("seeds an owned parent rollout into the fresh home and leaves the source bytes alone", () => {
    const f = sourceFixture();
    const before = sha(f.transcript);
    const seed = readCodexForkSeed(f.row);
    const childKey = `child-${serial++}`;
    seedCodexFork(f.row, childKey, seed);

    const childSessions = join(codexHomeDir(childKey), "sessions");
    const childRollouts = readdirSync(join(childSessions, "2026", "11", "01"));
    assert.deepEqual(childRollouts, [`rollout-${f.row.session_id}.jsonl`]);
    const copied = join(childSessions, relative(join(f.home, "sessions"), f.transcript));
    assert.equal(lstatSync(copied).isSymbolicLink(), false);
    assert.equal(sha(f.transcript), before);
    assert.equal(sha(copied), createHash("sha256").update(seed.contents).digest("hex"));
    assert.equal(readFileSync(copied, "utf8").endsWith("{\"type\":\"incomplete"), false);
    assert.equal(findCodexFork(childKey, f.row.session_id), null, "the imported parent rollout is not a child match");
  });

  it("discovers only a new rollout whose metadata names the captured source session", () => {
    const f = sourceFixture();
    const childKey = `child-${serial++}`;
    seedCodexFork(f.row, childKey);
    const childId = randomUUID();
    const childDir = join(codexHomeDir(childKey), "sessions", "2026", "11", "01");
    const path = join(childDir, `rollout-${childId}.jsonl`);
    writeFileSync(path, JSON.stringify({
      type: "session_meta",
      payload: { id: childId, session_id: childId, forked_from_id: f.row.session_id },
    }) + "\n{incomplete");

    assert.deepEqual(findCodexFork(childKey, f.row.session_id), { sessionId: childId, transcriptPath: path });
  });

  it("refuses source metadata that does not match the recorded session id", () => {
    const f = sourceFixture({ metadataId: randomUUID() });
    assert.throws(() => readCodexForkSeed(f.row), /metadata\.id does not match/);
  });

  it("refuses a transcript symlink that resolves outside the source home", () => {
    const f = sourceFixture();
    const outside = join(dirs.tmp, "outside-rollout.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id: f.row.session_id } }) + "\n");
    const link = join(f.home, "sessions", "2026", "11", "01", "rollout-link.jsonl");
    symlinkSync(outside, link);
    f.row.transcript_path = link;
    assert.throws(() => readCodexForkSeed(f.row), /outside its recorded CODEX_HOME/);
  });

  it("reports malformed and multiple child rollout matches instead of choosing the newest file", () => {
    const f = sourceFixture();
    const childKey = `child-${serial++}`;
    seedCodexFork(f.row, childKey);
    const dir = join(codexHomeDir(childKey), "sessions", "2026", "11", "01");
    writeFileSync(join(dir, "rollout-malformed.jsonl"), JSON.stringify({
      type: "session_meta", payload: { forked_from_id: f.row.session_id },
    }) + "\n");
    assert.throws(() => findCodexFork(childKey, f.row.session_id), /malformed session metadata/);

    writeFileSync(join(dir, "rollout-malformed.jsonl"), JSON.stringify({
      type: "session_meta", payload: { id: randomUUID(), forked_from_id: f.row.session_id },
    }) + "\n");
    writeFileSync(join(dir, "rollout-second.jsonl"), JSON.stringify({
      type: "session_meta", payload: { id: randomUUID(), forked_from_id: f.row.session_id },
    }) + "\n");
    assert.throws(() => findCodexFork(childKey, f.row.session_id), /Found 2 Codex rollouts/);
  });
});
