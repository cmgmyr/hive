import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs } from "./helpers.mjs";

// Todo 388. scripts/part-c-gate.mjs and scripts/payload-canary.mjs both read
// fields off real tool receipts (agent_spawn, wake_when_idle, agent_output,
// whoami) in their unexported main path, which `npm test` never runs (their
// own headers say why: real tokens, a real worker, minutes per run -- see
// each script's header). Todo 387 renamed agent_spawn's `announced` field to
// `ready` and missed both call sites; both would have thrown on their very
// first assertion, and `npm test` stayed green through it twice, because the
// two existing test files for these scripts (part-c-gate.test.mjs,
// payload-canary.test.mjs) only import EXPORTED HELPERS -- pure functions
// that never touch a receipt field these scripts' own main paths read.
//
// THIS FILE DOES NOT RUN EITHER SCRIPT. It answers a narrower question
// mechanically: for every receipt field either script's SOURCE reads, does a
// REAL tool call still return that field? It spawns one cheap non-claude-cost
// worker (a shell script posing as `claude`, replaying a captured pane
// screen -- see makeFakeClaude/ready-idle.txt) against a scratch store, reads
// the four receipts these scripts' main paths depend on, and checks every
// field access extracted from the two scripts' own text against them. No
// subagents, no isolated-hive.mjs instance, no idle wake awaited to fire --
// scripts/part-c-gate.mjs and scripts/payload-canary.mjs remain the only
// thing that runs the full end-to-end drivers, by hand, per their headers.
//
// THE FIELD LIST IS NOT HAND-COPIED. A hand list is a second copy of the same
// claim the scripts already make, and a second copy is exactly what let
// `announced` drift silently. extractChains() below regexes each script's OWN
// source text for `<variable>.<prop>[.<prop>...]` accesses (optional-chaining
// aware) and the four receipts below are the real, live answer to whether
// each access still resolves.
//
// WHY EACH VARIABLE IS NAMED EXPLICITLY RATHER THAN SCANNED WHOLESALE: a
// script-wide regex over raw text also matches PROSE. part-c-gate.mjs:240
// is a comment -- "nothing in the run used to DEPEND on it -- spawnReceipt.
// ready is equally true..." -- that reads as a real property access to a
// naive scanner. Comments are stripped below (safe here: neither script puts
// `//` inside a string literal or uses `/* */`, checked by hand), which
// closes that hole for these two files; the four bindings are still pointed
// at their call sites explicitly rather than inferred, per the plan's own
// narrower-shape fallback, so a variable name colliding with something
// unrelated can never silently pull in a field this test should not require.

const PART_C_GATE_PATH = join(REPO, "scripts", "part-c-gate.mjs");
const PAYLOAD_CANARY_PATH = join(REPO, "scripts", "payload-canary.mjs");

// Strips `//` line comments only (both files are checked, by hand, to never
// put `//` inside a string literal or use `/* */`), so a property access
// mentioned in prose can never be read as a real one.
function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// Every `<varName>.<prop>` / `<varName>?.<prop>` chain the (comment-stripped)
// source actually accesses, as an array of { name, optional } segment arrays
// (one array per chain, e.g. "who?.project?.id" -> [{name:"project",
// optional:true}, {name:"id", optional:true}]). optional is carried through
// rather than discarded because the scripts use `?.` deliberately -- e.g.
// whoami's own `project` field is genuinely `null` when project resolution
// fails (src/tools/meta.ts) -- and a chain-walk that treats every step as
// required would fail on a step the script itself tolerates being absent. A
// trailing `(` (a method call, never present in the chains this file cares
// about) ends a chain rather than being swallowed, so this can never mistake
// a call for a property read.
function extractChains(source, varName) {
  const code = stripLineComments(source);
  const re = new RegExp(`\\b${varName}((?:\\?\\.[A-Za-z_$][\\w$]*|\\.[A-Za-z_$][\\w$]*)+)`, "g");
  const chains = new Map();
  let m;
  while ((m = re.exec(code))) {
    // Each raw segment is `?.prop` or `.prop`; splitting the whole capture on
    // "." (rather than matching segments directly) would cut the leading "?"
    // off the first optional-chain segment into its own empty token.
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

// Asserts every segment in `chain` resolves on `receipt`, in order, so a
// message naming the exact broken step (not just "receipt shape changed")
// comes from the assertion itself -- the same "would this test fail loudly"
// bar test/CLAUDE.md's shape list asks for. A segment marked `optional`
// (the script read it with `?.`) is allowed to short-circuit on a real
// `null`/`undefined` node without failing -- the script accepts that shape
// too, so this must not require more than the script itself requires. A
// REQUIRED segment (`.`, no `?`) still fails hard on a missing/null parent:
// the script would have thrown there too.
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
    // HIVE_SPAWN_READY_MS short-circuits agent_spawn's default 45s wait for
    // a real claude cold start; the fixture below renders instantly, so this
    // only bounds how long a genuine regression would make this test wait.
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "5000" } });
    await mcp.start();

    const readyFixture = join(REPO, "test", "fixtures", "panes", "ready-idle.txt");
    // spawnReceipt: what both scripts bind their agent_spawn call to
    // (part-c-gate.mjs:410, payload-canary.mjs:350). `ready` only appears on
    // a claude-shaped spawn (src/tools/agents.ts's `isClaude` branch), which
    // is exactly why the fake binary here is literally named `claude` and
    // replays a captured ready pane -- a `command: "sleep"` spawn like the
    // rest of the suite uses would never populate the field either script
    // actually reads.
    const spawnReceipt = await mcp.call("agent_spawn", {
      name: "contract-worker",
      command: fakeClaude(`cat '${readyFixture}'; sleep 600`),
      extra_args: [],
    });
    assert.equal(spawnReceipt.ready, true, "test setup is broken: the fixture never registered as ready");

    // wake: part-c-gate.mjs:436, payload-canary.mjs:365. Receipt shape only
    // -- this test never waits for the wake to fire.
    const wake = await mcp.call("wake_when_idle", {
      agents: [spawnReceipt.agent_id],
      deliver_to: spawnReceipt.agent_id,
      body: "[contract test] unused, cancelled immediately below.",
      max_wait_seconds: 60,
    });

    // output: part-c-gate.mjs:342, inside pollUntilDone. payload-canary.mjs
    // never calls agent_output (it polls the timers table directly), so this
    // receipt exists only for part-c-gate.mjs's bindings below.
    const output = await mcp.call("agent_output", { agent_id: spawnReceipt.agent_id, lines: 20 });

    // who: part-c-gate.mjs:536, payload-canary.mjs:424, both inside
    // recordResultInStore.
    const who = await mcp.call("whoami", {});

    receipts = { spawnReceipt, wake, output, who };

    // Not swallowed silently: both tools are strict-input (unknown-key
    // refusal, .claude/rules/tool-contract.md), so a rename of `wake_id` or
    // `agent_id` on either tool is the identical drift class this file
    // exists to catch, and a bare `.catch(() => {})` here would hide it
    // behind teardown noise instead of failing the test that ran it.
    await mcp.call("wake_cancel", { wake_id: wake.wake_id });
    await mcp.call("agent_close", { agent_id: spawnReceipt.agent_id });
  });

  after(async () => {
    await mcp.close();
    // NOT the agent's name -- cleanup() kills tmux SESSIONS by name
    // (isolateTmux's own contract), and agent_spawn's session is the
    // store-tagged sessionName(), never the worker's own name. Passing the
    // agent name here was silently a no-op: harmless today only because the
    // exit handler tears down this file's whole private server regardless,
    // but it would have blamed this file for a leak that was really a stuck
    // teardown one describe block over, on any file with more than one.
    cleanup(sessionName());
  });

  // One (script, variable, receipt, tool-call-site) binding per row, named
  // explicitly rather than inferred -- see the file header. Each is the
  // FULL set of receipts either script's main path reads from; nothing here
  // is scanned wholesale across an unnamed variable.
  //
  // expectedChainCount is the count `extractChains` returns TODAY (verified
  // by hand against both scripts' current source, printed alongside this
  // comment's own review). It is not a field-name list -- adding one back
  // is exactly the second copy this file exists to avoid -- but a bare
  // count is cheap to keep in sync and closes the hole a `> 0` guard leaves
  // open: extractChains only recognizes dot / optional-dot chains, so a
  // future rewrite as `const { ready } = spawnReceipt` or
  // `spawnReceipt["ready"]` drops that access from extraction silently.
  // With `> 0` the binding still has three other chains and passes; with an
  // exact count it fails LOUDLY with "found 3, expected 4", which is the
  // signal a reader needs to go look rather than trust a silently smaller
  // pin. A real new field bumps this deliberately, the same way a
  // hand-copied list would have had to be edited, except the failure mode of
  // forgetting is "count mismatch, go look" instead of "silently stops being
  // pinned".
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
