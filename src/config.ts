import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { storeDir } from "./dataDir.js";

// The one machine preference issue #81 asks for. A file, not a row: hive
// restore swaps the database, and a terminal preference has no business being
// carried in a project snapshot or clobbered by restoring an older one.
export type AttachMode = "auto" | "raw" | "control";

// Exported so a caller validating a user-supplied value (`hive setup
// --attach`) and this module's own fallback logic can't drift apart into two
// lists that quietly disagree about what is valid.
export const ATTACH_MODES: readonly AttachMode[] = ["auto", "raw", "control"];

export function isAttachMode(value: unknown): value is AttachMode {
  return ATTACH_MODES.includes(value as AttachMode);
}

export type AutoAttach = "auto" | "on" | "off";

// Exported so a caller validating a user-supplied value (`hive setup
// --auto-attach`) and this module's own fallback logic can't drift apart into
// two lists that quietly disagree about what is valid.
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

// Read at CALL time, same reasoning as storeDir() itself (src/dataDir.ts:14-27):
// resolving the path into a module-level const would freeze it at this
// module's first import, ahead of whatever later sets HIVE_DATA_DIR.
//
// An absent file, an unreadable one, and malformed JSON all read as "nothing
// set yet" -- there is no operator here to report a parse error to, and a
// config read must not be the thing that breaks a tmux attach. storeDir()'s
// OWN refusal (the real store under a test runner, .claude/rules/store-and-
// datadir.md) is not swallowed with them: configPath() runs outside the try,
// so that throw still reaches the caller the same way it already does on the
// write side (setAttachMode's mkdirSync). Folding it into "absent file" would
// make a misconfigured test process read a silent "auto" instead of the loud
// failure the guard exists to give it.
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

// HIVE_ATTACH_MODE is a one-off TESTING override, not the way to configure
// this -- use `hive setup --attach` for that. It exists because it does NOT
// reliably reach ensureAttached, which runs inside the MCP server process:
// Claude Code starts that from its own registration, so a shell export
// reaches it only by accident of the process chain
// (.claude/sessions/dead-ends/2026-08-02-env-var-for-mcp-server-config.md).
// A stored file reaches both call sites structurally; this does not, and
// must never be promoted to the primary mechanism for that reason.
function envAttachMode(): AttachMode | null {
  const value = process.env.HIVE_ATTACH_MODE;
  return isAttachMode(value) ? value : null;
}

// HIVE_AUTO_ATTACH is a one-off TESTING override, not the way to configure
// this -- use `hive setup --auto-attach` for that. ensureAttached runs inside
// the MCP server process, which Claude Code starts from its own registration,
// so a shell export reaches it only by accident of the process chain. The
// legacy "0" spelling remains accepted because existing setups rely on it.
function envAutoAttach(): AutoAttach | null {
  const value = process.env.HIVE_AUTO_ATTACH;
  if (value === "0") return "off";
  return isAutoAttach(value) ? value : null;
}

// Where the mode came from, alongside the mode itself: "hive doctor" needs
// both to answer "why am I in control mode", not just the resolved value.
// Precedence is env, then the config file, then detection. An unknown config
// value (a future mode this build does not know, or a hand-edited typo)
// reads the same as absent -- "detection", falling back to "auto" -- rather
// than throwing.
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

// Read-modify-write, so a key this lane does not know about survives a write
// from it.
export function setAttachMode(mode: AttachMode): void {
  const config = readConfig();
  config.attach = mode;
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

// Read-modify-write, so a key this lane does not know about survives a write
// from it.
export function setAutoAttach(value: AutoAttach): void {
  const config = readConfig();
  config.autoAttach = value;
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}
