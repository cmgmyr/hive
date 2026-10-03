import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  fakeFailingTmux,
  isolateTmux,
  McpClient,
  paneField,
  recordingTmux,
  REPO,
  scratchDirs,
  tmuxCallsIn,
  until,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the pane-ownership action tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");

const OWN_SOCKET = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
const FIRST = `own-first-${process.pid}`;
const STRANGER = `own-stranger-${process.pid}`;
const MUTATING_VERBS = new Set([
  "kill-pane",
  "kill-window",
  "kill-session",
  "send-keys",
  "paste-buffer",
  "respawn-pane",
  "rename-window",
  "select-pane",
  "select-layout",
  "split-window",
  "new-window",
]);

const strangerCommand = "sh -c 'echo STRANGER; sleep 600'";
const tmuxRun = (...args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const firstPane = (session) => tmuxRun("list-panes", "-t", `=${session}`, "-F", "#{pane_id}").split("\n")[0];
const screen = (pane) => tmuxRun("capture-pane", "-p", "-t", pane);
const inMode = (pane) => tmuxRun("display-message", "-p", "-t", pane, "#{pane_in_mode}") === "1";
const paneExists = (pane) => {
  try {
    return tmuxRun("list-panes", "-t", pane, "-F", "#{pane_id}").split("\n").includes(pane);
  } catch {
    return false;
  }
};
const serverGone = () => {
  try {
    execFileSync("tmux", ["list-sessions"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
};

let projectId;
let stranger;
let stalePid;
let strangerPid;
let ownSeq = 0;
const ownSessions = [];
const clients = [];

async function client(env = {}) {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env });
  await mcp.start();
  clients.push(mcp);
  return mcp;
}

before(async () => {
  projectId = (await (await client()).call("whoami")).project.id;
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", FIRST, strangerCommand], { stdio: "ignore" });
  const firstId = firstPane(FIRST);
  stalePid = paneField(firstId, "#{pane_pid}");
  cleanup(FIRST);
  await until(serverGone, 5000);
  execFileSync("tmux", ["new-session", "-d", "-s", STRANGER, strangerCommand], { stdio: "ignore" });
  stranger = firstPane(STRANGER);
  strangerPid = paneField(stranger, "#{pane_pid}");
  assert.equal(stranger, firstId, "a restarted server on the same socket must reissue the same pane id");
  assert.notEqual(strangerPid, stalePid, "the reissued pane must belong to a different process");
  await until(() => screen(stranger).includes("STRANGER"), 5000);
});

after(async () => {
  for (const mcp of clients) await mcp.close();
  cleanup(STRANGER);
  for (const s of ownSessions) cleanup(s);
});

beforeEach(() => db.prepare("DELETE FROM agents WHERE project_id = ?").run(projectId));

function row({ name, target, socket = OWN_SOCKET, pid }) {
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status, session_id)
       VALUES (?, ?, ?, ?, ?, ?, 'claude', ?, 'agent', 'running', 'sess-1') RETURNING id`,
    )
    .get(projectId, `agent:${9000 + ownSeq++}`, name, target, socket, pid, dirs.projectDir).id;
}

function ownedPane() {
  const session = `own-ctl-${process.pid}-${ownSeq++}`;
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sh -c 'echo OWNED; sleep 600'"], { stdio: "ignore" });
  ownSessions.push(session);
  const pane = firstPane(session);
  return { pane, pid: paneField(pane, "#{pane_pid}") };
}

const rowOf = (id) =>
  db.prepare("SELECT status, name, parked_at, tmux_target, pane_pid FROM agents WHERE id = ?").get(id);

const ACTIONS = {
  close: (mcp, id) => mcp.call("agent_close", { agent_id: id }),
  park: (mcp, id) => mcp.call("agent_park", { agent_id: id }),
  rename: (mcp, id) => mcp.call("agent_rename", { agent_id: id, new_name: `renamed-${id}` }),
  keys: (mcp, id) => mcp.call("agent_send", { agent_id: id, keys: ["Q", "Z"] }),
  cancel: (mcp, id) => mcp.call("agent_send", { agent_id: id, keys: ["-X", "cancel"] }),
  text: (mcp, id) => mcp.call("agent_send", { agent_id: id, text: "typed-by-hive" }),
  draft: (mcp, id) => mcp.call("agent_send", { agent_id: id, text: "drafted-by-hive", submit: false }),
};

const REFUSING_SEEDS = {
  "empty pid": () => ({ target: stranger, pid: "" }),
  "foreign socket": () => ({ target: stranger, socket: FOREIGN_SOCKET, pid: strangerPid }),
};

async function strangerUntouched(action, fn) {
  if (action === "cancel") tmuxRun("copy-mode", "-t", stranger);
  const beforeScreen = screen(stranger);
  const log = join(mkdtempSync(join(tmpdir(), "hive-ownership-")), "calls.log");
  const mcp = await client({ PATH: `${recordingTmux({ log })}:${process.env.PATH}` });
  try {
    await fn(mcp);
  } finally {
    assert.equal(paneField(stranger, "#{pane_pid}"), strangerPid, "the stranger's process must survive");
    if (action === "cancel") {
      assert.ok(inMode(stranger), "the stranger must still be in copy mode: -X cancel never reached it");
      tmuxRun("send-keys", "-X", "-t", stranger, "cancel");
    }
    assert.equal(screen(stranger), beforeScreen, "the stranger's screen must be unchanged");
    const mutating = tmuxCallsIn(log)
      .map((argv) => argv.find((a) => !a.startsWith("-")))
      .filter((verb) => MUTATING_VERBS.has(verb));
    assert.deepEqual(mutating, [], "no mutating tmux verb may run against a pane this row does not own");
  }
}

describe("kill and type actions on a row whose pane ownership is unknown refuse and touch nothing", () => {
  const skip = !hasTmux && "tmux is not installed";
  for (const [seed, fields] of Object.entries(REFUSING_SEEDS)) {
    for (const action of Object.keys(ACTIONS)) {
      it(`${action} refuses a ${seed} row by naming unknown ownership`, { skip }, async () => {
        const id = row({ name: `w-${action}`, ...fields() });
        const before = rowOf(id);
        await strangerUntouched(action, (mcp) =>
          assert.rejects(ACTIONS[action](mcp, id), /ownership reads unknown/),
        );
        assert.deepEqual(rowOf(id), before, "an unknown row is neither closed, parked nor renamed");
      });
    }
  }

  for (const action of Object.keys(ACTIONS)) {
    it(`${action} refuses with the retry wording when the tmux probe fails`, { skip }, async () => {
      const failing = await client({ PATH: `${fakeFailingTmux({ failOn: "list-panes" })}:${process.env.PATH}` });
      const id = row({ name: `w-${action}`, target: stranger, pid: strangerPid });
      const before = rowOf(id);
      await assert.rejects(ACTIONS[action](failing, id), /could not be probed[\s\S]*Retry in a few seconds/);
      assert.deepEqual(rowOf(id), before);
      assert.equal(paneField(stranger, "#{pane_pid}"), strangerPid);
    });
  }
});

describe("a reissued or gone row is retired or renamed in the store only, never through its pane", () => {
  const skip = !hasTmux && "tmux is not installed";
  const seeds = {
    reissued: () => ({ target: stranger, pid: stalePid }),
    gone: () => ({ target: "%99999", pid: "4242" }),
  };
  for (const [state, fields] of Object.entries(seeds)) {
    it(`close retires a ${state} row with no kill and names the ownership`, { skip }, async () => {
      const id = row({ name: "w-close", ...fields() });
      await strangerUntouched("close", async (mcp) => {
        const receipt = await ACTIONS.close(mcp, id);
        assert.equal(receipt.closed, true);
        assert.match(receipt.note, new RegExp(`no kill: its pane ownership read ${state}`));
      });
      assert.equal(rowOf(id).status, "closed");
    });

    it(`park parks a ${state} row with no kill and names the ownership`, { skip }, async () => {
      const id = row({ name: "w-park", ...fields() });
      await strangerUntouched("park", async (mcp) => {
        const receipt = await ACTIONS.park(mcp, id);
        assert.equal(receipt.parked, true);
        assert.match(receipt.note, new RegExp(`no kill: its pane ownership read ${state}`));
      });
      assert.notEqual(rowOf(id).parked_at, "");
    });

    it(`rename changes a ${state} row's label without retitling, and says why`, { skip }, async () => {
      const id = row({ name: "w-rename", ...fields() });
      await strangerUntouched("rename", async (mcp) => {
        const receipt = await ACTIONS.rename(mcp, id);
        assert.equal(receipt.retitled, false);
        assert.match(receipt.note, new RegExp(`ownership read ${state}`));
      });
      assert.equal(rowOf(id).name, `renamed-${id}`);
    });

    for (const action of ["keys", "cancel", "text", "draft"]) {
      it(`${action} refuses a ${state} row by name`, { skip }, async () => {
        const id = row({ name: `w-${action}`, ...fields() });
        await strangerUntouched(action, (mcp) =>
          assert.rejects(
            ACTIONS[action](mcp, id),
            state === "reissued" ? /ownership reads reissued/ : /has no live tmux window/,
          ),
        );
        assert.equal(rowOf(id).status, "running");
      });
    }
  }
});

describe("a row whose recorded pid matches its pane still gets killed, typed into and renamed", () => {
  const skip = !hasTmux && "tmux is not installed";

  it("close kills the owned pane", { skip }, async () => {
    const { pane, pid } = ownedPane();
    const id = row({ name: "own-close", target: pane, pid });
    const receipt = await ACTIONS.close(clients[0], id);
    assert.equal(receipt.closed, true);
    assert.equal(receipt.note, undefined);
    await until(() => !paneExists(pane), 3000);
  });

  it("park kills the owned pane and parks the row", { skip }, async () => {
    const { pane, pid } = ownedPane();
    const id = row({ name: "own-park", target: pane, pid });
    const receipt = await ACTIONS.park(clients[0], id);
    assert.equal(receipt.parked, true);
    await until(() => !paneExists(pane), 3000);
  });

  it("rename types /rename into the owned pane", { skip }, async () => {
    const { pane, pid } = ownedPane();
    const id = row({ name: "own-rename", target: pane, pid });
    const receipt = await ACTIONS.rename(clients[0], id);
    assert.equal(receipt.retitled, true);
    await until(() => screen(pane).includes(`/rename renamed-${id}`), 3000);
  });

  it("keys reach the owned pane", { skip }, async () => {
    const { pane, pid } = ownedPane();
    const id = row({ name: "own-keys", target: pane, pid });
    await ACTIONS.keys(clients[0], id);
    await until(() => screen(pane).includes("QZ"), 3000);
  });

  it("-X cancel leaves copy mode on the owned pane", { skip }, async () => {
    const { pane, pid } = ownedPane();
    const id = row({ name: "own-cancel", target: pane, pid });
    tmuxRun("copy-mode", "-t", pane);
    assert.ok(inMode(pane));
    await ACTIONS.cancel(clients[0], id);
    assert.equal(inMode(pane), false);
  });

  for (const action of ["text", "draft"]) {
    it(`${action} is pasted into the owned pane`, { skip }, async () => {
      const { pane, pid } = ownedPane();
      const id = row({ name: `own-${action}`, target: pane, pid });
      const receipt = await ACTIONS[action](clients[0], id);
      assert.equal(receipt.sent, true);
      await until(() => screen(pane).includes(action === "text" ? "typed-by-hive" : "drafted-by-hive"), 3000);
    });
  }
});

describe("ownership lost between the paste and the Enter withholds the Enter", () => {
  const skip = !hasTmux && "tmux is not installed";

  it("agent_send pastes once, sends no Enter, and names the withheld Enter when the row changes mid-send", { skip }, async () => {
    const { pane, pid } = ownedPane();
    const id = row({ name: "own-midsend", target: pane, pid });
    const shimDir = mkdtempSync(join(tmpdir(), "hive-repid-"));
    const log = join(shimDir, "calls.log");
    writeFileSync(log, "");
    const repid = join(shimDir, "repid.mjs");
    writeFileSync(
      repid,
      `import Database from ${JSON.stringify(join(REPO, "node_modules", "better-sqlite3", "lib", "index.js"))};\n` +
        `new Database(${JSON.stringify(db.name)}).prepare("UPDATE agents SET pane_pid = '1' WHERE id = ?").run(${id});\n`,
    );
    const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(shimDir, "tmux"),
      `#!/bin/sh\n{ printf '%s\\037' "$@"; printf '\\n'; } >> ${JSON.stringify(log)}\n` +
        `if [ "$1" = "paste-buffer" ]; then ${realTmux} "$@" || exit $?; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(repid)}; fi\n` +
        `exec ${realTmux} "$@"\n`,
      { mode: 0o755 },
    );
    const mcp = await client({ PATH: `${shimDir}:${process.env.PATH}` });
    await assert.rejects(ACTIONS.text(mcp, id), /\[agent_send:paste-landed-enter-withheld\][\s\S]*Do NOT resend/);
    const verbs = tmuxCallsIn(log).map((argv) => argv.find((a) => !a.startsWith("-")));
    assert.equal(verbs.filter((v) => v === "paste-buffer").length, 1, "exactly one paste");
    const enters = tmuxCallsIn(log).filter((argv) => argv[0] === "send-keys" && argv.includes("Enter"));
    assert.deepEqual(enters, [], "the Enter must be withheld once the row no longer owns the pane");
    await until(() => screen(pane).includes("typed-by-hive"), 3000);
  });
});
