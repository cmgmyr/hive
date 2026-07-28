import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isValidProfileName } from "./profiles.js";
import { errorMessage } from "./result.js";
import { isWindowLayout, WINDOW_LAYOUTS, type WindowLayout } from "./tmux.js";

// hive.yml: minimal repo-controlled project config.
//
//   lead: claude --model opus      # optional command for the lead window
//   profile: orchestration         # standing instructions this project runs under
//   lead_branches: [main, master]  # branches where a lead gets the kickoff
//   vars:                          # substituted into the profile runbook
//     repo: owner/name
//   processes:
//     npm:dev: npm run dev         # shorthand form
//     queue:                       # expanded form
//       command: php artisan queue:work
//       dir: ./api                 # relative to the project root
//       auto_start: false          # default true
//       env:
//         APP_ENV: local
//
// Unknown keys are ignored, so configs copied from similar tools parse.

export interface YmlProcess {
  command: string;
  dir: string | null;
  auto_start: boolean;
  env: Record<string, string>;
}

export interface ProjectYml {
  lead: string | null;
  placement: "split" | "window" | null;
  layout: WindowLayout | null;
  // The profile whose standing instructions this project runs under.
  // null means the key is absent ("never asked", so `hive init` may offer it);
  // "none" means the human decided this project is runbook-pad only.
  profile: string | null;
  // Branches where a lead session gets the kickoff. null means unset, and
  // callers apply DEFAULT_LEAD_BRANCHES.
  lead_branches: string[] | null;
  vars: Record<string, string>;
  processes: Record<string, YmlProcess>;
}

export const DEFAULT_LEAD_BRANCHES = ["main", "master"];
export const NO_PROFILE = "none";

// The profile a project actually runs under, or null. Decoding the sentinel
// belongs next to it: every consumer that reads config.profile raw is one
// that can forget "none" is not a profile name.
export function activeProfile(config: ProjectYml | null): string | null {
  const name = config?.profile;
  return name == null || name === NO_PROFILE ? null : name;
}

export function loadProjectYml(projectPath: string): {
  config: ProjectYml | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const file = join(projectPath, "hive.yml");
  if (!existsSync(file)) return { config: null, warnings };

  let raw: unknown;
  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (e) {
    warnings.push(`hive.yml is not valid YAML: ${errorMessage(e)}`);
    return { config: null, warnings };
  }
  if (raw == null || typeof raw !== "object") {
    warnings.push("hive.yml must be a YAML mapping.");
    return { config: null, warnings };
  }

  const root = raw as Record<string, unknown>;
  const lead = typeof root.lead === "string" && root.lead.trim() !== "" ? root.lead.trim() : null;
  let placement: "split" | "window" | null = null;
  if (root.placement != null) {
    if (root.placement === "split" || root.placement === "window") {
      placement = root.placement;
    } else {
      warnings.push(`placement must be "split" or "window"; ignoring "${String(root.placement)}".`);
    }
  }
  let layout: WindowLayout | null = null;
  if (root.layout != null) {
    if (isWindowLayout(root.layout)) {
      layout = root.layout;
    } else {
      warnings.push(
        `layout must be one of ${WINDOW_LAYOUTS.join(", ")}; ignoring "${String(root.layout)}".`,
      );
    }
  }
  let profile: string | null = null;
  if (root.profile != null) {
    const value = String(root.profile).trim();
    if (value === "") {
      warnings.push("profile is empty; ignoring it.");
    } else if (value !== NO_PROFILE && !isValidProfileName(value)) {
      warnings.push(
        `profile "${value}" is not a valid profile name (letters, digits, dot, dash, underscore); ignoring it.`,
      );
    } else {
      profile = value;
    }
  }

  let lead_branches: string[] | null = null;
  if (root.lead_branches != null) {
    const raw = Array.isArray(root.lead_branches) ? root.lead_branches : null;
    const branches = raw
      ?.filter((b) => typeof b === "string" && b.trim() !== "")
      .map((b) => (b as string).trim());
    if (branches && branches.length === raw!.length) {
      lead_branches = branches;
    } else {
      warnings.push("lead_branches must be a list of branch names; ignoring it.");
    }
  }

  const vars: Record<string, string> = {};
  if (root.vars != null) {
    if (typeof root.vars !== "object" || Array.isArray(root.vars)) {
      warnings.push("vars must be a mapping of name to value; ignoring it.");
    } else {
      for (const [key, value] of Object.entries(root.vars as Record<string, unknown>)) {
        if (value == null || typeof value === "object") {
          warnings.push(`var "${key}" must be a scalar; skipped.`);
          continue;
        }
        vars[key] = String(value);
      }
    }
  }

  const processes: Record<string, YmlProcess> = {};

  const rawProcesses = root.processes;
  if (rawProcesses != null) {
    if (typeof rawProcesses !== "object") {
      warnings.push("hive.yml `processes` must be a mapping of name to command.");
    } else {
      for (const [name, value] of Object.entries(rawProcesses as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim() !== "") {
          processes[name] = { command: value.trim(), dir: null, auto_start: true, env: {} };
          continue;
        }
        if (value == null || typeof value !== "object") {
          warnings.push(`Process "${name}" needs a command string; skipped.`);
          continue;
        }
        const p = value as Record<string, unknown>;
        if (typeof p.command !== "string" || p.command.trim() === "") {
          warnings.push(`Process "${name}" has no command; skipped.`);
          continue;
        }
        const dirValue = p.dir ?? p.working_dir;
        const env: Record<string, string> = {};
        if (p.env != null && typeof p.env === "object") {
          for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
            env[k] = String(v);
          }
        }
        processes[name] = {
          command: p.command.trim(),
          dir: typeof dirValue === "string" && dirValue.trim() !== "" ? dirValue.trim() : null,
          auto_start: p.auto_start !== false,
          env,
        };
      }
    }
  }

  return { config: { lead, placement, layout, profile, lead_branches, vars, processes }, warnings };
}

// A command's trust is tied to everything that affects what it executes.
// Any change requires re-approval.
export function configHash(name: string, command: string, dir: string | null, env: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify([name, command, dir, env]))
    .digest("hex");
}

// Repo-controlled working dirs must stay inside the project root.
export function resolveCommandDir(projectPath: string, dir: string | null): string {
  if (dir == null) return projectPath;
  const resolved = realpathSync(resolve(projectPath, dir));
  if (resolved !== projectPath && !resolved.startsWith(projectPath + sep)) {
    throw new Error(`dir "${dir}" escapes the project root`);
  }
  return resolved;
}
