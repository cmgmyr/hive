import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "hive-harness-registry-"));
process.env.HIVE_DATA_DIR = scratch;
after(() => rmSync(scratch, { recursive: true, force: true }));

const { harnessFor, paneClassifierFor, registerHarness, unregisterHarness, screenClassifiable } = await import(
  "../dist/harnesses.js"
);
const { workerCommandString } = await import("../dist/brief.js");
const { reportsAgentStateLog } = await import("../dist/stateProvenance.js");
const { claudeOnlyFields, contextTokensField } = await import("../dist/tools/agents.js");

// No test here calls into this - it only has to satisfy registerHarness's own
// "classifiesPaneScreen and paneClassifier must agree" check.
const STUB_CLASSIFIER = {
  choiceCheck: () => ({ awaitingChoice: null, tail: "" }),
  inputBoxState: () => null,
  hasInputBox: () => null,
};

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
  classifiesPaneScreen: true,
  paneClassifier: STUB_CLASSIFIER,
  hasScopes: false,
};

// The witness WIDGET can no longer carry: briefDelivery ON while hive cannot read the screen.
// WIDGET had to set classifiesPaneScreen true once registerHarness started refusing that pair with
// supportsRename, so without this entry nothing pins the two fields as separate at all.
const UNREADABLE_BRIEFED = {
  ...WIDGET,
  name: "unreadable-briefed",
  matches: (command) => command.trim().split(/\s+/)[0]?.split("/").pop() === "unreadable-briefed",
  supportsRename: false,
  classifiesPaneScreen: false,
  paneClassifier: null,
};

before(() => {
  registerHarness(WIDGET);
  registerHarness(UNREADABLE_BRIEFED);
});
after(() => {
  unregisterHarness("widget");
  unregisterHarness("unreadable-briefed");
});

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

  it("keeps classifiesPaneScreen and briefDelivery independently settable, witnessed by an entry that sets them OPPOSITE ways", () => {
    const unreadable = harnessFor("unreadable-briefed");
    assert.equal(unreadable.classifiesPaneScreen, false);
    assert.ok(
      unreadable.briefDelivery,
      "a harness hive cannot read the screen of may still take brief flags - merge the two fields and this dies",
    );

    const widget = harnessFor("widget");
    assert.equal(widget.classifiesPaneScreen, true);
    assert.ok(widget.briefDelivery);
  });

  it("answers screenClassifiable from the entry rather than from the caller's guess, both ways", () => {
    assert.equal(screenClassifiable("unreadable-briefed"), false, "a briefed harness is not automatically readable");
    assert.equal(screenClassifiable("widget"), true);
  });

  it("refuses to register a harness that types /rename into a pane it cannot classify, the one pair that is NOT independently settable", () => {
    assert.throws(
      () =>
        registerHarness({
          ...WIDGET,
          name: "unsafe-rename",
          supportsRename: true,
          classifiesPaneScreen: false,
          paneClassifier: null,
        }),
      /supportsRename without classifiesPaneScreen/,
    );
    assert.equal(harnessFor("widget").name, "widget", "the refusal must not have registered anything");
  });

  it("still allows the safe three corners of that pair, so the check forbids one combination rather than coupling the two fields", () => {
    for (const [rename, classify] of [
      [false, false],
      [false, true],
      [true, true],
    ]) {
      const name = `corner-${rename}-${classify}`;
      registerHarness({
        ...WIDGET,
        name,
        matches: (command) => command.trim().split(/\s+/)[0] === name,
        supportsRename: rename,
        classifiesPaneScreen: classify,
        paneClassifier: classify ? STUB_CLASSIFIER : null,
      });
      assert.equal(harnessFor(name).supportsRename, rename);
      assert.equal(harnessFor(name).classifiesPaneScreen, classify);
      unregisterHarness(name);
    }
  });

  it("keeps hasScopes off the widget while stateSource stays on, so a scoped-registration report can't be inferred from an unrelated capability (todo 512's mistake, generalised)", () => {
    assert.equal(harnessFor("widget").hasScopes, false);
    assert.equal(harnessFor("widget").stateSource, true);
  });

  it("reads an EMPTY command as no-fact-recorded and classifiable, never as an unclassifiable harness", () => {
    assert.equal(screenClassifiable(""), true, "a wake can name a pane with no agents row behind it");
    assert.equal(screenClassifiable("   "), true);
    assert.equal(screenClassifiable("claude"), true);
    assert.equal(screenClassifiable("bash"), false, "an unknown harness is the case this predicate exists for");
    assert.equal(screenClassifiable("sleep 600"), false);
  });

  it("gives an EMPTY command claude's own predicates, not unknownHarness's null - screenClassifiable's true would otherwise be a lie the moment anything reads the pane", () => {
    assert.equal(paneClassifierFor(""), harnessFor("claude").paneClassifier);
    assert.equal(paneClassifierFor("   "), harnessFor("claude").paneClassifier);
    assert.equal(paneClassifierFor("bash"), null, "a real, unrecognised command still resolves to no classifier");
  });

  it("defaults a stub harness's missing terminalSessionEndReasons to [], so a JS registration built with no TypeScript check behind it cannot make src/hook.ts's .includes() throw (todo 782 fix round)", () => {
    assert.deepEqual(harnessFor("widget").terminalSessionEndReasons, []);
    assert.doesNotThrow(() => harnessFor("widget").terminalSessionEndReasons.includes("other"));
  });

  it("leaves the claude entry's own capabilities untouched by registering a neighbour", () => {
    const claude = harnessFor("claude");
    assert.equal(claude.stateSource, true);
    assert.equal(claude.transcriptDir, true);
    assert.equal(claude.contextTokens, true);
    assert.equal(claude.supportsResume, true);
    assert.equal(claude.supportsRename, true);
    assert.equal(claude.classifiesPaneScreen, true);
    assert.equal(claude.hasScopes, true);
  });
});
