import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

import { storeDir } from "./dataDir.js";
import { errorMessage } from "./result.js";

export type ConfigSource = "env" | "project" | "global" | "built-in";
export type AttachMode = "auto" | "raw" | "control";
export type AutoAttach = "auto" | "on" | "off";

export const ATTACH_MODES: readonly AttachMode[] = ["auto", "raw", "control"];
export const AUTO_ATTACH_MODES: readonly AutoAttach[] = ["auto", "on", "off"];

export function isAttachMode(value: unknown): value is AttachMode {
  return ATTACH_MODES.includes(value as AttachMode);
}

export function isAutoAttach(value: unknown): value is AutoAttach {
  return AUTO_ATTACH_MODES.includes(value as AutoAttach);
}

export function globalConfigPath(): string {
  return join(storeDir(), "hive.yml");
}

function isMapping(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isEmptyYamlDocument(text: string): boolean {
  return text.split(/\r?\n/).every((line) => /^\s*(?:#.*)?$/.test(line));
}

function readLayer(path: string, kind: "yaml" | "json", warnings: string[]): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`${path}: could not read configuration: ${errorMessage(error)}`);
    }
    return null;
  }

  let value: unknown;
  try {
    value = kind === "yaml" ? parse(text) : JSON.parse(text);
  } catch (error) {
    warnings.push(`${path}: ${kind === "yaml" ? "hive.yml is not valid YAML" : "config.json is not valid JSON"}: ${errorMessage(error)}`);
    return null;
  }
  if (kind === "yaml" && value == null && isEmptyYamlDocument(text)) return null;
  if (!isMapping(value)) {
    warnings.push(`${path}: ${kind === "yaml" ? "configuration must be a YAML mapping." : "config.json must be a JSON object."}`);
    return null;
  }
  return value;
}

export function readGlobalConfig(): {
  root: Record<string, unknown> | null;
  legacy: Record<string, unknown>;
  warnings: string[];
} {
  const dir = storeDir();
  const warnings: string[] = [];
  const root = readLayer(join(dir, "hive.yml"), "yaml", warnings);
  const legacy = readLayer(join(dir, "config.json"), "json", warnings) ?? {};
  return { root, legacy, warnings };
}

export function resolveAttachSetting(
  key: "attach" | "autoAttach",
  global: Record<string, unknown> | null,
  legacy: Record<string, unknown>,
  warnings: string[],
): { mode: AttachMode; source: ConfigSource } | { value: AutoAttach; source: ConfigSource } {
  const mode = key === "attach";
  const env = mode
    ? isAttachMode(process.env.HIVE_ATTACH_MODE) ? process.env.HIVE_ATTACH_MODE : null
    : process.env.HIVE_AUTO_ATTACH === "0"
      ? "off"
      : isAutoAttach(process.env.HIVE_AUTO_ATTACH) ? process.env.HIVE_AUTO_ATTACH : null;
  if (env != null) return mode ? { mode: env as AttachMode, source: "env" } : { value: env as AutoAttach, source: "env" };

  const path = globalConfigPath();
  if (global && Object.hasOwn(global, key)) {
    const value = global[key];
    if (value == null) return mode ? { mode: "auto", source: "global" } : { value: "auto", source: "global" };
    if (mode ? isAttachMode(value) : isAutoAttach(value)) {
      return mode ? { mode: value as AttachMode, source: "global" } : { value: value as AutoAttach, source: "global" };
    }
    warnings.push(`${path}: ${key} must be one of ${(mode ? ["auto", "raw", "control"] : ["auto", "on", "off"]).join(", ")}; ignoring "${String(value)}".`);
    return mode ? { mode: "auto", source: "built-in" } : { value: "auto", source: "built-in" };
  }

  if (Object.hasOwn(legacy, key)) {
    const value = legacy[key];
    if (value == null) return mode ? { mode: "auto", source: "global" } : { value: "auto", source: "global" };
    if (mode ? isAttachMode(value) : isAutoAttach(value)) {
      return mode ? { mode: value as AttachMode, source: "global" } : { value: value as AutoAttach, source: "global" };
    }
    warnings.push(`${path.replace(/hive\.yml$/, "config.json")}: ${key} has an invalid value; ignoring it.`);
  }
  return mode ? { mode: "auto", source: "built-in" } : { value: "auto", source: "built-in" };
}
