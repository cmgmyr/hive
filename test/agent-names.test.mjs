import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs, sleep } from "./helpers.mjs";

// Addressing a worker by name (issue #10): the schemas a lead reads, the
// resolution rules underneath them, and the name a spawned worker is given.
// The spawning parts need a private tmux server.
const { hasTmux, cleanup } = isolateTmux("the agent naming tests");

const dirs = scratchDirs();
// sessionName tags itself from HIVE_DATA_DIR, so the test process has to
// resolve the same store the server does to name the session it cleans up.
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { sessionName } = await import("../dist/tmux.js");

let mcp;
let tools;
let projectId;

before(async () => {
  mcp = new McpClient({
    cwd: dirs.projectDir,
    dataDir: dirs.dataDir,
    // The fake claude below never draws a prompt box, so the readiness wait
    // can only ever time out. Make it time out immediately instead of sitting
    // out the full 45s default.
    env: { HIVE_SPAWN_READY_MS: "1" },
  });
  await mcp.start();
  const listed = await mcp.request("tools/list", {});
  tools = new Map(listed.result.tools.map((t) => [t.name, t]));
  projectId = (await mcp.call("whoami")).project.id;
});

after(async () => {
  await mcp.close();
  cleanup(sessionName(projectId));
});

// Pass "cat" when the test needs to see what hive typed into the pane: cat
// echoes it back into the rendered terminal.
const fakeClaude = makeFakeClaude(dirs.tmp);

// The tools that take "which agent?" as an argument. agent_spawn names a new
// worker rather than resolving an existing one, and agent_list takes no ref.
const REF_TOOLS = ["agent_status", "agent_send", "agent_output", "agent_close"];

describe("name-first agent schemas", () => {
  it("lists name before agent_id, so a lead reads the name argument first", () => {
    for (const name of REF_TOOLS) {
      const keys = Object.keys(tools.get(name).inputSchema.properties);
      assert.ok(
        keys.indexOf("name") < keys.indexOf("agent_id"),
        `${name} lists agent_id before name: ${keys.join(", ")}`,
      );
    }
  });

  it("describes the name argument instead of leaving it bare", () => {
    for (const name of REF_TOOLS) {
      const described = tools.get(name).inputSchema.properties.name.description ?? "";
      assert.match(described, /name/i, `${name} does not describe its name argument`);
    }
  });

  it("says a partial name works, since findAgent resolves one", () => {
    for (const name of REF_TOOLS) {
      const described = tools.get(name).inputSchema.properties.name.description ?? "";
      assert.match(described, /partial|substring/i, `${name}: ${described}`);
    }
  });

  it("keeps agent_id documented as the alternative", () => {
    for (const name of REF_TOOLS) {
      const described = tools.get(name).inputSchema.properties.agent_id.description ?? "";
      assert.match(described, /name/i, `${name} does not point agent_id back at name: ${described}`);
    }
  });
});

describe("naming a worker at spawn", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("gives a claude worker --name, so its pane is titled from birth", async () => {
    const receipt = await mcp.call("agent_spawn", { name: "titled", command: fakeClaude() });
    const row = await liveAgentRow(mcp, "titled");
    assert.match(row.command, /--name titled/);
    await mcp.call("agent_close", { name: "titled" });
    assert.equal(receipt.name, "titled");
  });

  it("gives a default-named worker the same name it was assigned", async () => {
    await mcp.call("agent_spawn", { command: fakeClaude() });
    const row = (await mcp.call("agent_list")).agents.find((a) => /^worker-\d+$/.test(a.name));
    assert.ok(row?.alive, `a default-named worker should be running, got ${JSON.stringify(row)}`);
    assert.match(row.command, new RegExp(`--name ${row.name}`));
    await mcp.call("agent_close", { name: row.name });
  });

  it("does not pass --name to a non-claude command", async () => {
    await mcp.call("agent_spawn", { name: "untitled", command: "sleep", extra_args: ["600"] });
    const row = await liveAgentRow(mcp, "untitled");
    assert.doesNotMatch(row.command, /--name/);
    await mcp.call("agent_close", { name: "untitled" });
  });
});

describe("resolving a worker by name", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  // Three running workers whose names overlap on purpose: "impl" is both an
  // exact name and a substring of "impl-followup", which is what forces the
  // precedence rule to be a rule rather than an accident.
  const crew = ["impl", "impl-followup", "DEVX-123"];

  before(async () => {
    for (const name of crew) {
      await mcp.call("agent_spawn", { name, command: "sleep", extra_args: ["600"] });
      await liveAgentRow(mcp, name);
    }
  });

  after(async () => {
    for (const name of crew) await mcp.call("agent_close", { name }).catch(() => {});
  });

  const resolve = (name) => mcp.call("agent_status", { name });

  it("takes an exact name even when it is a substring of another", async () => {
    assert.equal((await resolve("impl")).name, "impl");
  });

  it("resolves a unique substring, so a ticket number finds its worker", async () => {
    assert.equal((await resolve("123")).name, "DEVX-123");
  });

  it("matches a substring without regard to case", async () => {
    assert.equal((await resolve("devx")).name, "DEVX-123");
  });

  it("resolves a substring that only the longer name contains", async () => {
    assert.equal((await resolve("impl-")).name, "impl-followup");
  });

  it("refuses an ambiguous substring and names the candidates", async () => {
    await assert.rejects(resolve("mpl"), (err) => {
      assert.match(err.message, /impl/);
      assert.match(err.message, /impl-followup/);
      assert.match(err.message, /agent_id/);
      return true;
    });
  });

  it("says so when nothing matches", async () => {
    await assert.rejects(resolve("nobody"), /No running agent/);
  });

  it("still resolves by agent_id", async () => {
    const byName = await resolve("DEVX-123");
    const byId = await mcp.call("agent_status", { agent_id: byName.agent_id });
    assert.equal(byId.name, "DEVX-123");
  });
});

describe("renaming a worker", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  const spawn = async (name, opts = {}) => {
    const receipt = await mcp.call("agent_spawn", {
      name,
      command: "sleep",
      extra_args: ["600"],
      ...opts,
    });
    spawned.push(receipt.agent_id);
    await liveAgentRow(mcp, name);
    return receipt;
  };

  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  it("changes the display name and leaves actor_id alone", async () => {
    const before = await spawn("worker-a");
    const receipt = await mcp.call("agent_rename", { name: "worker-a", new_name: "DEVX-900" });
    assert.equal(receipt.name, "DEVX-900");
    assert.equal(receipt.previous_name, "worker-a");
    // The point of the whole rule: a lead reading agent:N in a pad written
    // before the rename must still land on this worker.
    assert.equal(receipt.actor_id, before.actor_id);
    const after = await mcp.call("agent_status", { name: "DEVX-900" });
    assert.equal(after.agent_id, before.agent_id);
    assert.equal(after.actor_id, before.actor_id);
    // The new name resolves, in full and in part; the old one is gone.
    assert.equal((await mcp.call("agent_status", { name: "900" })).agent_id, before.agent_id);
    await assert.rejects(mcp.call("agent_status", { name: "worker-a" }), /No running agent/);
  });

  it("refuses a name another running worker already has", async () => {
    await spawn("worker-b");
    await assert.rejects(
      mcp.call("agent_rename", { name: "worker-b", new_name: "DEVX-900" }),
      /already exists/,
    );
    assert.equal((await mcp.call("agent_status", { name: "worker-b" })).name, "worker-b");
  });

  it("accepts renaming a worker to the name it already has", async () => {
    await spawn("worker-c");
    const receipt = await mcp.call("agent_rename", { name: "worker-c", new_name: "worker-c" });
    assert.equal(receipt.name, "worker-c");
  });

  it("refuses an empty name and a name with a newline", async () => {
    await spawn("worker-d");
    await assert.rejects(mcp.call("agent_rename", { name: "worker-d", new_name: "   " }), /empty/);
    // The new name is typed into the worker's terminal, where a newline
    // submits everything after it as a turn of its own.
    await assert.rejects(
      mcp.call("agent_rename", { name: "worker-d", new_name: "one\ntwo" }),
      /newline/,
    );
  });

  it("tells a live claude worker to retitle its own session", async () => {
    await spawn("echoer", { command: fakeClaude("cat"), extra_args: [] });
    const receipt = await mcp.call("agent_rename", { name: "echoer", new_name: "renamed-echoer" });
    assert.equal(receipt.retitled, true);
    // send-keys returns before the pane has rendered what cat echoed back, so
    // poll rather than reading once: a single read is the CI-only flake.
    let output = "";
    for (let attempt = 0; attempt < 20 && !/\/rename renamed-echoer/.test(output); attempt++) {
      if (attempt > 0) await sleep(100);
      ({ output } = await mcp.call("agent_output", { name: "renamed-echoer" }));
    }
    assert.match(output, /\/rename renamed-echoer/);
  });

  it("does not type at a non-claude worker", async () => {
    await spawn("plain");
    const receipt = await mcp.call("agent_rename", { name: "plain", new_name: "plainer" });
    assert.equal(receipt.retitled, false);
  });

  it("renames the tmux window of a window-placed worker", async () => {
    await spawn("windowed", { placement: "window" });
    const row = await liveAgentRow(mcp, "windowed");
    await mcp.call("agent_rename", { name: "windowed", new_name: "rewindowed" });
    const windowName = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", row.tmux_target, "#{window_name}"],
      { encoding: "utf8" },
    ).trim();
    assert.match(windowName, /rewindowed$/);
  });

  it("resolves the worker to rename by partial name and by id", async () => {
    const spawnedRow = await spawn("byid");
    await mcp.call("agent_rename", { agent_id: spawnedRow.agent_id, new_name: "by-id-renamed" });
    assert.equal((await mcp.call("agent_status", { name: "by-id-renamed" })).agent_id, spawnedRow.agent_id);
    await mcp.call("agent_rename", { name: "by-id", new_name: "by-partial-renamed" });
    assert.equal((await mcp.call("agent_status", { agent_id: spawnedRow.agent_id })).name, "by-partial-renamed");
  });
});

describe("names that only differ by case", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  const spawn = async (name) => {
    const receipt = await mcp.call("agent_spawn", { name, command: "sleep", extra_args: ["600"] });
    spawned.push(receipt.agent_id);
    await liveAgentRow(mcp, name);
    return receipt;
  };

  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  // Substring resolution is case-insensitive, so two names that differ only by
  // case are not two distinct handles: every partial match would find both and
  // report them as ambiguous. Uniqueness has to be judged the same way.
  it("refuses to spawn a worker whose name differs only by case", async () => {
    await spawn("Casing");
    await assert.rejects(
      mcp.call("agent_spawn", { name: "CASING", command: "sleep", extra_args: ["600"] }),
      /already exists/,
    );
  });

  it("refuses to rename a worker onto a name that differs only by case", async () => {
    await spawn("other-casing");
    await assert.rejects(
      mcp.call("agent_rename", { name: "other-casing", new_name: "cAsInG" }),
      /already exists/,
    );
  });

  it("still lets a worker change its own name's case", async () => {
    const receipt = await mcp.call("agent_rename", { name: "Casing", new_name: "CASING" });
    assert.equal(receipt.name, "CASING");
  });
});

describe("renaming a closed worker", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("refuses, since a closed worker cannot be addressed by name at all", async () => {
    const receipt = await mcp.call("agent_spawn", {
      name: "shortlived",
      command: "sleep",
      extra_args: ["600"],
    });
    await liveAgentRow(mcp, "shortlived");
    await mcp.call("agent_close", { agent_id: receipt.agent_id });
    await assert.rejects(
      mcp.call("agent_rename", { agent_id: receipt.agent_id, new_name: "renamed-corpse" }),
      /closed/,
    );
    const row = (await mcp.call("agent_list", { include_closed: true })).agents.find(
      (a) => a.agent_id === receipt.agent_id,
    );
    assert.equal(row.name, "shortlived");
  });
});

describe("an exact name that belongs to a closed worker", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  const spawned = [];
  const spawn = async (name) => {
    const receipt = await mcp.call("agent_spawn", { name, command: "sleep", extra_args: ["600"] });
    spawned.push(receipt.agent_id);
    await liveAgentRow(mcp, name);
    return receipt;
  };

  after(async () => {
    for (const agent_id of spawned) await mcp.call("agent_close", { agent_id }).catch(() => {});
  });

  // The destructive case. Close "lane" while "lane-two" runs, and a lead that
  // types the full name "lane" must not have it silently resolve to its
  // sibling: agent_close would kill the wrong pane and wake_set would plant a
  // wake in the wrong terminal.
  before(async () => {
    const lane = await spawn("lane");
    await spawn("lane-two");
    await spawn("solo");
    await mcp.call("agent_close", { agent_id: lane.agent_id });
    await mcp.call("agent_close", { name: "solo" });
  });

  it("refuses rather than falling through to a running substring sibling", async () => {
    await assert.rejects(mcp.call("agent_status", { name: "lane" }), /closed/);
  });

  it("refuses on the same name in a different case", async () => {
    await assert.rejects(mcp.call("agent_status", { name: "LANE" }), /closed/);
  });

  it("says closed, not missing, when nothing else could have matched", async () => {
    await assert.rejects(mcp.call("agent_status", { name: "solo" }), /closed/);
  });

  it("still resolves a running worker that reuses a closed worker's name", async () => {
    const respawned = await spawn("lane");
    assert.equal((await mcp.call("agent_status", { name: "lane" })).agent_id, respawned.agent_id);
  });

  it("still resolves a partial name that matches one running worker", async () => {
    assert.equal((await mcp.call("agent_status", { name: "-two" })).name, "lane-two");
  });
});

describe("case folding outside ASCII", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  // Close every running worker, not a tracked list: a case-pair test that
  // fails does so by spawning the worker it expected to be refused, and that
  // leak would then satisfy the next test for the wrong reason.
  after(async () => {
    for (const row of (await mcp.call("agent_list")).agents) {
      await mcp.call("agent_close", { agent_id: row.agent_id }).catch(() => {});
    }
  });

  const spawn = async (name) => {
    await mcp.call("agent_spawn", { name, command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, name);
  };

  // SQLite's NOCASE folds ASCII only; JavaScript's toLowerCase is
  // Unicode-aware. If uniqueness and resolution use different engines, these
  // pairs pass the uniqueness check and then collide at resolution, leaving
  // two workers reachable only by agent_id. That is the exact state the
  // uniqueness rule exists to prevent.
  it("refuses to spawn a name that differs only by a non-ASCII case pair", async () => {
    await spawn("café");
    await assert.rejects(
      mcp.call("agent_spawn", { name: "CAFÉ", command: "sleep", extra_args: ["600"] }),
      /already exists/,
    );
  });

  it("refuses to rename onto a name that differs only by a non-ASCII case pair", async () => {
    await spawn("crème");
    await spawn("tearoom");
    await assert.rejects(
      mcp.call("agent_rename", { name: "tearoom", new_name: "CRÈME" }),
      /already exists/,
    );
  });
});

describe("control characters in a name", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  after(async () => {
    for (const row of (await mcp.call("agent_list")).agents) {
      await mcp.call("agent_close", { agent_id: row.agent_id }).catch(() => {});
    }
  });

  // A name reaches a terminal: the pane announcement at spawn, and /rename on
  // a live worker. `tmux send-keys -l` stops tmux interpreting key NAMES; it
  // passes a raw control byte straight through to the TUI. Verified against
  // tmux directly, outside this suite: send-keys -l -- with a literal 0x03 in
  // the string interrupts a running foreground process. A control character
  // in a name is a keystroke, not a label.
  const ETX = "na\u0003me";

  it("refuses to rename a worker to a name carrying a control byte", async () => {
    await mcp.call("agent_spawn", { name: "typist", command: fakeClaude("cat"), extra_args: [] });
    await liveAgentRow(mcp, "typist");
    await assert.rejects(
      mcp.call("agent_rename", { name: "typist", new_name: ETX }),
      /control character/,
    );
    // Nothing may have been typed, and the label must be untouched.
    assert.equal((await mcp.call("agent_status", { name: "typist" })).name, "typist");
    const { output } = await mcp.call("agent_output", { name: "typist" });
    assert.doesNotMatch(output, /rename/);
  });

  it("refuses to spawn a worker whose name carries a control byte", async () => {
    await assert.rejects(
      mcp.call("agent_spawn", { name: ETX, command: "sleep", extra_args: ["600"] }),
      /control character/,
    );
    const named = (await mcp.call("agent_list")).agents.filter((a) => a.name.includes("na"));
    assert.deepEqual(named, []);
  });

  it("still names newlines specifically, since that is the case a lead hits", async () => {
    await mcp.call("agent_spawn", { name: "prosaic", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "prosaic");
    await assert.rejects(
      mcp.call("agent_rename", { name: "prosaic", new_name: "one\ntwo" }),
      /newline/,
    );
  });

  it("trims a spawned name the way it trims a renamed one", async () => {
    const receipt = await mcp.call("agent_spawn", {
      name: "  padded  ",
      command: "sleep",
      extra_args: ["600"],
    });
    assert.equal(receipt.name, "padded");
    await liveAgentRow(mcp, "padded");
  });
});

// Issue #27's L4 fix round, DECISION 7c. Before this guard, once no lead row
// was running (a fresh clone, or between a lead session ending and the next
// `hive lead`), a worker could take the name "lead" outright: the next `hive
// lead` would INSERT, hit SQLITE_CONSTRAINT_UNIQUE on idx_agents_running_name,
// and throw out of ensureLeadRow BEFORE ensureSession or attach - the lead
// does not start, and nothing about that failure names a worker as the cause.
describe("the name \"lead\" is reserved", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  after(async () => {
    for (const row of (await mcp.call("agent_list")).agents) {
      await mcp.call("agent_close", { agent_id: row.agent_id }).catch(() => {});
    }
  });

  it("refuses to spawn a worker named \"lead\"", async () => {
    await assert.rejects(
      mcp.call("agent_spawn", { name: "lead", command: "sleep", extra_args: ["600"] }),
      /reserved/,
    );
    const named = (await mcp.call("agent_list")).agents.filter((a) => a.name.toLowerCase() === "lead");
    assert.deepEqual(named, [], "a refused spawn must not leave a row behind");
  });

  it("refuses regardless of case, the same rule every other name collision uses", async () => {
    await assert.rejects(
      mcp.call("agent_spawn", { name: "LEAD", command: "sleep", extra_args: ["600"] }),
      /reserved/,
    );
  });

  it("refuses to rename a worker onto \"lead\"", async () => {
    await mcp.call("agent_spawn", { name: "renamable", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "renamable");
    await assert.rejects(mcp.call("agent_rename", { name: "renamable", new_name: "lead" }), /reserved/);
    assert.equal((await mcp.call("agent_status", { name: "renamable" })).name, "renamable");
  });

  it("still spawns an ordinary worker, the accept case for this guard", async () => {
    await mcp.call("agent_spawn", { name: "not-lead", command: "sleep", extra_args: ["600"] });
    const row = await liveAgentRow(mcp, "not-lead");
    assert.ok(row.alive);
  });
});

describe("the database enforces name uniqueness too", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  after(async () => {
    for (const row of (await mcp.call("agent_list")).agents) {
      await mcp.call("agent_close", { agent_id: row.agent_id }).catch(() => {});
    }
  });

  // requireNameFree reads, then launchAgent inserts, with nothing spanning
  // the two. hive runs one server per session against one shared WAL store,
  // so two leads spawning the same name can both pass the check and both
  // insert. The app check cannot see that race; only the store can. This
  // writes straight to SQLite to assert the constraint exists, rather than
  // asserting the tool refuses.
  it("rejects a second running agent with the same name in the same project", async () => {
    const spawned = await mcp.call("agent_spawn", {
      name: "contended",
      command: "sleep",
      extra_args: ["600"],
    });
    const row = await liveAgentRow(mcp, "contended");

    const store = new Database(join(dirs.dataDir, "hive.db"));
    try {
      const insertDuplicate = (name) =>
        store
          .prepare(
            `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
             VALUES (?, ?, ?, ?, ?, ?, 'agent', 'running')`,
          )
          .run(projectId, "agent:9001", name, row.tmux_target, "sleep 600", dirs.projectDir);

      assert.throws(() => insertDuplicate("contended"), /UNIQUE|constraint/i);
      // Same rule the app applies: ASCII case folding is part of it.
      assert.throws(() => insertDuplicate("CONTENDED"), /UNIQUE|constraint/i);
      // A closed row by that name is not a conflict; only running rows are.
      store
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, closed_at)
           VALUES (?, ?, ?, '', 'sleep 600', ?, 'agent', 'closed', datetime('now'))`,
        )
        .run(projectId, "agent:9002", "contended", dirs.projectDir);
    } finally {
      store.close();
    }

    await mcp.call("agent_close", { agent_id: spawned.agent_id });
  });

  it("lets the name be reused once the running row is closed", async () => {
    await mcp.call("agent_spawn", { name: "contended", command: "sleep", extra_args: ["600"] });
    await liveAgentRow(mcp, "contended");
  });

  // Two rows racing for the same running name, driven by a REAL constraint
  // error rather than a stand-in: this is the path no single-caller test can
  // reach (requireNameFree has already passed and another session's write
  // landed in between), and going through agent_spawn would prove nothing,
  // since requireNameFree would catch the planted row first and produce the
  // same sentence by the other route. Factored out of two near-identical
  // tests in /simplify review - they differed only in these three values and
  // in what they asserted about asNameClash's output afterward.
  async function forcedNameClashError(actorId, name, kind) {
    const store = new Database(join(dirs.dataDir, "hive.db"));
    const insert = store.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
       VALUES (?, ?, ?, '', 'sleep 600', ?, ?, 'running')`,
    );
    try {
      insert.run(projectId, actorId, name, dirs.projectDir, kind);
      insert.run(projectId, actorId, name, dirs.projectDir, kind);
      assert.fail("the second insert should have violated the unique index");
    } catch (e) {
      assert.equal(e.code, "SQLITE_CONSTRAINT_UNIQUE");
      return e;
    } finally {
      store.close();
    }
  }

  it("reports a lost race in the same words as the application check", async () => {
    const { asNameClash } = await import("../dist/spawn.js");
    const raw = await forcedNameClashError("agent:9100", "raced", "agent");

    const translated = asNameClash(raw, "raced");
    assert.match(translated.message, /A running agent named "raced" already exists/);
    assert.doesNotMatch(translated.message, /SQLITE|constraint/i);

    // Anything else has to pass through untouched, or a real fault would be
    // reported to a lead as a name collision it can do nothing about.
    const unrelated = new Error("disk I/O error");
    assert.equal(asNameClash(unrelated, "raced"), unrelated);
  });

  // Issue #27's L4 fix round R6, todo 170 (counselors opus F7). "lead" is
  // never a name a caller CHOSE - ensureLeadRow (src/cli.ts) is the only
  // thing that ever names a row "lead" - so "pick another name" is advice
  // the loser of a `hive lead` race cannot act on. Same driving shape as the
  // test above, with name="lead" to hit the branch that changes the sentence.
  it("tells a hive lead race's loser to re-run, not to pick another name", async () => {
    const { asNameClash } = await import("../dist/spawn.js");
    const raw = await forcedNameClashError("lead:9200", "lead", "lead");

    const translated = asNameClash(raw, "lead");
    assert.match(translated.message, /won the race/);
    assert.match(translated.message, /re-run `hive lead`/i);
    assert.doesNotMatch(translated.message, /pick another name/i);
  });
});
