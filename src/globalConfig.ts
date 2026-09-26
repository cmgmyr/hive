import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMap, parse, parseDocument } from "yaml";

import { storeDir } from "./dataDir.js";
import { errorMessage } from "./result.js";

export type ConfigSource = "env" | "project" | "global" | "built-in";
export type AttachMode = "auto" | "raw" | "control";
export type AutoAttach = "auto" | "on" | "off";

export interface ConfigMigrationResult {
  migrated: boolean;
  notice: string | null;
  warnings: string[];
}

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

function readEditableDocument(path: string, allowMissing: boolean): ReturnType<typeof parseDocument> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return parseDocument("");
    throw new Error(`${path}: could not read hive.yml: ${errorMessage(error)}`);
  }

  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`${path}: hive.yml is not valid YAML: ${document.errors.map(errorMessage).join("; ")}`);
  }
  if (!isMap(document.contents)) throw new Error(`${path}: hive.yml must be a YAML mapping.`);
  return document;
}

function writeAtomicYaml(path: string, text: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const candidate = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let temp: string | null = null;
  let fd: number | null = null;
  try {
    fd = openSync(candidate, "wx", 0o600);
    temp = candidate;
    writeFileSync(fd, text, { encoding: "utf8" });
    closeSync(fd);
    fd = null;
    chmodSync(candidate, mode);
    renameSync(candidate, path);
    temp = null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    if (temp !== null) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function updateGlobalDocument(dir: string, update: (document: ReturnType<typeof parseDocument>) => boolean): boolean {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hive.yml");
  const document = readEditableDocument(path, true);
  if (!update(document)) return false;
  let text: string;
  try {
    text = document.toString();
  } catch (error) {
    throw new Error(`${path}: could not serialize hive.yml: ${errorMessage(error)}`);
  }
  try {
    writeAtomicYaml(path, text);
  } catch (error) {
    throw new Error(`${path}: could not write hive.yml: ${errorMessage(error)}`);
  }
  return true;
}

export function writeGlobalConfigKey(key: "attach" | "autoAttach", value: AttachMode | AutoAttach): void {
  const dir = storeDir();
  updateGlobalDocument(dir, (document) => {
    document.set(key, value);
    return true;
  });
}

export function migrateLegacyConfig(): ConfigMigrationResult {
  const dir = storeDir();
  const legacyPath = join(dir, "config.json");
  const archivePath = `${legacyPath}.migrated`;
  const globalPath = join(dir, "hive.yml");
  const refusal = (path: string, warning: string): ConfigMigrationResult => ({
    migrated: false,
    notice: null,
    warnings: [`${path}: ${warning}`],
  });

  let legacyText: string;
  try {
    legacyText = readFileSync(legacyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { migrated: false, notice: null, warnings: [] };
    return refusal(legacyPath, `could not read config.json: ${errorMessage(error)}`);
  }

  try {
    lstatSync(archivePath);
    return refusal(legacyPath, `archive ${archivePath} already exists; refusing to overwrite it.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return refusal(archivePath, `could not check migration archive: ${errorMessage(error)}`);
    }
  }

  let legacy: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(legacyText);
    if (!isMapping(raw)) return refusal(legacyPath, "config.json must be a JSON object.");
    legacy = raw;
  } catch (error) {
    return refusal(legacyPath, `config.json is not valid JSON: ${errorMessage(error)}`);
  }

  try {
    updateGlobalDocument(dir, (document) => {
      let changed = false;
      for (const [key, value] of Object.entries(legacy)) {
        if (key === "review_tags" || document.has(key)) continue;
        document.set(key, value);
        changed = true;
      }
      return changed;
    });
  } catch (error) {
    const message = errorMessage(error);
    const warning = message.startsWith(`${globalPath}:`)
      ? message
      : `${globalPath}: could not update hive.yml: ${message}`;
    return { migrated: false, notice: null, warnings: [warning] };
  }

  try {
    renameSync(legacyPath, archivePath);
  } catch (error) {
    return refusal(legacyPath, `could not archive config.json as ${archivePath}: ${errorMessage(error)}`);
  }

  return {
    migrated: true,
    notice: `hive: migrated ${legacyPath} into ${globalPath}; original saved as ${archivePath}.`,
    warnings: [],
  };
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
