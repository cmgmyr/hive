import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { storeDir } from "./dataDir.js";

export type AttachMode = "auto" | "raw" | "control";

export const ATTACH_MODES: readonly AttachMode[] = ["auto", "raw", "control"];

export function isAttachMode(value: unknown): value is AttachMode {
  return ATTACH_MODES.includes(value as AttachMode);
}

export type AutoAttach = "auto" | "on" | "off";

export const AUTO_ATTACH_MODES: readonly AutoAttach[] = ["auto", "on", "off"];

export function isAutoAttach(value: unknown): value is AutoAttach {
  return AUTO_ATTACH_MODES.includes(value as AutoAttach);
}

interface HiveConfig {
  attach?: AttachMode;
  autoAttach?: AutoAttach;
  [key: string]: unknown;
}

function configPath(): string {
  return join(storeDir(), "config.json");
}

function readConfig(): HiveConfig {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as HiveConfig) : {};
  } catch {
    return {};
  }
}

function envAttachMode(): AttachMode | null {
  const value = process.env.HIVE_ATTACH_MODE;
  return isAttachMode(value) ? value : null;
}

function envAutoAttach(): AutoAttach | null {
  const value = process.env.HIVE_AUTO_ATTACH;
  if (value === "0") return "off";
  return isAutoAttach(value) ? value : null;
}

export function resolvedAttachMode(): { mode: AttachMode; source: "env" | "config" | "detection" } {
  const fromEnv = envAttachMode();
  if (fromEnv) return { mode: fromEnv, source: "env" };
  const value = readConfig().attach;
  return isAttachMode(value) ? { mode: value, source: "config" } : { mode: "auto", source: "detection" };
}

export function attachMode(): AttachMode {
  return resolvedAttachMode().mode;
}

export function resolvedAutoAttach(): { value: AutoAttach; source: "env" | "config" | "detection" } {
  const fromEnv = envAutoAttach();
  if (fromEnv) return { value: fromEnv, source: "env" };
  const value = readConfig().autoAttach;
  return isAutoAttach(value)
    ? { value, source: "config" }
    : { value: "auto", source: "detection" };
}

export function setAttachMode(mode: AttachMode): void {
  const config = readConfig();
  config.attach = mode;
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function setAutoAttach(value: AutoAttach): void {
  const config = readConfig();
  config.autoAttach = value;
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
