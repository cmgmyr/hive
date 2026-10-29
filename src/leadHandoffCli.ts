import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { join } from "node:path";
import { dataDir, db } from "./db.js";
import { cliPath } from "./dispatcher.js";
import { FIRST_MESSAGE_SHA_ENV, firstMessageDigest } from "./firstMessage.js";
import { ensureLeadHooksFile } from "./hooks.js";
import { appendClaudeLeadArgs, crewPluginDir, isTrusted, leadIdentityEnv, renderLeadPosture } from "./leadLaunch.js";
import { loadProjectYml, quietMessagingEnabled } from "./projectYml.js";
import { buildEnvFlags } from "./spawn.js";
import { panePidForRecord, rowOwnership, shellQuote, tmux, TmuxTimeoutError } from "./tmux.js";
import {
  automationBlocker,
  failHandoff,
  missingHeadings,
  padProblem,
  readPad,
  RESPAWN_WAIT_LIMIT_SECONDS,
  respawnVerdict,
  type RunningLead,
  runningLeadByActor,
  sha256,
  successorPrompt,
} from "./leadHandoff.js";
import { casHandoff, type HandoffRow, nowSql, olderThan, postponeGrace, quotedPolicy, readHandoff } from "./leadHandoffState.js";
import { readLeadSafetySnapshot } from "./leadState.js";
import { readTurnCount } from "./turnCount.js";
import { harnessFor } from "./harnesses.js";

const POLL_MS = 1_000;
const HANDOFF_PAD_SOFT_CAP = 8_000;

function flags(argv: string[], names: readonly string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || !names.includes(name) || argv[i + 1] === undefined) {
      return `unexpected argument "${argv[i]}"`;
    }
    out[name] = argv[++i];
  }
  const absent = names.filter((n) => out[n] === undefined);
  return absent.length > 0 ? `missing --${absent.join(", --")}` : out;
}

function rejectUnknownFlag(argv: string[], command: string, names: readonly string[], flagsText: string): boolean {
  const known = new Set(names.map((name) => `--${name}`));
  for (let i = 0; i < argv.length; i++) {
    if (known.has(argv[i])) {
      i++;
      continue;
    }
    if (argv[i].startsWith("-")) {
      console.error(`hive ${command}: unknown argument "${argv[i]}". Flags are ${flagsText}.`);
      return true;
    }
  }
  return false;
}

const intFlag = (value: string): number | null => (/^\d+$/.test(value) ? Number(value) : null);

function runningLeadById(id: number): RunningLead | undefined {
  return db
    .prepare(
      `SELECT a.id, a.project_id, a.actor_id, a.command, a.pane_pid, a.tmux_target, a.tmux_socket, p.path, p.name
         FROM agents a JOIN projects p ON p.id = a.project_id WHERE a.id = ? AND a.kind = 'lead' AND a.status = 'running'`,
    )
    .get(id) as RunningLead | undefined;
}

export async function cmdLeadHandoff(argv: string[]): Promise<number> {
  if (rejectUnknownFlag(argv, "lead-handoff", ["request", "pad", "revision"], "--request <id>, --pad <id>, --revision <n>")) return 1;
  const refuse = (why: string): number => {
    console.error(`hive lead-handoff: ${why}. This session stays as it is.`);
    return 1;
  };
  const parsed = flags(argv, ["request", "pad", "revision"]);
  if (typeof parsed === "string") return refuse(`${parsed}; usage: hive lead-handoff --request <id> --pad <id> --revision <n>`);
  const [requestId, padId, revision] = [intFlag(parsed.request), intFlag(parsed.pad), intFlag(parsed.revision)];
  if (requestId === null || padId === null || revision === null) return refuse("--request, --pad and --revision take whole numbers");
  const actor = process.env.HIVE_AGENT_ID ?? "";
  const lead = process.env.HIVE_LEAD === "1" ? runningLeadByActor(actor) : undefined;
  if (lead === undefined) return refuse("only a running lead can hand itself off");
  if ((process.env.TMUX_PANE ?? "") !== lead.tmux_target || rowOwnership(lead) !== "live") {
    return refuse("this is not running in the lead's own recorded pane");
  }
  const row = readHandoff(requestId);
  if (row === null || row.lead_agent_id !== lead.id) return refuse(`there is no handoff request #${requestId} for this lead`);
  if (row.state !== "requested") return refuse(`handoff #${requestId} is ${row.state}, not waiting for this command`);
  const snapshot = readLeadSafetySnapshot(lead.id);
  if (lead.pane_pid !== row.predecessor_pane_pid || snapshot?.session_id !== row.predecessor_session_id) {
    return refuse(`handoff #${requestId} was requested for a different session of this lead`);
  }
  const pad = readPad(padId);
  const problem = padProblem(pad, lead.project_id, revision);
  if (problem !== null) return refuse(problem);
  if (row.pad_id === pad!.id && row.pad_revision !== null && pad!.revision <= row.pad_revision) {
    return refuse("this attempt was postponed, so refresh the pad (write it again) and pass the new revision");
  }
  const missing = missingHeadings(pad!.content);
  if (missing.length > 0) return refuse(`the pad is missing these headings, in this order: ${missing.join("; ")}`);
  const inFlight = automationBlocker(lead, null);
  if (inFlight !== null) return refuse(`${inFlight}; run this command again in a minute`);

  const token = randomUUID();
  const policy = quotedPolicy(row);
  const claimed = casHandoff(
    row.id,
    ["requested"],
    {
      state: "grace",
      attempt: row.attempt + 1,
      owner_token: token,
      grace_seconds: policy.graceSeconds,
      grace_started_at: nowSql(),
      human_prompt_baseline: snapshot!.human_prompt_seq,
      pad_id: pad!.id,
      pad_revision: pad!.revision,
      pad_length: pad!.content.length,
      pad_sha256: sha256(pad!.content),
      predecessor_turns: readTurnCount(snapshot!.transcript_path),
      hold_since: row.hold_since ?? nowSql(),
      hold_released_at: null,
    },
    { attempt: row.attempt },
  );
  if (!claimed) return refuse(`handoff #${requestId} changed while this command ran`);
  const attempt = row.attempt + 1;
  try {
    const log = openSync(join(dataDir, `lead-handoff-${row.id}.log`), "a");
    const child = spawn(
      process.execPath,
      [cliPath(), "lead-handoff-grace", "--request", String(row.id), "--attempt", String(attempt), "--token", token],
      { detached: true, stdio: ["ignore", log, log], env: process.env },
    );
    child.unref();
    if (child.pid === undefined) throw new Error("no process id");
    casHandoff(row.id, ["grace"], { owner_pid: child.pid }, { attempt, owner_token: token });
  } catch (e) {
    failHandoff(row.id, `the grace owner could not start: ${e instanceof Error ? e.message : String(e)}`, ["grace"], {
      attempt,
      owner_token: token,
    });
    return refuse("the grace owner could not start, so the handoff failed");
  }
  if (pad!.content.length > HANDOFF_PAD_SOFT_CAP) {
    console.log(`! the pad is ${pad!.content.length} characters, over the ${HANDOFF_PAD_SOFT_CAP}-character guide; point into the store instead of copying it.`);
  }
  console.log(
    `Handoff #${row.id} armed (attempt ${attempt}, pad #${pad!.id} revision ${pad!.revision}). hive replaces this session in ` +
      `${policy.graceSeconds} s if nothing happens; any human input postpones it. End your turn now.`,
  );
  return 0;
}

// Prepared before the destructive claim: a launch that cannot be built leaves the predecessor alive.
async function successorLaunch(row: HandoffRow, lead: RunningLead, attempt: number, token: string): Promise<{ launch: string; env: string[] }> {
  const config = loadProjectYml(lead.path).config;
  let command = "claude";
  if (config?.lead) {
    if (!isTrusted(lead.project_id, "lead", config.lead, null, {})) throw new Error("the configured lead command is not trusted");
    command = config.lead;
  }
  const harness = harnessFor(command);
  if (harness.name !== "claude" || !harness.briefDelivery) throw new Error("the configured lead command is not a Claude lead");
  const firstMessage = successorPrompt(row);
  const built = appendClaudeLeadArgs({
    command,
    harness,
    projectId: lead.project_id,
    projectName: lead.name,
    hooksPath: ensureLeadHooksFile(lead.project_id, quietMessagingEnabled(config)),
    sidebarPluginDir: config?.lead_sidebar === true ? crewPluginDir() : null,
    posture: renderLeadPosture(config).rendered,
    firstMessage,
  });
  const bootstrap = [process.execPath, cliPath(), "lead-handoff-start", "--request", String(row.id), "--attempt", String(attempt), "--token", token]
    .map(shellQuote)
    .join(" ");
  return {
    launch: `${bootstrap} && exec ${built.command}${built.promptSuffix}`,
    env: buildEnvFlags({ ...leadIdentityEnv(lead.actor_id), [FIRST_MESSAGE_SHA_ENV]: firstMessageDigest(firstMessage) }),
  };
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `hive lead-handoff-grace`: the one detached owner of an attempt. It never outlives a changed
// attempt or token, and after it claims the respawn it never repeats the kill.
export async function runHandoffGrace(argv: string[]): Promise<number> {
  if (rejectUnknownFlag(argv, "lead-handoff-grace", ["request", "attempt", "token"], "--request <id>, --attempt <n>, --token <token>")) return 1;
  try {
    return await graceLoop(argv);
  } catch (e) {
    const parsed = flags(argv, ["request", "attempt", "token"]);
    const id = typeof parsed === "string" ? null : intFlag(parsed.request);
    const attempt = typeof parsed === "string" ? null : intFlag(parsed.attempt);
    if (id !== null && attempt !== null && typeof parsed !== "string") {
      failHandoff(id, `the grace owner failed: ${e instanceof Error ? e.message : String(e)}`, ["grace"], {
        attempt,
        owner_token: parsed.token,
      });
    }
    return 1;
  }
}

async function graceLoop(argv: string[]): Promise<number> {
  const parsed = flags(argv, ["request", "attempt", "token"]);
  if (typeof parsed === "string") return 1;
  const id = intFlag(parsed.request);
  const attempt = intFlag(parsed.attempt);
  const token = parsed.token;
  if (id === null || attempt === null) return 1;
  const own = (row: HandoffRow | null): row is HandoffRow =>
    row !== null && row.state === "grace" && row.attempt === attempt && row.owner_token === token;
  let waitingSince: number | null = null;
  for (;;) {
    const row = readHandoff(id);
    if (!own(row)) return 0;
    const lead = runningLeadById(row.lead_agent_id);
    const snapshot = lead === undefined ? null : readLeadSafetySnapshot(lead.id);
    if (snapshot !== null && row.human_prompt_baseline !== null && snapshot.human_prompt_seq > row.human_prompt_baseline) {
      postponeGrace(row, { attempt: row.attempt, owner_token: token }, "a human prompt arrived during grace", true);
      return 0;
    }
    if (!olderThan(row.grace_started_at, row.grace_seconds ?? 120)) {
      await sleepMs(POLL_MS);
      continue;
    }
    const budget = lead === undefined ? null : (loadProjectYml(lead.path).config?.lead_turn_budget ?? null);
    const verdict = await respawnVerdict(row, lead, budget);
    if ("fail" in verdict) {
      failHandoff(row.id, verdict.fail, ["grace"], { attempt, owner_token: token });
      return 0;
    }
    if ("postpone" in verdict) {
      postponeGrace(row, { attempt: row.attempt, owner_token: token }, verdict.postpone, verdict.escalate);
      return 0;
    }
    if ("wait" in verdict) {
      waitingSince ??= Date.now();
      if (row.blocked_reason !== verdict.wait) casHandoff(row.id, ["grace"], { blocked_reason: verdict.wait }, { attempt, owner_token: token });
      if (Date.now() - waitingSince >= RESPAWN_WAIT_LIMIT_SECONDS * 1000) {
        postponeGrace(row, { attempt: row.attempt, owner_token: token }, verdict.wait, false);
        return 0;
      }
      await sleepMs(POLL_MS);
      continue;
    }
    let launch: { launch: string; env: string[] };
    try {
      launch = await successorLaunch(row, lead!, attempt, token);
    } catch (e) {
      failHandoff(row.id, `the successor launch could not be prepared: ${e instanceof Error ? e.message : String(e)}`, ["grace"], {
        attempt,
        owner_token: token,
      });
      return 0;
    }
    if (!casHandoff(row.id, ["grace"], { state: "respawning", owner_pid: process.pid, respawn_claimed_at: nowSql() }, { attempt, owner_token: token })) return 0;
    try {
      tmux("respawn-pane", "-k", "-t", row.pane_target, "-c", lead!.path, ...launch.env, launch.launch);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (e instanceof TmuxTimeoutError) {
        casHandoff(row.id, ["respawning"], { state: "ambiguous", failure: `respawn-pane timed out; the pane's owner is unknown: ${detail}` }, { attempt, owner_token: token });
      } else {
        failHandoff(row.id, `respawn-pane refused: ${detail}`, ["respawning"], { attempt, owner_token: token });
      }
    }
    return 0;
  }
}

// `hive lead-handoff-start`: runs in the respawned pane before Claude. It publishes the successor's
// pid on the same lead row by CAS against the predecessor, and only then lets the shell exec Claude.
export async function runHandoffStart(argv: string[]): Promise<number> {
  if (rejectUnknownFlag(argv, "lead-handoff-start", ["request", "attempt", "token"], "--request <id>, --attempt <n>, --token <token>")) return 1;
  const parsed = flags(argv, ["request", "attempt", "token"]);
  const refuse = (why: string, id?: number): number => {
    if (id !== undefined) {
      casHandoff(id, ["respawning", "ambiguous"], { state: "failed", failure: `the successor bootstrap refused: ${why}`, owner_token: null, owner_pid: null });
    }
    console.error(`hive lead-handoff-start: ${why}. The handoff pad stays active; run hive lead to start a lead.`);
    return 1;
  };
  if (typeof parsed === "string") return refuse(parsed);
  const id = intFlag(parsed.request);
  const attempt = intFlag(parsed.attempt);
  if (id === null || attempt === null) return refuse("bad arguments");
  const row = readHandoff(id);
  if (row === null || (row.state !== "respawning" && row.state !== "ambiguous") || row.attempt !== attempt || row.owner_token !== parsed.token) {
    return refuse("this bootstrap does not own a respawning handoff");
  }
  const pane = process.env.TMUX_PANE ?? "";
  if (pane !== row.pane_target) return refuse("this is not the pane the handoff respawned", id);
  const pid = panePidForRecord(pane);
  if (pid === "" || pid !== String(process.ppid)) return refuse("the pane's process id does not match this bootstrap's shell", id);
  const publish = db.transaction((): boolean => {
    const moved = db
      .prepare(
        `UPDATE agents SET pane_pid = ?, claude_messaging_socket = '', claude_messaging_pane_pid = ''
          WHERE id = ? AND kind = 'lead' AND status = 'running' AND tmux_target = ? AND pane_pid = ?`,
      )
      .run(pid, row.lead_agent_id, row.pane_target, row.predecessor_pane_pid).changes;
    if (moved !== 1) return false;
    const started = casHandoff(
      id,
      ["respawning", "ambiguous"],
      { state: "started", successor_pane_pid: pid, started_at: nowSql(), owner_token: null, owner_pid: null, failure: null },
      { attempt, owner_token: parsed.token },
    );
    if (!started) throw new Error("handoff changed");
    return true;
  });
  let published: boolean;
  try {
    published = publish.immediate();
  } catch {
    published = false;
  }
  if (!published) return refuse("the lead row could not be moved to the new pane process", id);
  console.log(`hive: handoff #${id}: starting a fresh lead session in this pane.`);
  return 0;
}
