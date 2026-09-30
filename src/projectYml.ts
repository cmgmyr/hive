import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parse } from "yaml";
import { harnessNames } from "./harnesses.js";
import { isValidProfileName } from "./profiles.js";
import { errorMessage } from "./result.js";
import { TRIAGE_MESSAGE } from "./triageMessage.js";
import { isWindowLayout, WINDOW_LAYOUTS, type WindowLayout } from "./tmux.js";
import {
  globalConfigPath,
  isEmptyYamlDocument,
  readGlobalConfig,
  resolveAttachSetting,
  type AttachMode,
  type AutoAttach,
  type ConfigSource,
} from "./globalConfig.js";

export { type ConfigSource } from "./globalConfig.js";

export interface YmlProcess {
  command: string;
  dir: string | null;
  auto_start: boolean;
  visible: boolean;
  env: Record<string, string>;
}

export interface ProjectYml {
  lead: string | null;
  placement: "split" | "window" | null;
  layout: WindowLayout | null;

  profile: string | null;

  agents: string[] | null;

  lead_branches: string[] | null;

  first_message: string | null;

  context_checkpoint_percent: number | null;
  lead_turn_budget: { warn: number; stop: number } | null;
  dashboard: boolean;
  vars: Record<string, string>;
  processes: Record<string, YmlProcess>;
}

export const BUILT_IN_PROJECT_YML: Readonly<ProjectYml> = Object.freeze({
  lead: null,
  placement: null,
  layout: null,
  profile: null,
  agents: null,
  lead_branches: null,
  first_message: null,
  context_checkpoint_percent: null,
  lead_turn_budget: null,
  dashboard: false,
  vars: Object.freeze({}),
  processes: Object.freeze({}),
});

export const PROJECT_YML_KEYS = Object.freeze(Object.keys(BUILT_IN_PROJECT_YML) as (keyof ProjectYml)[]);

export function createBuiltInProjectYml(): ProjectYml {
  return structuredClone(BUILT_IN_PROJECT_YML) as ProjectYml;
}

export const DEFAULT_LEAD_BRANCHES = ["main", "master"];
export const NO_PROFILE = "none";

export function activeProfile(config: ProjectYml | null): string | null {
  const name = config?.profile;
  return name == null || name === NO_PROFILE ? null : name;
}

// First entry is the default; absent or empty means claude only (todo 526).
export function allowedAgents(config: ProjectYml | null): string[] {
  const list = config?.agents;
  return list && list.length > 0 ? list : ["claude"];
}

function agentVarKey(harness: string): string {
  return `agents_${harness}`;
}

// One var per allowed harness, "1" - distinct from brief.ts's per-spawn harness_claude/harness_codex.
export function agentVars(config: ProjectYml | null): Record<string, string> {
  return Object.fromEntries(allowedAgents(config).map((name) => [agentVarKey(name), "1"]));
}

// Every known harness's key, not just currently-allowed ones - a strip for a disallowed harness
// is correct, not missing, so doctor's scan must exclude the whole family.
export function agentVarKeys(): string[] {
  return harnessNames().map(agentVarKey);
}

// Mirrors mergedBriefVars (src/brief.ts): strip any project-defined agents_* var first so a lying
// one can never silently win, then spread the derived vars on top.
export function mergedProjectVars(config: ProjectYml | null): Record<string, string> {
  const safe = { ...(config?.vars ?? {}) };
  for (const key of agentVarKeys()) delete safe[key];
  return { ...safe, ...agentVars(config) };
}

export type FirstMessageSource = "project" | "global" | "shipped" | "empty";

export interface ResolvedFirstMessage {
  message: string;
  source: FirstMessageSource;
}

// "" (or whitespace only) is deliberate: it sends no first message at all, it does not fall back.
export function resolveFirstMessage(
  config: ProjectYml | null,
  sources: Record<string, ConfigSource> = {},
): ResolvedFirstMessage {
  const value = config?.first_message;
  if (value == null) return { message: TRIAGE_MESSAGE, source: "shipped" };
  if (value.trim() === "") return { message: "", source: "empty" };
  return { message: value, source: sources.first_message === "global" ? "global" : "project" };
}

export interface ResolvedHiveConfig {
  config: ProjectYml | null;
  warnings: string[];
  sources: Record<string, ConfigSource>;
  attach: { mode: AttachMode; source: ConfigSource };
  autoAttach: { value: AutoAttach; source: ConfigSource };
}

type NullableField = "lead" | "placement" | "layout" | "profile" | "context_checkpoint_percent";

function isMapping(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseFile(path: string, warnings: string[]): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`${path}: could not read hive.yml: ${errorMessage(error)}`);
    }
    return null;
  }
  try {
    const raw: unknown = parse(text);
    if (raw == null && isEmptyYamlDocument(text)) return null;
    if (!isMapping(raw)) {
      warnings.push(`${path}: hive.yml must be a YAML mapping.`);
      return null;
    }
    return raw;
  } catch (error) {
    warnings.push(`${path}: hive.yml is not valid YAML: ${errorMessage(error)}`);
    return null;
  }
}

function parseProcesses(value: unknown, path: string, warnings: string[]): Record<string, YmlProcess> | null {
  if (!isMapping(value)) {
    warnings.push(`${path}: hive.yml \`processes\` must be a mapping of name to command.`);
    return null;
  }
  const processes: Record<string, YmlProcess> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string" && item.trim() !== "") {
      processes[name] = { command: item.trim(), dir: null, auto_start: true, visible: true, env: {} };
      continue;
    }
    if (!isMapping(item)) {
      warnings.push(`${path}: Process "${name}" needs a command string; skipped.`);
      continue;
    }
    if (typeof item.command !== "string" || item.command.trim() === "") {
      warnings.push(`${path}: Process "${name}" has no command; skipped.`);
      continue;
    }
    const dirValue = item.dir ?? item.working_dir;
    let visible = true;
    if (item.visible != null) {
      if (typeof item.visible === "boolean") visible = item.visible;
      else warnings.push(`${path}: Process "${name}": visible must be true or false; ignoring "${String(item.visible)}".`);
    }
    const env: Record<string, string> = {};
    if (isMapping(item.env)) {
      for (const [key, envValue] of Object.entries(item.env)) env[key] = String(envValue);
    }
    processes[name] = {
      command: item.command.trim(),
      dir: typeof dirValue === "string" && dirValue.trim() !== "" ? dirValue.trim() : null,
      auto_start: item.auto_start !== false,
      visible,
      env,
    };
  }
  return processes;
}

function applyLayer(
  root: Record<string, unknown>,
  path: string,
  source: "global" | "project",
  config: ProjectYml,
  sources: Record<string, ConfigSource>,
  warnings: string[],
): void {
  const has = (key: string) => Object.hasOwn(root, key);
  const warn = (message: string) => warnings.push(`${path}: ${message}`);
  const assignNullable = (key: NullableField, valid: (value: unknown) => unknown, message: (value: unknown) => string) => {
    if (!has(key)) return;
    const value = root[key];
    if (value == null) {
      (config as unknown as Record<string, unknown>)[key] = null;
      sources[key] = source;
    } else {
      const normalized = valid(value);
      if (normalized === undefined) warn(message(value));
      else {
        (config as unknown as Record<string, unknown>)[key] = normalized;
        sources[key] = source;
      }
    }
  };

  assignNullable("lead", (value) => typeof value === "string" && value.trim() ? value.trim() : undefined,
    (value) => `lead must be a non-empty command string; ignoring "${String(value)}".`);
  assignNullable("placement", (value) => value === "split" || value === "window" ? value : undefined,
    (value) => `placement must be "split" or "window"; ignoring "${String(value)}".`);
  assignNullable("layout", (value) => isWindowLayout(value) ? value : undefined,
    (value) => `layout must be one of ${WINDOW_LAYOUTS.join(", ")}; ignoring "${String(value)}".`);
  assignNullable("profile", (value) => {
    const name = String(value).trim();
    return name !== "" && (name === NO_PROFILE || isValidProfileName(name)) ? name : undefined;
  }, (value) => typeof value === "string" && value.trim() === ""
    ? "profile is empty; ignoring it."
    : `profile "${String(value).trim()}" is not a valid profile name (letters, digits, dot, dash, underscore); ignoring it.`);
  assignNullable("context_checkpoint_percent", (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100 ? value : undefined,
  () => "context_checkpoint_percent must be an integer from 1 through 100; ignoring it.");

  if (has("lead_turn_budget")) {
    const value = root.lead_turn_budget;
    if (value == null) {
      config.lead_turn_budget = null;
      sources.lead_turn_budget = source;
    } else if (isMapping(value) && typeof value.warn === "number" && Number.isInteger(value.warn) && value.warn > 0 &&
      typeof value.stop === "number" && Number.isInteger(value.stop) && value.stop > value.warn) {
      config.lead_turn_budget = { warn: value.warn, stop: value.stop };
      sources.lead_turn_budget = source;
    } else {
      warn("lead_turn_budget must contain positive integer warn and stop values, with stop greater than warn; ignoring it.");
    }
  }

  if (has("dashboard")) {
    const value = root.dashboard;
    if (value == null) {
      config.dashboard = false;
      sources.dashboard = source;
    } else if (typeof value === "boolean") {
      config.dashboard = value;
      sources.dashboard = source;
    } else warn(`dashboard must be true or false; ignoring "${String(value)}".`);
  }

  if (has("agents")) {
    const value = root.agents;
    if (value == null) {
      config.agents = null;
      sources.agents = source;
    } else if (Array.isArray(value)) {
      const known = harnessNames();
      const valid: string[] = [];
      for (const entry of value) {
        const name = typeof entry === "string" ? entry.trim() : "";
        if (!name) warn("agents entry must be a non-empty harness name; skipped.");
        else if (!known.includes(name)) warn(`agents: "${name}" is not a known harness (${known.join(", ")}); ignoring it.`);
        else valid.push(name);
      }
      config.agents = valid.length ? valid : null;
      sources.agents = source;
    } else warn("agents must be a list of harness names; ignoring it.");
  }

  if (has("lead_branches")) {
    const value = root.lead_branches;
    if (value == null) {
      config.lead_branches = null;
      sources.lead_branches = source;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "")) {
      config.lead_branches = value.map((item) => (item as string).trim());
      sources.lead_branches = source;
    } else warn("lead_branches must be a list of branch names; ignoring it.");
  }

  if (has("first_message")) {
    const value = root.first_message;
    if (value == null) {
      config.first_message = null;
      sources.first_message = source;
    } else if (typeof value === "string") {
      config.first_message = value;
      sources.first_message = source;
    } else warn("first_message must be a string; ignoring it.");
  }

  if (has("vars")) {
    const value = root.vars;
    if (value == null) {
      for (const key of Object.keys(config.vars)) sources[`vars.${key}`] = source;
      config.vars = {};
      sources.vars = source;
    } else if (isMapping(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (item == null) {
          delete config.vars[key];
          sources[`vars.${key}`] = source;
          sources.vars = source;
        } else if (typeof item === "object") {
          warn(`var "${key}" must be a scalar; skipped.`);
        } else {
          config.vars[key] = String(item);
          sources[`vars.${key}`] = source;
          sources.vars = source;
        }
      }
    } else warn("vars must be a mapping of name to value; ignoring it.");
  }

  if (has("processes")) {
    if (source === "global") warn("global hive.yml cannot define `processes`; only project commands can be trusted.");
    else if (root.processes != null) {
      const processes = parseProcesses(root.processes, path, warnings);
      if (processes != null) {
        config.processes = processes;
        sources.processes = source;
      }
    }
  }

  for (const key of ["attach", "autoAttach"] as const) {
    if (source === "project" && has(key)) warn(`${key} is global-only; ignoring it in project hive.yml.`);
  }
  if (has("review_tags")) warn("review_tags is no longer used by hive; remove it from hive.yml.");
}

export function resolveHiveConfig(projectPath?: string): ResolvedHiveConfig {
  const global = readGlobalConfig();
  const warnings = [...global.warnings];
  const config = createBuiltInProjectYml();
  const sources: Record<string, ConfigSource> = Object.fromEntries(
    PROJECT_YML_KEYS.map((key) => [key, "built-in"] as const),
  );

  if (global.root) applyLayer(global.root, globalConfigPath(), "global", config, sources, warnings);

  let projectValid = false;
  if (projectPath != null) {
    const file = resolve(projectPath, "hive.yml");
    const project = parseFile(file, warnings);
    if (project) {
      projectValid = true;
      applyLayer(project, file, "project", config, sources, warnings);
    }
  }

  const attachResult = resolveAttachSetting("attach", global.root, global.legacy, warnings) as {
    mode: AttachMode; source: ConfigSource;
  };
  const autoAttachResult = resolveAttachSetting("autoAttach", global.root, global.legacy, warnings) as {
    value: AutoAttach; source: ConfigSource;
  };

  return {
    config: global.root || projectValid ? config : null,
    warnings,
    sources,
    attach: attachResult,
    autoAttach: autoAttachResult,
  };
}

export function loadProjectYml(projectPath: string): ResolvedHiveConfig {
  return resolveHiveConfig(projectPath);
}

export function configHash(name: string, command: string, dir: string | null, env: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([name, command, dir, env]))
    .digest("hex");
}

export function resolveCommandDir(projectPath: string, dir: string | null): string {
  if (dir == null) return projectPath;
  const resolved = realpathSync(resolve(projectPath, dir));
  if (resolved !== projectPath && !resolved.startsWith(projectPath + sep)) {
    throw new Error(`dir "${dir}" escapes the project root`);
  }
  return resolved;
}
