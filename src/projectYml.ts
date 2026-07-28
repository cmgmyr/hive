import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse } from "yaml";
import { errorMessage } from "./result.js";
import { isWindowLayout, WINDOW_LAYOUTS, type WindowLayout } from "./tmux.js";

// hive.yml: minimal repo-controlled project config.
//
//   lead: claude --model opus      # optional command for the lead window
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
  processes: Record<string, YmlProcess>;
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

  return { config: { lead, placement, layout, processes }, warnings };
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
