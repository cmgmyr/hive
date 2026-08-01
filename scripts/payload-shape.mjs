#!/usr/bin/env node
// Issue #46, step 1: the pure payload-SHAPE conformance module. Diffs an
// observed Claude Code hook payload against a manifest derived, at runtime,
// from the committed corpus (test/fixtures/hook-payloads/). No second
// committed shapes file: the corpus itself is the manifest's only source.
//
// SHAPE ONLY. Nothing here decides or asserts what state hive writes for a
// payload (idle/working/waiting, stateFor, waitingOnSubagents); that surface
// belongs to test/hook-replay.test.mjs.
//
// Everything below loadCorpusFromDir() is a pure function: plain objects in,
// plain findings out, no I/O. loadCorpusFromDir() is the one exception,
// isolated so callers (this file's tests, and the live canary script) can
// build a manifest from real fixtures without the decision logic itself
// touching a filesystem.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The discriminating fields issue #46 names by name: the ones whose VALUE,
// not just presence, distinguishes one payload shape from another already
// seen. Array-valued fields are addressed with a trailing "[]", matching
// collectFieldPaths' own flattening below.
export const DISCRIMINATOR_PATHS = ["notification_type", "background_tasks[].type", "background_tasks[].status"];

export function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Every array element shares the SAME path ("background_tasks[]", not
// "background_tasks[0]"): a hook payload's arrays are unindexed collections
// of like-shaped entries, not fixed-position tuples, so per-index paths
// would fragment one field into as many paths as the corpus happens to have
// elements for, and required/known derivation below would never converge.
function walk(value, path, onNode) {
  if (path !== "") onNode(path, value);
  if (Array.isArray(value)) {
    for (const el of value) walk(el, `${path}[]`, onNode);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) walk(value[key], path ? `${path}.${key}` : key, onNode);
  }
}

// One walk per payload, not one per caller: deriveManifest and checkPayload
// both need a path's types (for known/required) AND its raw values (for
// DISCRIMINATOR_PATHS' enums), and re-walking the same tree once per
// discriminator to re-derive values a single pass already saw was pure
// waste. Every path's entry keeps both, so no caller pays for a second walk.
function indexPayload(payload) {
  const map = new Map();
  walk(payload, "", (path, value) => {
    if (!map.has(path)) map.set(path, { types: new Set(), values: [] });
    const entry = map.get(path);
    entry.types.add(jsonType(value));
    entry.values.push(value);
  });
  return map;
}

export function collectFieldPaths(payload) {
  return new Map([...indexPayload(payload)].map(([path, { types }]) => [path, types]));
}

// records: [{ event, payload }, ...]. Per event: KNOWN is the union of field
// paths seen; REQUIRED is the intersection, so a field present in some
// fixtures of an event and not others is optional BY CONSTRUCTION -- the
// honest reading of a small, real corpus, not a hand-picked schema. ENUMS
// covers only DISCRIMINATOR_PATHS, and only where the corpus actually
// produced a value for that (event, path) pair.
export function deriveManifest(records) {
  const payloadsByEvent = new Map();
  for (const { event, payload } of records) {
    if (!payloadsByEvent.has(event)) payloadsByEvent.set(event, []);
    payloadsByEvent.get(event).push(payload);
  }

  const manifest = {};
  for (const [event, payloads] of payloadsByEvent) {
    const perPayloadIndex = payloads.map(indexPayload);

    const known = new Map();
    const enumValues = new Map(DISCRIMINATOR_PATHS.map((p) => [p, new Set()]));
    let required;
    for (const index of perPayloadIndex) {
      for (const [path, { types, values }] of index) {
        if (!known.has(path)) known.set(path, new Set());
        for (const t of types) known.get(path).add(t);
        if (enumValues.has(path)) for (const v of values) enumValues.get(path).add(v);
      }
      // Intersect in place: seed from the first payload's paths, then drop
      // anything later payloads don't also have. A field present in some
      // fixtures of this event and not others is optional BY CONSTRUCTION --
      // the honest reading of a small, real corpus, not a hand-picked schema.
      const keys = new Set(index.keys());
      if (!required) required = keys;
      else for (const k of required) if (!keys.has(k)) required.delete(k);
    }

    const enums = {};
    for (const [path, values] of enumValues) {
      if (values.size > 0) enums[path] = [...values].sort();
    }

    manifest[event] = {
      known: Object.fromEntries([...known].map(([path, types]) => [path, [...types].sort()])),
      required: [...(required ?? [])].sort(),
      enums,
    };
  }
  return manifest;
}

// Findings, most-severe first is NOT guaranteed by this function's own
// ordering (missing-required, then per-path type/new-field, then enums) --
// callers that care about severity order filter on `severity` themselves.
export function checkPayload(manifest, event, payload) {
  const spec = manifest[event];
  if (!spec) {
    return [
      {
        severity: "INFO",
        kind: "unknown_event",
        event,
        path: null,
        message: `event "${event}" has no corpus fixture at all; capture one to grow the manifest`,
      },
    ];
  }

  const findings = [];
  const observed = indexPayload(payload);

  for (const path of spec.required) {
    if (!observed.has(path)) {
      findings.push({
        severity: "FAILURE",
        kind: "missing_required",
        event,
        path,
        message: `required field "${path}" is missing from an observed ${event} payload`,
      });
    }
  }

  for (const [path, { types, values }] of observed) {
    const knownTypes = spec.known[path];
    if (!knownTypes) {
      for (const t of types) {
        findings.push({
          severity: "INFO",
          kind: "new_field",
          event,
          path,
          observedType: t,
          message: `field "${path}" (type ${t}) has never been seen on a ${event} payload; capture a fixture to grow the corpus`,
        });
      }
      continue;
    }
    for (const t of types) {
      if (!knownTypes.includes(t)) {
        findings.push({
          severity: "FAILURE",
          kind: "type_changed",
          event,
          path,
          observedType: t,
          knownTypes,
          message: `field "${path}" changed type: corpus knows ${knownTypes.join("/")}, observed ${t}`,
        });
      }
    }

    const knownValues = spec.enums[path];
    if (!knownValues) continue;
    for (const value of values) {
      if (!knownValues.includes(value)) {
        findings.push({
          severity: "FAILURE",
          kind: "unseen_enum",
          event,
          path,
          value,
          knownValues,
          message: `field "${path}" carries a value the corpus never saw: ${JSON.stringify(value)} (known: ${knownValues.join(", ")})`,
        });
      }
    }
  }

  return findings;
}

// The one I/O function in this file. event comes from the payload's own
// hook_event_name, never the filename, so a fixture named after what it
// demonstrates does not silently mislabel its event.
export function loadCorpusFromDir(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const payload = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return { event: payload.hook_event_name, payload, file };
    });
}
