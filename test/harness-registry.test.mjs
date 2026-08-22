import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-harness-registry-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { harnessFor, registerHarness, unregisterHarness } = await import("../dist/harnesses.js");
const { workerCommandString } = await import("../dist/brief.js");
const { reportsAgentStateLog } = await import("../dist/stateProvenance.js");
const { claudeOnlyFields, contextTokensField } = await import("../dist/tools/agents.js");

const WIDGET = {
  name: "widget",
  matches: (command) => command.trim().split(/\s+/)[0]?.split("/").pop() === "widget",
  argsFor: ({ displayName, namedByCaller }) =>
    displayName && !namedByCaller ? ["--handle", displayName] : [],
  briefDelivery: {
    settingsArgs: (path) => ["--hooks-file", path],
    systemPromptArgs: (path) => ["--sys-prompt", path],
  },
  stateSource: true,
  transcriptDir: false,
  contextTokens: true,
  supportsResume: false,
  supportsRename: true,
  supportsInputBoxProbe: false,
  hasScopes: false,
};

before(() => registerHarness(WIDGET));
after(() => unregisterHarness("widget"));

describe("registering a hypothetical second harness", () => {
  it("mixes true and false capabilities on one command, unlike claude where every capability is true today, so a call site reading the wrong field cannot hide behind an all-true fixture", () => {
    const fields = Object.entries(WIDGET).filter(([, v]) => typeof v === "boolean");
    assert.ok(
      fields.some(([, v]) => v === true) && fields.some(([, v]) => v === false),
      "WIDGET must carry both a true and a false boolean capability to be a checkerboard",
    );
  });

  it("refuses to register a second harness under a name already taken, rather than letting the first silently win every lookup", () => {
    assert.throws(() => registerHarness({ ...WIDGET }), /already registered/);
    assert.throws(() => registerHarness({ ...WIDGET, name: "claude" }), /already registered/);
  });

  it("resolves its own command to itself, without disturbing claude or an unrecognised command", () => {
    assert.equal(harnessFor("widget").name, "widget");
    assert.equal(harnessFor("/opt/bin/widget --flag").name, "widget");
    assert.equal(harnessFor("claude").name, "claude");
    assert.equal(harnessFor("sleep 600").name, "unknown");
  });

  it("gives workerCommandString the widget's own flags, not claude's, proving site 1 reads the table", () => {
    const cmd = workerCommandString({
      command: "widget",
      displayName: "api-worker",
      settingsPath: "/data/hooks.json",
      briefPath: "/data/briefs/agent-7.md",
    });
    assert.equal(cmd, "widget --handle api-worker --hooks-file /data/hooks.json --sys-prompt /data/briefs/agent-7.md");
  });

  it("reports a state channel for the widget (stateSource), even though it is not claude", () => {
    assert.equal(reportsAgentStateLog({ kind: "agent", command: "widget" }), true);
  });

  it("splits transcriptDir and contextTokens independently, at exactly the sites gated on each", () => {
    const row = { command: "widget", cwd: "/tmp/widget-cwd", session_id: "sess-1" };

    assert.deepEqual(
      claudeOnlyFields(row),
      {},
      "transcriptDir is false for the widget, so agents.ts:378's field must be omitted",
    );
    assert.deepEqual(
      contextTokensField(row),
      { context_tokens: null },
      "contextTokens is true for the widget, so agents.ts:394's field must still be emitted",
    );
  });

  it("keeps supportsResume and supportsRename independently settable, at no shared boolean", () => {
    assert.equal(harnessFor("widget").supportsResume, false);
    assert.equal(harnessFor("widget").supportsRename, true);
  });

  it("keeps supportsInputBoxProbe off the widget while its brief channel stays on", () => {
    assert.equal(harnessFor("widget").supportsInputBoxProbe, false);
    assert.ok(harnessFor("widget").briefDelivery, "briefDelivery must not collapse onto supportsInputBoxProbe");
  });

  it("keeps hasScopes off the widget while stateSource stays on, so a scoped-registration report can't be inferred from an unrelated capability (todo 512's mistake, generalised)", () => {
    assert.equal(harnessFor("widget").hasScopes, false);
    assert.equal(harnessFor("widget").stateSource, true);
  });

  it("leaves the claude entry's own capabilities untouched by registering a neighbour", () => {
    const claude = harnessFor("claude");
    assert.equal(claude.stateSource, true);
    assert.equal(claude.transcriptDir, true);
    assert.equal(claude.contextTokens, true);
    assert.equal(claude.supportsResume, true);
    assert.equal(claude.supportsRename, true);
    assert.equal(claude.supportsInputBoxProbe, true);
    assert.equal(claude.hasScopes, true);
  });
});
