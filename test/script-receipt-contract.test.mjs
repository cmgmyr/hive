import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs } from "./helpers.mjs";

const PART_C_GATE_PATH = join(REPO, "scripts", "part-c-gate.mjs");
const PAYLOAD_CANARY_PATH = join(REPO, "scripts", "payload-canary.mjs");

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function extractChains(source, varName) {
  const code = stripLineComments(source);
  const re = new RegExp(`\\b${varName}((?:\\?\\.[A-Za-z_$][\\w$]*|\\.[A-Za-z_$][\\w$]*)+)`, "g");
  const chains = new Map();
  let m;
  while ((m = re.exec(code))) {

    const segments = m[1]
      .match(/\??\.[A-Za-z_$][\w$]*/g)
      .map((seg) => ({ name: seg.replace(/^\??\./, ""), optional: seg.startsWith("?.") }));
    chains.set(
      segments.map((s) => s.name).join("."),
      segments,
    );
  }
  return [...chains.values()];
}

function chainLabel(chain) {
  return chain.map((s) => s.name).join(".");
}

function assertChainResolves(receipt, chain, label) {
  let node = receipt;
  for (const { name, optional } of chain) {
    if (node == null && optional) return;
    assert.ok(
      node != null && typeof node === "object" && name in node,
      `${label} reads "${chainLabel(chain)}" but the real receipt has no "${name}" at that point ` +
        `(receipt so far: ${JSON.stringify(node)})`,
    );
    node = node[name];
  }
}

const { hasTmux, cleanup } = isolateTmux("the script-receipt contract test");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const fakeClaude = makeFakeClaude(dirs.tmp);
const { sessionName } = await import("../dist/tmux.js");

describe("script/receipt contract: part-c-gate.mjs and payload-canary.mjs", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let mcp;
  let receipts;

  before(async () => {

    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "5000" } });
    await mcp.start();

    const readyFixture = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");

    const spawnReceipt = await mcp.call("agent_spawn", {
      name: "contract-worker",
      command: fakeClaude(`cat '${readyFixture}'; sleep 600`),
      extra_args: [],
    });
    assert.equal(spawnReceipt.ready, true, "test setup is broken: the fixture never registered as ready");

    const wake = await mcp.call("wake_when_idle", {
      agents: [spawnReceipt.agent_id],
      deliver_to: spawnReceipt.agent_id,
      body: "[contract test] unused, cancelled immediately below.",
      max_wait_seconds: 60,
    });

    const output = await mcp.call("agent_output", { agent_id: spawnReceipt.agent_id, lines: 20 });

    const who = await mcp.call("whoami", {});

    receipts = { spawnReceipt, wake, output, who };

    await mcp.call("wake_cancel", { wake_id: wake.wake_id });
    await mcp.call("agent_close", { agent_id: spawnReceipt.agent_id });
  });

  after(async () => {
    await mcp.close();

    cleanup(sessionName());
  });

  const BINDINGS = [
    { script: "part-c-gate.mjs", path: PART_C_GATE_PATH, varName: "spawnReceipt", receiptKey: "spawnReceipt", callSite: "agent_spawn, part-c-gate.mjs:410", expectedChainCount: 4 },
    { script: "part-c-gate.mjs", path: PART_C_GATE_PATH, varName: "wake", receiptKey: "wake", callSite: "wake_when_idle, part-c-gate.mjs:436", expectedChainCount: 1 },
    { script: "part-c-gate.mjs", path: PART_C_GATE_PATH, varName: "output", receiptKey: "output", callSite: "agent_output, part-c-gate.mjs:342", expectedChainCount: 1 },
    { script: "part-c-gate.mjs", path: PART_C_GATE_PATH, varName: "who", receiptKey: "who", callSite: "whoami, part-c-gate.mjs:536", expectedChainCount: 2 },
    { script: "payload-canary.mjs", path: PAYLOAD_CANARY_PATH, varName: "spawnReceipt", receiptKey: "spawnReceipt", callSite: "agent_spawn, payload-canary.mjs:350", expectedChainCount: 4 },
    { script: "payload-canary.mjs", path: PAYLOAD_CANARY_PATH, varName: "wake", receiptKey: "wake", callSite: "wake_when_idle, payload-canary.mjs:365", expectedChainCount: 1 },
    { script: "payload-canary.mjs", path: PAYLOAD_CANARY_PATH, varName: "who", receiptKey: "who", callSite: "whoami, payload-canary.mjs:424", expectedChainCount: 2 },
  ];

  for (const { script, path, varName, receiptKey, callSite, expectedChainCount } of BINDINGS) {
    it(`${script}'s \`${varName}\` (${callSite}): every field it reads still exists on a real receipt`, () => {
      const source = readFileSync(path, "utf8");
      const chains = extractChains(source, varName);
      assert.equal(
        chains.length,
        expectedChainCount,
        `extractChains found ${chains.length} "${varName}.*" access(es) in ${script} (${JSON.stringify(chains.map(chainLabel))}), expected ${expectedChainCount} -- ` +
          "either extraction missed/gained one (dot-chain access only; a destructure or bracket access is invisible to it) or the script's own reads " +
          "changed and this count needs a deliberate bump",
      );
      const receipt = receipts[receiptKey];
      for (const chain of chains) {
        assertChainResolves(receipt, chain, `${script}'s \`${varName}\``);
      }
    });
  }
});
