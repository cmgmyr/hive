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
  cleanup(sessionName());
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

// One reader for "what is this target's window called", used by both window
// tests below. list-panes rather than display-message, matching what
// ownsItsWindow (src/spawn.ts) does and for its reason: display-message
// silently answers for some other target when the one it is given is dead.
const windowNameOf = (target) =>
  execFileSync("tmux", ["list-panes", "-t", target, "-F", "#{window_name}"], { encoding: "utf8" })
    .trim()
    .split("\n")[0];

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
    assert.match(windowNameOf(row.tmux_target), /rewindowed$/);
  });

  // Todo 371. Which window is hive's to retitle is answered by asking the
  // window its own name (ownsItsWindow, src/spawn.ts) rather than by reading
  // the KIND of id in tmux_target, which every row now records as a pane. The
  // safe direction of that check is the half worth pinning: a miss must mean
  // "leave the title alone", never "retitle anyway".
  //
  // A human renaming a worker's window is the reachable way to produce a miss
  // (a project's shared window is the other, and the split cases above already
  // cover it by never being retitled at all). Renaming the window by hand is
  // also exactly the case the OLD check got wrong: it keyed on the id being a
  // window id, which stayed true after a human renamed it, so hive overwrote a
  // label it no longer owned.
  it("leaves a window alone when its name is not the one hive gave this worker", async () => {
    await spawn("hand-titled", { placement: "window" });
    const row = await liveAgentRow(mcp, "hand-titled");
    const chosenByAHuman = "do-not-touch-this";
    execFileSync("tmux", ["rename-window", "-t", row.tmux_target, chosenByAHuman], { stdio: "ignore" });

    const receipt = await mcp.call("agent_rename", { name: "hand-titled", new_name: "hand-titled-2" });

    assert.equal(windowNameOf(row.tmux_target), chosenByAHuman, "hive must not retitle a window a human has renamed");
    // The row is renamed either way - the window title is cosmetic and is the
    // only thing this check gates. Asserted so a future reader cannot read the
    // skip as "the rename did not happen".
    assert.equal(receipt.name, "hand-titled-2");
    assert.equal((await mcp.call("agent_status", { agent_id: row.agent_id })).name, "hand-titled-2");
  });

  // Counselors, opus seat: the DANGEROUS direction for the commonest
  // placement was pinned by nothing. Mutate ownsItsWindow's `=== expectedTitle`
  // to `.startsWith(projectName)` and every split-placed rename would retitle
  // the project's SHARED tab - the one holding the lead and every other worker
  // - with the whole suite still green. The window-placed cases above cannot
  // catch that: they assert the retitle HAPPENS.
  it("never retitles the project's shared window when a split-placed worker is renamed", async () => {
    await spawn("shared-window-worker", { placement: "split" });
    const row = await liveAgentRow(mcp, "shared-window-worker");
    const before = windowNameOf(row.tmux_target);

    await mcp.call("agent_rename", { name: "shared-window-worker", new_name: "shared-window-renamed" });

    assert.equal(windowNameOf(row.tmux_target), before, "the shared window's name must not move with one worker's name");
    assert.doesNotMatch(windowNameOf(row.tmux_target), /shared-window-renamed/, "and must not carry the new name at all");
  });

  // The other half of the same finding, from the codex seat: a title alone can
  // MATCH a window that is not the worker's. The reachable case is a human
  // renaming the project's shared window to exactly the string hive would have
  // given this worker's own window. The @hive-project-id stamp is what tells
  // them apart, so this pins the stamp check rather than the name check.
  it("never retitles a stamped project window even when its name matches hive's own convention", async () => {
    const worker = await spawn("collider", { placement: "split" });
    const row = await liveAgentRow(mcp, "collider");
    const projectName = (await mcp.call("whoami")).project.name;
    const collidingTitle = `${projectName} - collider`;
    execFileSync("tmux", ["rename-window", "-t", row.tmux_target, collidingTitle], { stdio: "ignore" });

    const receipt = await mcp.call("agent_rename", { name: "collider", new_name: "collider-2" });

    assert.equal(
      windowNameOf(row.tmux_target),
      collidingTitle,
      "a window carrying @hive-project-id is the project's, whatever it is called",
    );
    assert.equal(receipt.name, "collider-2");
    assert.equal(worker.name, "collider");
  });

  // Counselors round 2, fable seat: one mutation still survived the two
  // controls above. Relaxing the name test from `===` to a prefix match keeps
  // all of them green, because both shared-window cases are blocked by the
  // STAMP rather than by the name. The window that only exact equality rules
  // out is another WINDOW-PLACED WORKER's - hive-owned and unstamped like this
  // worker's own, so the two stamps agree and the title is the only thing left
  // that differs.
  it("never retitles another window-placed worker's window after a pane is moved into it", async () => {
    await spawn("neighbour-a", { placement: "window" });
    await spawn("neighbour-b", { placement: "window" });
    const a = await liveAgentRow(mcp, "neighbour-a");
    const b = await liveAgentRow(mcp, "neighbour-b");
    const bTitle = windowNameOf(b.tmux_target);

    // A human pulling one worker in beside another: a's pane now lives in b's
    // window, so a's rename resolves to a window that is not a's.
    execFileSync("tmux", ["join-pane", "-d", "-s", a.tmux_target, "-t", b.tmux_target], { stdio: "ignore" });

    await mcp.call("agent_rename", { name: "neighbour-a", new_name: "neighbour-a2" });

    assert.equal(windowNameOf(a.tmux_target), bTitle, "b's window keeps its own title");
    assert.doesNotMatch(windowNameOf(a.tmux_target), /neighbour-a2/, "and never takes a's new name");
  });

  // The third of the three facts ownsItsWindow reads, and the one a mutation
  // survived until this test existed: @hive-owned tells a window HIVE made
  // from one a HUMAN made. A user's own window carrying this exact title is
  // reachable with two tmux commands and is the case a name-plus-stamp check
  // cannot see - both a user window and a worker's own window are unstamped.
  it("never retitles a window hive did not create, even when its name matches exactly", async () => {
    await spawn("guest", { placement: "window" });
    const row = await liveAgentRow(mcp, "guest");
    const projectName = (await mcp.call("whoami")).project.name;
    const usersOwnTitle = `${projectName} - guest`;

    // A window the user made: hive stamps @hive-owned on every window it
    // creates and on nothing else, so a plain new-window is the honest fixture.
    const usersWindow = execFileSync(
      "tmux",
      ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName(), "-n", usersOwnTitle, "sleep 600"],
      { encoding: "utf8" },
    ).trim();
    execFileSync("tmux", ["join-pane", "-d", "-s", row.tmux_target, "-t", usersWindow], { stdio: "ignore" });

    await mcp.call("agent_rename", { name: "guest", new_name: "guest-2" });

    assert.equal(windowNameOf(row.tmux_target), usersOwnTitle, "a window hive did not create is not hive's to retitle");
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
    // Todo 323 audit, corrected on counselors review: an EARLIER version of
    // this comment anchored on the literal "/rename" agent_rename actually
    // types, reasoning that "the slash is never part of" the pane's [hive]
    // announcement (which embeds the project's scratch directory name,
    // mkdtemp's random suffix under scratchDirs()). That reasoning was
    // backwards - the announcement's cwd is a PATH, so it is full of
    // slashes as separators - and the anchor traded away real coverage for
    // no benefit: a future regression that changed sendText's call at
    // src/tools/agents.ts:735 to omit the literal "/" would go undetected
    // by the anchored pattern while still typing an unwanted keystroke.
    // Reverted to the bare check. IMMUNE anyway, by the actual property:
    // every generated segment in this pane's announcement (scratchDirs()'s
    // two mkdtemp suffixes, six alphanumeric characters each) is preceded
    // by a FIXED literal prefix ("hive-test-" or "project-"), never by a
    // bare "/", so "rename" can only appear here as a full 6-character
    // random suffix equal to that exact word - on mkdtemp's alphabet,
    // ~2.7e-11 per suffix, well below the 1e-9 bar this project already
    // accepts elsewhere (see the tmux-socket-foreign.test.mjs alias check).
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
    // Immune: on the clash branch, asNameClash (src/spawn.ts) returns a BRAND
    // NEW Error built from a fixed template plus only the caller-supplied
    // `name` ("raced", a hardcoded literal here, never SQLite's own error
    // text) - raw's message is never read into the result. A future edit that
    // started forwarding part of the original error (e.g. for debugging)
    // would reintroduce exactly what this line checks for.
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
    // Immune, same fact as the sibling test above: the LEAD_NAME branch
    // returns a fully fixed string with no interpolation at all, so "pick
    // another name" can only appear here if that branch's own wording
    // regresses to include it.
    assert.doesNotMatch(translated.message, /pick another name/i);
  });
});
