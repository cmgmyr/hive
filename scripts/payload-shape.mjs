#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DISCRIMINATOR_PATHS = ["notification_type", "background_tasks[].type", "background_tasks[].status"];

export function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walk(value, path, onNode) {
  if (path !== "") onNode(path, value);
  if (Array.isArray(value)) {
    for (const el of value) walk(el, `${path}[]`, onNode);
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) walk(value[key], path ? `${path}.${key}` : key, onNode);
  }
}

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

export function loadCorpusFromDir(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const payload = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return { event: payload.hook_event_name, payload, file };
    });
}
