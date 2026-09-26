import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeDir } from "./dataDir.js";
import { readGlobalConfig, resolveAttachSetting } from "./globalConfig.js";

export {
  ATTACH_MODES,
  AUTO_ATTACH_MODES,
  isAttachMode,
  isAutoAttach,
  type AttachMode,
  type AutoAttach,
  type ConfigSource,
} from "./globalConfig.js";

import type { AttachMode, AutoAttach, ConfigSource } from "./globalConfig.js";

export function resolvedAttachMode(): { mode: AttachMode; source: ConfigSource } {
  const global = readGlobalConfig();
  return resolveAttachSetting("attach", global.root, global.legacy, global.warnings) as {
    mode: AttachMode; source: ConfigSource;
  };
}

export function attachMode(): AttachMode {
  return resolvedAttachMode().mode;
}

export function resolvedAutoAttach(): { value: AutoAttach; source: ConfigSource } {
  const global = readGlobalConfig();
  return resolveAttachSetting("autoAttach", global.root, global.legacy, global.warnings) as {
    value: AutoAttach; source: ConfigSource;
  };
}

export function setAttachMode(mode: AttachMode): void {
  setLegacyConfigKey("attach", mode);
}

export function setAutoAttach(value: AutoAttach): void {
  setLegacyConfigKey("autoAttach", value);
}

function setLegacyConfigKey(key: "attach" | "autoAttach", value: AttachMode | AutoAttach): void {
  const dir = storeDir();
  const path = join(dir, "config.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
  }
  config[key] = value;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
