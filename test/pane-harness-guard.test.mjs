import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { DIST, isolateTmux, makeFakeClaude, McpClient, runFixture, scratchDirs, until } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the pane-harness guard tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

const NEEDS_TMUX = { skip: hasTmux ? false : "tmux is not installed" };

let mcp;

before(async () => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir]);
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "2000" } });
  await mcp.start();
});

after(async () => {
  if (mcp) await mcp.close();
  cleanup(sessionName());
});

const fakeClaude = makeFakeClaude(dirs.tmp);

async function spawn(name, command) {
  const receipt = await mcp.call("agent_spawn", { name, command, extra_args: [], placement: "window" });
  await until(async () => (await mcp.call("agent_output", { name })).output.trim() !== "");
  return receipt;
}

describe("a wake is refused at the door when its target's harness cannot be classified (todo 507)", () => {
  it("wake_set refuses a shell target, naming the mechanism rather than reporting it later as a timeout", NEEDS_TMUX, async () => {
    const { agent_id } = await spawn("pg-wake-shell", "bash");

    await assert.rejects(
      mcp.call("wake_set", { delay_seconds: 5, body: "MARKERWAKE", deliver_to: agent_id }),
      (err) => {
        assert.match(err.message, /only classify a claude screen/);
        assert.match(err.message, /keys/, "the refusal must name a remedy the caller can reach");
        return true;
      },
    );
  });

  it("wake_when_idle refuses the same target, since both tools resolve delivery through one path", NEEDS_TMUX, async () => {
    const { agent_id } = await spawn("pg-idle-shell", "bash");
    const watched = await spawn("pg-idle-watched", fakeClaude("sleep 600"));

    await assert.rejects(
      mcp.call("wake_when_idle", {
        agents: [watched.agent_id],
        body: "MARKERWAKE",
        deliver_to: agent_id,
        max_wait_seconds: 900,
      }),
      /only classify a claude screen/,
    );
  });

  it("still accepts a claude target, so the refusal is about the harness and not about wakes", NEEDS_TMUX, async () => {
    const { agent_id } = await spawn("pg-wake-claude", fakeClaude("sleep 600"));
    const wake = await mcp.call("wake_set", { delay_seconds: 900, body: "MARKERWAKE", deliver_to: agent_id });
    assert.ok(wake.wake_id, "a classifiable target must still be accepted");
    await mcp.call("wake_cancel", { wake_id: wake.wake_id });
  });
});

// Delivery-side backstop. The door above cannot cover a timer set before it shipped, nor one whose
// target row changed command underneath it: `hive lead` UPDATEs agents.command on every run, and the
// delivery join resolves the row by actor_id at delivery time, not at creation.
//
// ONE WAKE PER RUN, deliberately. tick()'s loop is wrapped in a single try/catch, so a delivery that
// throws (these panes are synthetic and no tmux server has them) skips every later candidate - three
// wakes in one tick left the two controls silently unreached and passing.
function tickOne({ command, deliverActor = "agent:1" }) {
  const { dataDir, tmp } = scratchDirs();
  const seedAgent =
    command === null
      ? ""
      : `db.prepare(\`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
` +
        `   VALUES (?, 'agent:1', 'target', 'agent', '%pane', ?, '/tmp', 'running', 'idle', datetime('now', '-60 seconds'))\`).run(project, ${JSON.stringify(command)});\n`;
  return runFixture(
    tmp,
    `unclassifiable-pane-${command ?? "no-row"}`.replace(/[^a-z0-9-]/gi, "-"),
    `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
      `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
      `migrate();\n` +
      `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('pane-guard', '/tmp/pane-guard') RETURNING id").get().id;\n` +
      seedAgent +
      `const id = db.prepare(\`INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
` +
      `   VALUES (?, 'owner:1', 'MARKERBODY', 'delay', '[]', ?, '%pane', datetime('now', '-1 seconds'), datetime('now', '-60 seconds')) RETURNING id\`)\n` +
      `  .get(project, ${JSON.stringify(deliverActor)}).id;\n` +
      `const joined = db.prepare(\`SELECT COALESCE(agents.command, '') AS c FROM wakes
` +
      `   LEFT JOIN agents ON agents.id = (SELECT a.id FROM agents a WHERE a.actor_id = wakes.deliver_actor ORDER BY (a.status = 'running') DESC, a.id DESC LIMIT 1)
` +
      `   WHERE wakes.id = ?\`).get(id).c;\n` +
      `try { await tick({ panes: new Set(['%pane']), windows: new Set() }); } catch {}\n` +
      `const row = db.prepare("SELECT held_reason, typed_at, fired_at FROM wakes WHERE id = ?").get(id);\n` +
      `process.stdout.write(JSON.stringify({ joined, ...row }));`,
    { HIVE_DATA_DIR: dataDir },
  );
}

const UNCLASSIFIABLE = /not one hive can classify/;

describe("the delivery-side backstop, for wakes the door could not have caught (todo 507)", () => {
  it("holds a shell target, types nothing, and says in the reason that this hold never clears", () => {
    const out = tickOne({ command: "bash" });
    assert.equal(out.joined, "bash", "the join must actually carry the command, or the rest proves nothing");
    assert.match(out.held_reason ?? "", UNCLASSIFIABLE);
    assert.match(
      out.held_reason ?? "",
      /Nothing hive does on its own clears this/,
      "a hold nothing lifts on its own has to say so, and has to name what does lift it",
    );
    assert.match(out.held_reason ?? "", /hive lead. after the pane exits/);
    assert.equal(out.typed_at, null, "nothing may be typed into a pane hive cannot classify");
    assert.equal(out.fired_at, null, "and it must not be claimed either - after the claim, 'not now' is 'never'");
  });

  it("lets a claude target through the same check, proven by the claim rather than by an absent hold", () => {
    const out = tickOne({ command: "claude" });
    assert.equal(out.joined, "claude");
    assert.doesNotMatch(out.held_reason ?? "", UNCLASSIFIABLE, "the guard must not fire on a classifiable pane");
    // Proof of REACH, not an absence: this synthetic pane is unreadable, so a timer that got past the
    // harness gate lands on the NEXT gate and names it. An unreached timer has held_reason null.
    assert.ok(
      out.fired_at,
      "fired_at is the proof this timer was REACHED: a null held_reason alone is also what an unreached timer looks like",
    );
  });

  it("lets a target with NO agents row through, which is a plain session waking its own pane", () => {
    const out = tickOne({ command: null, deliverActor: "agent:9" });
    assert.equal(out.joined, "", "no agents row behind this timer - the shape resolveDelivery's TMUX_PANE fallback makes");
    assert.doesNotMatch(
      out.held_reason ?? "",
      UNCLASSIFIABLE,
      "AN EMPTY COMMAND IS NO-FACT-RECORDED. Reading it as unclassifiable stops every wake a plain session ever set for itself - a silent outage, not a safety fix",
    );
    assert.ok(out.fired_at, "and it must actually have been REACHED and passed the harness gate, not merely left unheld");
  });
});

const findWake = (wakes, wakeId) => wakes.find((w) => w.wake_id === wakeId);

describe("a plain session's wake to its own pane still delivers, end to end (todo 507)", () => {
  it("delivers into a pane reached through the TMUX_PANE fallback, where no agents row records a command at all", NEEDS_TMUX, async () => {
    const pane = execFileSync(
      "tmux",
      ["new-window", "-P", "-F", "#{pane_id}", "-t", `=${sessionName()}`, "-d", "-c", dirs.projectDir, "cat"],
      { encoding: "utf8" },
    ).trim();

    const plain = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { TMUX_PANE: pane, HIVE_ACTOR: "user:plain-session" },
    });
    await plain.start();
    try {
      const wake = await plain.call("wake_set", { delay_seconds: 1, body: "MARKERORPHAN" });
      assert.ok(wake.wake_id, "creation must not refuse a target with no agents row behind it");

      // Assert the STORE first, independent of any screen read - wait for a TERMINAL delivery
      // state (typed_at or held_at), not mere row presence, or the claim/type gap reads as "never typed".
      // Own bound: typed_at lands ~ENTER_DELAY_MS after render and the scheduler ticks every 3000ms,
      // so the render-poll's bound would race healthy delivery; condition-wait, not a widened bound (todo 422).
      let record;
      const resolved = await until(async () => {
        record = findWake((await plain.call("wake_list")).recently_delivered, wake.wake_id);
        return record !== undefined && (record.typed_at != null || record.held_at != null);
      }, 6000);
      assert.ok(
        resolved,
        record
          ? `hive never typed it: wake #${wake.wake_id} is still stuck with no typed_at and no ` +
            `held_at - ${JSON.stringify(record)}`
          : `wake #${wake.wake_id} never showed up in recently_delivered at all - the scheduler ` +
            "never reached it (still pending, or fell out of the last-10 window)",
      );
      assert.ok(
        record.typed_at,
        `hive never typed it: held_at=${record.held_at}, held_reason=${record.held_reason} for ` +
          `wake #${wake.wake_id} - ${JSON.stringify(record)}`,
      );

      // Condition-wait under the SAME pre-existing bound, unchanged - fails fast, not a widened
      // timeout (todo 422).
      const rendered = await until(async () => {
        const seen = execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
        return /MARKERORPHAN/.test(seen);
      });

      const seen = execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
      assert.ok(
        rendered,
        `hive typed it and the screen never rendered it: typed_at=${record.typed_at}, ` +
          `typed_seen=${record.typed_seen}, confirmation=${record.confirmation}, ` +
          `screen=${JSON.stringify(seen)}`,
      );
      assert.match(seen, /MARKERORPHAN/, "assert the PANE - the wake has to actually arrive, not merely be accepted");
    } finally {
      await plain.close();
      execFileSync("tmux", ["kill-pane", "-t", pane]);
    }
  });
});

describe("an UNREADABLE pane is a third outcome, and agent_send must not read it as \"no dialog\" (todo 507)", () => {
  it("refuses text when the pane cannot be read, and says which of the two refusals this is", NEEDS_TMUX, async () => {
    const name = "pg-unreadable";
    await spawn(name, fakeClaude(`cat '${join(dirs.tmp, "..", "nonexistent")}' 2>/dev/null; sleep 600`));

    const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
    const shimDir = join(dirs.tmp, "capture-fails");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "capture-pane" ] && exit 9; done\nexec ${JSON.stringify(realTmux)} "$@"\n`,
    );
    chmodSync(join(shimDir, "tmux"), 0o755);

    const blind = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { PATH: `${shimDir}:${process.env.PATH}` },
    });
    await blind.start();
    let receipt;
    try {
      receipt = await blind.call("agent_send", { name, text: "MARKERBLIND" });
    } finally {
      await blind.close();
    }

    assert.equal(receipt.sent, false, "an unreadable pane must refuse, not fall through to typing");
    assert.match(receipt.note, /could not be read/);
    assert.doesNotMatch(
      receipt.note,
      /waiting on a choice/,
      "the two refusals must stay distinguishable - one is a dialog seen, the other is nothing seen",
    );

    const { output } = await mcp.call("agent_output", { name });
    assert.doesNotMatch(output, /MARKERBLIND/, "assert the PANE: nothing may be typed into a pane hive could not read");
  });

  it("exempts submit=false on an unreadable pane, since the destructive event is the Enter and there is none", NEEDS_TMUX, async () => {
    const name = "pg-unreadable-nosubmit";
    await spawn(name, fakeClaude("sleep 600"));

    const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
    const shimDir = join(dirs.tmp, "capture-fails-nosubmit");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "capture-pane" ] && exit 9; done\nexec ${JSON.stringify(realTmux)} "$@"\n`,
    );
    chmodSync(join(shimDir, "tmux"), 0o755);

    const blind = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { PATH: `${shimDir}:${process.env.PATH}` },
    });
    await blind.start();
    let receipt;
    try {
      receipt = await blind.call("agent_send", { name, text: "MARKERNOSUBMIT", submit: false });
    } finally {
      await blind.close();
    }

    assert.notEqual(receipt.sent, false, "submit=false must not be refused for an unreadable pane");

    const { output } = await mcp.call("agent_output", { name });
    assert.match(output, /MARKERNOSUBMIT/, "assert the PANE - the paste has to have actually landed");
  });

  it("still sends when the pane reads cleanly, so the refusal is about the third outcome and not about sending", NEEDS_TMUX, async () => {
    const name = "pg-readable";
    await spawn(name, fakeClaude("sleep 600"));
    const receipt = await mcp.call("agent_send", { name, text: "MARKERREADABLE" });
    assert.equal(receipt.sent, true, "a readable pane with no dialog must still be sent to");
  });
});

// A lead's own pane is the one a human types into, and hive.yml's `lead:` accepts any command, so a
// non-claude LEAD is reachable configuration rather than a hypothetical.
describe("a lead whose own harness hive cannot classify cannot receive wakes at all (todo 507)", () => {
  it("refuses a wake_set aimed at it, so the whole wake system is closed to such a lead rather than one call failing", NEEDS_TMUX, async () => {
    const { db } = await import("../dist/db.js");
    const projectId = (await mcp.call("whoami")).project.id;

    const pane = execFileSync(
      "tmux",
      ["new-window", "-P", "-F", "#{pane_id}", "-t", `=${sessionName()}`, "-d", "-c", dirs.projectDir, "cat"],
      { encoding: "utf8" },
    ).trim();
    const leadId = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, kind, status)
         VALUES (?, 'lead:998', 'unclassifiable-lead', ?, '', 'some-other-harness --flag', ?, 'lead', 'running')
         RETURNING id`,
      )
      .get(projectId, pane, dirs.projectDir).id;

    try {
      await assert.rejects(
        mcp.call("wake_set", { delay_seconds: 5, body: "MARKERLEAD", deliver_to: leadId }),
        (err) => {
          assert.match(err.message, /only classify a claude screen/);
          assert.match(
            err.message,
            /some-other-harness/,
            "the refusal must name the harness the caller actually configured",
          );
          return true;
        },
      );

      const wakes = db
        .prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ? AND deliver_actor = 'lead:998'")
        .get(projectId).n;
      assert.equal(wakes, 0, "a refused wake must leave no wake row behind");
    } finally {
      db.prepare("DELETE FROM agents WHERE id = ?").run(leadId);
      execFileSync("tmux", ["kill-pane", "-t", pane]);
    }
  });
});

describe("agent_spawn does not hand back instructions it has no way to deliver (todo 507)", () => {
  it("returns brief_path and says why, where it used to return instructions the text path now refuses", NEEDS_TMUX, async () => {
    const receipt = await mcp.call("agent_spawn", {
      name: "pg-brief-shell",
      command: "bash",
      extra_args: [],
      placement: "window",
    });

    assert.equal(
      receipt.instructions,
      undefined,
      "instructions told the caller to prepend them to an agent_send that is now refused - that contract is dead",
    );
    assert.ok(receipt.brief_path, "the brief must still be reachable, just not through hive's own typing");
    assert.match(receipt.note ?? "", /cannot type into/);
    assert.match(receipt.note ?? "", /keys/, "the note must name what DOES reach this pane");

    const brief = readFileSync(receipt.brief_path, "utf8");
    assert.ok(brief.trim().length > 0, "brief_path must point at a real file, not merely be a plausible path");
    assert.match(brief, /pg-brief-shell/, "and it must be THIS worker's brief");
  });

  it("still returns instructions for a harness hive can type into but does not brief, so the field is gated on delivery not on briefing", async () => {
    const { harnessFor, registerHarness, unregisterHarness } = await import("../dist/harnesses.js");
    registerHarness({
      name: "typeable-unbriefed",
      matches: (command) => command.trim().split(/\s+/)[0] === "typeable-unbriefed",
      argsFor: () => [],
      briefDelivery: null,
      stateSource: false,
      transcriptDir: false,
      contextTokens: false,
      supportsResume: false,
      supportsRename: false,
      classifiesPaneScreen: true,
      paneClassifier: {
        choiceCheck: () => ({ awaitingChoice: null, tail: "" }),
        inputBoxState: () => null,
        hasInputBox: () => null,
      },
      hasScopes: false,
    });
    try {
      const h = harnessFor("typeable-unbriefed");
      assert.equal(h.briefDelivery, null, "no brief channel");
      assert.equal(h.classifiesPaneScreen, true, "but hive can read its screen, so agent_send text still works");
    } finally {
      unregisterHarness("typeable-unbriefed");
    }
  });
});

describe("the door checks the harness on the ROW, not behind a liveness probe (todo 507)", () => {
  it("refuses a self-targeted wake whose own row is unclassifiable even when the liveness probe cannot answer", NEEDS_TMUX, async () => {
    const { db } = await import("../dist/db.js");
    const projectId = (await mcp.call("whoami")).project.id;

    // A foreign tmux_socket makes isLive answer null - neither true nor false. That is the case that
    // used to skip refuseUnclassifiableTarget entirely and fall through to the TMUX_PANE branch,
    // accepting a wake the scheduler would then hold against this same row's command forever.
    const rowId = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, command, cwd, status, agent_state)
         VALUES (?, 'agent:707', 'door-probe', 'agent', '%gone', '/nonexistent/hive-sock', 'bash', ?, 'running', 'idle')
         RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;

    const self = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:707", TMUX_PANE: "%fallbackpane" },
    });
    await self.start();
    try {
      await assert.rejects(
        self.call("wake_set", { delay_seconds: 5, body: "MARKERDOOR" }),
        /only classify a claude screen/,
        "an unanswerable probe must not launder an unclassifiable row past the door",
      );
      const wakes = db
        .prepare("SELECT COUNT(*) AS n FROM wakes WHERE project_id = ? AND deliver_actor = 'agent:707'")
        .get(projectId).n;
      assert.equal(wakes, 0, "and no wake may be left behind for the scheduler to hold forever");
    } finally {
      await self.close();
      db.prepare("DELETE FROM agents WHERE id = ?").run(rowId);
    }
  });

  it("names the harness problem rather than the liveness problem for a dead unclassifiable worker", NEEDS_TMUX, async () => {
    const { db } = await import("../dist/db.js");
    const projectId = (await mcp.call("whoami")).project.id;
    const rowId = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, tmux_socket, command, cwd, status, agent_state)
         VALUES (?, 'agent:708', 'door-dead', 'agent', '%deadpane', '', 'bash', ?, 'running', 'idle')
         RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;
    try {
      await assert.rejects(
        mcp.call("wake_set", { delay_seconds: 5, body: "MARKERDEAD", deliver_to: rowId }),
        /only classify a claude screen/,
        "a caller who fixes the pane and retries would otherwise hit a second, different refusal",
      );
    } finally {
      db.prepare("DELETE FROM agents WHERE id = ?").run(rowId);
    }
  });
});

// ADV 6: the age-out replacement is PARENTLESS, so noticeDisposition can never age it out, and
// deliverable() holds it forever when the target is unclassifiable. One immortal row per age-out.
function ageOutAgainst(command) {
  const { dataDir, tmp } = scratchDirs();
  return runFixture(
    tmp,
    `ageout-${command}`.replace(/[^a-z0-9-]/gi, "-"),
    `const { db, migrate } = await import(${JSON.stringify(join(DIST, "db.js"))});\n` +
      `const { tick } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
      `migrate();\n` +
      `const project = db.prepare("INSERT INTO projects (name, path) VALUES ('ageout', '/tmp/ageout') RETURNING id").get().id;\n` +
      `const agentId = db.prepare(\`INSERT INTO agents (project_id, actor_id, name, kind, tmux_target, command, cwd, status, agent_state, created_at)
         VALUES (?, 'agent:1', 'target', 'agent', '%pane', ?, '/tmp', 'running', 'idle', datetime('now', '-3 hours')) RETURNING id\`)
        .get(project, ${JSON.stringify(command)}).id;\n` +
      // A parent older than NOTICE_MAX_AGE (1h), so its child notice ages out on this tick.
      `const parent = db.prepare(\`INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at)
         VALUES (?, 'agent:1', 'watch', 'delay', '[]', 'agent:1', '%pane', datetime('now', '+1 hours'), datetime('now', '-3 hours')) RETURNING id\`).get(project).id;\n` +
      `const notice = db.prepare(\`INSERT INTO wakes (project_id, owner, body, kind, watch, deliver_actor, deliver_pane, due_at, created_at, parent_wake_id)
         VALUES (?, 'agent:1', 'notice body', 'delay', '[]', 'agent:1', '%pane', datetime('now', '-1 seconds'), datetime('now', '-3 hours'), ?) RETURNING id\`).get(project, parent).id;\n` +
      // Finish-shaped, per todo 322: noticeDisposition now only ages a notice holding a
      // wake_idle_notices claim. This fixture is about the immortal-replacement guard, not about
      // finish-vs-hold semantics, so it seeds the minimum claim needed to still reach "aged".
      `db.prepare(\`INSERT INTO wake_idle_notices (wake_id, agent_id, condition, episode, notice_wake_id)
         VALUES (?, ?, 'idle', 'ep1', ?)\`).run(parent, agentId, notice);\n` +
      `try { await tick({ panes: new Set(['%pane']), windows: new Set() }); } catch {}\n` +
      `const orig = db.prepare("SELECT cancelled_at FROM wakes WHERE id = ?").get(notice);\n` +
      `const replacements = db.prepare("SELECT COUNT(*) AS n FROM wakes WHERE id > ? AND parent_wake_id IS NULL").get(notice).n;\n` +
      `process.stdout.write(JSON.stringify({ cancelled: orig.cancelled_at !== null, replacements }));`,
    { HIVE_DATA_DIR: dataDir },
  );
}

describe("an age-out never mints a replacement notice hive could not deliver (todo 507, ADV 6)", () => {
  it("skips the parentless replacement for an unclassifiable target, which would be held forever and can never age out", () => {
    const out = ageOutAgainst("bash");
    assert.equal(out.cancelled, true, "the stale notice must still be cancelled");
    assert.equal(
      out.replacements,
      0,
      "a replacement here is immortal: parentless so it never ages, held so it never fires, one per hour",
    );
  });

  it("still mints it for a classifiable target, so this is not 'stop replacing age-outs'", () => {
    const out = ageOutAgainst("claude");
    assert.equal(out.cancelled, true);
    assert.equal(out.replacements, 1, "the age-out must not go silent for a target hive can actually reach");
  });
});

// dist/cli.js is a CLI entry point and importing it RUNS it, which is why test/docs.test.mjs reads
// its source rather than importing it. Same approach here.
const CLI_SRC = () => readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");

describe("a hold nothing lifts on its own says 'needs you', and cannot mask a newer one (todo 507, ADV 5)", () => {
  it("labels it 'needs you', matching the docs definition, rather than falling through to 'blocked'", () => {
    const fn = /function heldReasonLabel\([\s\S]*?\n\}/.exec(CLI_SRC());
    assert.ok(fn, "heldReasonLabel not found in dist/cli.js");
    assert.match(
      fn[0],
      /isUnclassifiablePaneHold\(heldReason\)/,
      "the never-clearing hold must be named in the needs-you branch, not left to the blocked default",
    );
    const needsYou = fn[0].slice(0, fn[0].indexOf('return "needs you"'));
    assert.ok(
      needsYou.includes("isUnclassifiablePaneHold"),
      "and it must sit in the needs-you branch specifically: docs/install.md defines that as nothing " +
        "clearing it without hive lead or wake_cancel, which is verbatim what this reason says",
    );
  });

  it("ranks it BELOW every other hold in the statusline chooser, since it is always the oldest and would mask them forever", () => {
    const cli = CLI_SRC();
    assert.match(
      cli,
      /ORDER BY \(held_reason LIKE \?\) DESC, \(held_reason LIKE \?\) ASC/,
      "the chooser needs a second LIKE that de-prioritises the never-clearing hold",
    );
    assert.match(
      cli,
      /HELD_REASON_UNSUBMITTED_INPUT_PREFIX\}%`, `\$\{HELD_REASON_UNCLASSIFIABLE_PANE_PREFIX\}%`/,
      "and the two LIKEs must be bound in that order: typing first (DESC, wins), unclassifiable second (ASC, loses)",
    );
  });
});

describe("agent_rename treats an unreadable pane as a third outcome too (todo 507, ADV 11)", () => {
  it("renames the row but does NOT type /rename into a pane it could not read", NEEDS_TMUX, async () => {
    const name = "pg-rename-blind";
    await spawn(name, fakeClaude("sleep 600"));

    const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
    const shimDir = join(dirs.tmp, "capture-fails-rename");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "capture-pane" ] && exit 9; done\nexec ${JSON.stringify(realTmux)} "$@"\n`,
    );
    chmodSync(join(shimDir, "tmux"), 0o755);

    const blind = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { PATH: `${shimDir}:${process.env.PATH}` },
    });
    await blind.start();
    let receipt;
    try {
      receipt = await blind.call("agent_rename", { name, new_name: "pg-rename-done" });
    } finally {
      await blind.close();
    }

    assert.equal(receipt.retitled, false, "hive must not claim it retitled a pane it could not read");
    assert.match(receipt.note ?? "", /could not be read/);
    assert.equal(receipt.name, "pg-rename-done", "the ROW still renames - that half never touched the pane");

    const { output } = await mcp.call("agent_output", { name: "pg-rename-done" });
    assert.doesNotMatch(
      output,
      /\/rename/,
      "assert the PANE: /rename is a paste plus Enter, and a dialog would have eaten it",
    );
  });
});
