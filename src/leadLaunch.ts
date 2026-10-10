import { writeProjectPosture } from "./brief.js";
import { dataDir, db } from "./db.js";
import { carriesNameFlag, type HarnessCapabilities } from "./harnesses.js";
import { join } from "node:path";
import { checkoutRoot, renderProfileFile, resolveProfileFile } from "./profiles.js";
import { activeProfile, configHash, mergedProjectVars, type ProjectYml } from "./projectYml.js";
import { LEAD_NAME } from "./spawn.js";
import { shellQuote } from "./tmux.js";

// What `hive lead` and the handoff bootstrap both need to launch a claude lead: trust, posture,
// hooks and identity env. Pane adoption and leftover cleanup stay in cmdLead.

export function isTrusted(
  projectId: number,
  name: string,
  command: string,
  dir: string | null,
  env: Record<string, string>,
): boolean {
  const hash = configHash(name, command, dir, env);
  return !!db
    .prepare("SELECT 1 FROM command_trust WHERE project_id = ? AND name = ? AND config_hash = ?")
    .get(projectId, name, hash);
}

export function crewPluginDir(): string {
  return join(checkoutRoot, "claude-plugin", "crew");
}

export interface LeadPosture {
  profile: string | null;
  rendered: string | null;
  source?: string;
}

export function renderLeadPosture(config: ProjectYml | null): LeadPosture {
  const profile = activeProfile(config);
  if (!profile) return { profile: null, rendered: null };
  const posture = resolveProfileFile(profile, "posture.md");
  if (!posture) return { profile, rendered: null };
  return { profile, rendered: renderProfileFile(profile, "posture.md", mergedProjectVars(config)) ?? "", source: posture.source };
}

export function appendClaudeLeadArgs(input: {
  command: string;
  harness: HarnessCapabilities;
  projectId: number;
  projectName: string;
  hooksPath: string;
  sidebarPluginDir: string | null;
  posture: string | null;
  firstMessage: string;
}): { command: string; promptSuffix: string } {
  const delivery = input.harness.briefDelivery!;
  let command = input.command;
  if (!carriesNameFlag(command.trim().split(/\s+/))) command += ` --name ${shellQuote(input.projectName)}`;
  command += ` ${delivery.settingsArgs(input.hooksPath).map(shellQuote).join(" ")}`;
  if (input.sidebarPluginDir !== null) command += ` ${["--plugin-dir", input.sidebarPluginDir].map(shellQuote).join(" ")}`;
  if (input.posture !== null) {
    command += ` ${delivery.systemPromptArgs(writeProjectPosture(input.projectId, input.posture)).map(shellQuote).join(" ")}`;
  }
  const promptSuffix =
    input.harness.initialPromptArgs && input.firstMessage !== ""
      ? ` ${input.harness.initialPromptArgs(input.firstMessage).map(shellQuote).join(" ")}`
      : "";
  return { command, promptSuffix };
}

export function leadIdentityEnv(actorId: string): Record<string, string> {
  return {
    HIVE_AGENT_ID: actorId,
    HIVE_AGENT_NAME: LEAD_NAME,
    HIVE_LEAD: "1",
    HIVE_DATA_DIR: dataDir,
    HIVE_PROJECT_LOCK: "",
    HIVE_PROJECT_PATH: "",
  };
}
