import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { REPO } from "./helpers.mjs";

import {
  checkPayload,
  collectFieldPaths,
  deriveManifest,
  loadCorpusFromDir,
} from "../scripts/payload-shape.mjs";

// Issue #46, step 1. No store, no tmux, no network -- this file reads only
// the committed JSON fixtures and calls pure functions on them, so it needs
// none of test/CLAUDE.md's isolation machinery (isolateTmux, scratch dirs).
//
// The manifest is derived from the SAME six fixtures test/hook-replay.test.mjs
// replays, loaded fresh here rather than imported from that file: this
// module owns no shared state with it, by design (the plan pad's own scope
// line -- this lane does not touch that file).

const FIXTURES_DIR = join(REPO, "test", "fixtures", "hook-payloads");
const corpus = loadCorpusFromDir(FIXTURES_DIR);
const manifest = deriveManifest(corpus);

function fixture(file) {
  const record = corpus.find((r) => r.file === file);
  assert.ok(record, `no such fixture: ${file}`);
  return record;
}

// Every mutation test below clones before mutating: corpus entries are
// shared across the whole file, and a test that mutated one in place would
// silently poison every later assertion that reads the same fixture.
function mutate(file, fn) {
  const { event, payload } = fixture(file);
  const copy = structuredClone(payload);
  fn(copy);
  return { event, payload: copy };
}

describe("payload-shape: manifest derivation", () => {
  it("derives REQUIRED as the intersection and KNOWN as the union, per event", () => {
    const stop = manifest.Stop;
    // Both Stop fixtures carry background_tasks (empty in one, populated in
    // the other), so its presence is required even though its per-element
    // shape is not.
    assert.ok(stop.required.includes("background_tasks"));
    assert.ok(stop.known["background_tasks[].status"]);
    assert.ok(!stop.required.includes("background_tasks[].status"));
  });

  it("collects enums only for DISCRIMINATOR_PATHS, from observed values", () => {
    assert.deepEqual(manifest.Notification.enums.notification_type, ["idle_prompt", "permission_prompt"]);
    assert.deepEqual(manifest.Stop.enums["background_tasks[].type"], ["subagent"]);
    assert.deepEqual(manifest.Stop.enums["background_tasks[].status"], ["running"]);
    // UserPromptSubmit's fixtures never populate background_tasks or
    // notification_type at all, so it must derive no enums whatsoever.
    assert.deepEqual(manifest.UserPromptSubmit.enums, {});
  });

  it("flattens every array element onto the same path, never an indexed one", () => {
    const paths = [...collectFieldPaths(fixture("stop-subagents-running.json").payload).keys()];
    assert.ok(paths.includes("background_tasks[].id"));
    assert.ok(!paths.some((p) => /background_tasks\[\d+\]/.test(p)));
  });
});

describe("payload-shape: every real fixture is conformant against its own corpus", () => {
  // This alone does NOT prove the checker can fire -- a checkPayload that
  // always returns [] would pass every one of these too. It only rules out
  // false positives; the mutation tests below are what prove detection.
  for (const { event, payload, file } of corpus) {
    it(`${file} (${event})`, () => {
      assert.deepEqual(checkPayload(manifest, event, payload), []);
    });
  }
});

describe("payload-shape: FAILURE -- required field missing", () => {
  it("fires when a required top-level field is deleted", () => {
    const { event, payload } = mutate("stop-idle.json", (copy) => {
      delete copy.background_tasks;
    });
    const findings = checkPayload(manifest, event, payload);
    assert.ok(
      findings.some((f) => f.severity === "FAILURE" && f.kind === "missing_required" && f.path === "background_tasks"),
      JSON.stringify(findings),
    );
  });

  it("does not fire on the unmutated fixture", () => {
    const { event, payload } = fixture("stop-idle.json");
    const findings = checkPayload(manifest, event, payload);
    assert.ok(!findings.some((f) => f.kind === "missing_required"));
  });
});

describe("payload-shape: FAILURE -- known field's JSON type changed", () => {
  it("fires when an array becomes null", () => {
    const { event, payload } = mutate("stop-idle.json", (copy) => {
      copy.background_tasks = null;
    });
    const findings = checkPayload(manifest, event, payload);
    assert.ok(
      findings.some(
        (f) =>
          f.severity === "FAILURE" && f.kind === "type_changed" && f.path === "background_tasks" && f.observedType === "null",
      ),
      JSON.stringify(findings),
    );
  });

  it("does not fire on the unmutated fixture", () => {
    const { event, payload } = fixture("stop-idle.json");
    const findings = checkPayload(manifest, event, payload);
    assert.ok(!findings.some((f) => f.kind === "type_changed"));
  });
});

describe("payload-shape: FAILURE -- unseen enum value", () => {
  it("fires for a notification_type the corpus never saw (the elicitation_complete question)", () => {
    const { event, payload } = mutate("notify-idle-prompt.json", (copy) => {
      copy.notification_type = "elicitation_complete";
    });
    const findings = checkPayload(manifest, event, payload);
    assert.ok(
      findings.some(
        (f) => f.severity === "FAILURE" && f.kind === "unseen_enum" && f.path === "notification_type" && f.value === "elicitation_complete",
      ),
      JSON.stringify(findings),
    );
  });

  it("fires for a background_tasks[].type the corpus never saw", () => {
    const { event, payload } = mutate("stop-subagents-running.json", (copy) => {
      copy.background_tasks[0].type = "shell";
    });
    const findings = checkPayload(manifest, event, payload);
    assert.ok(
      findings.some((f) => f.severity === "FAILURE" && f.kind === "unseen_enum" && f.path === "background_tasks[].type" && f.value === "shell"),
      JSON.stringify(findings),
    );
  });

  it("fires for a terminal background_tasks[].status the corpus never saw", () => {
    const { event, payload } = mutate("stop-subagents-running.json", (copy) => {
      copy.background_tasks[0].status = "completed";
    });
    const findings = checkPayload(manifest, event, payload);
    assert.ok(
      findings.some(
        (f) => f.severity === "FAILURE" && f.kind === "unseen_enum" && f.path === "background_tasks[].status" && f.value === "completed",
      ),
      JSON.stringify(findings),
    );
  });

  it("does not fire on the unmutated fixture", () => {
    const { event, payload } = fixture("stop-subagents-running.json");
    const findings = checkPayload(manifest, event, payload);
    assert.ok(!findings.some((f) => f.kind === "unseen_enum"));
  });
});

describe("payload-shape: INFO -- field the corpus has never seen", () => {
  it("fires, at INFO not FAILURE, for a brand-new field", () => {
    const { event, payload } = mutate("prompt-user.json", (copy) => {
      copy.new_experimental_field = "x";
    });
    const findings = checkPayload(manifest, event, payload);
    const finding = findings.find((f) => f.kind === "new_field" && f.path === "new_experimental_field");
    assert.ok(finding, JSON.stringify(findings));
    assert.equal(finding.severity, "INFO");
  });

  it("does not fire on the unmutated fixture", () => {
    const { event, payload } = fixture("prompt-user.json");
    const findings = checkPayload(manifest, event, payload);
    assert.ok(!findings.some((f) => f.kind === "new_field"));
  });
});

describe("payload-shape: an event the corpus has no fixture for at all", () => {
  it("reports INFO unknown_event rather than throwing", () => {
    const findings = checkPayload(manifest, "SomeFutureHookEvent", { anything: 1 });
    assert.deepEqual(findings, [
      {
        severity: "INFO",
        kind: "unknown_event",
        event: "SomeFutureHookEvent",
        path: null,
        message: findings[0].message,
      },
    ]);
  });
});
