import { createConnection } from "node:net";
import { join } from "node:path";
import { db } from "./db.js";
import { loadProjectYml } from "./projectYml.js";
import { DELIVERY_METHOD } from "./wakeSql.js";

export { DELIVERY_METHOD } from "./wakeSql.js";

export const CROSS_SESSION_CLOSE = "</cross-session-message>";
export const ENVELOPE_OPEN = '<cross-session-message from="';
export const ENVELOPE_SENDER_CLOSE = '" from-name="hive">';
export const SOCKET_WAKE_FOOTER = "Automated hive wake. Do not reply to this sender.";
export const SOCKET_MESSAGE_FOOTER = "Automated hive worker message. Do not reply to this socket sender.";
export const SOCKET_WRITE_BOUND_MS = 1000;
export const SOCKET_CONFIRM_GRACE_SECONDS = 60;

export function senderAddress(socketPath: string): string {
  const encoded = socketPath.replace(/[^A-Za-z0-9/._-]/gu, (c) =>
    [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
  return `uds:${encoded}`;
}

export function socketSenderAddress(dir: string): string {
  return senderAddress(join(dir, "wake-sender.sock"));
}

function claudeWakeFrame(sender: string, text: string): string {
  const content = `${ENVELOPE_OPEN}${sender}${ENVELOPE_SENDER_CLOSE}\n${text}\n${CROSS_SESSION_CLOSE}`;
  return JSON.stringify({ type: "user", from: sender, message: { role: "user", content } }) + "\n";
}

export function quietMessagingOn(projectId: number): boolean {
  const project = db.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | undefined;
  return project !== undefined && loadProjectYml(project.path).config?.quiet_messaging === true;
}

export function promptMarkerEvidenceSql(markerAt: (promptSql: string, startSql: string) => string): string {
  const evPrompt =
    "(CASE WHEN json_valid(ev.payload) THEN COALESCE(json_extract(ev.payload, '$.prompt'), '') ELSE ev.payload END)";
  const headerEnd = `instr(${evPrompt}, char(10))`;
  return `(${markerAt(evPrompt, "1")}\n               OR (${headerEnd} > ${ENVELOPE_OPEN.length + ENVELOPE_SENDER_CLOSE.length}
                   AND substr(${evPrompt}, 1, ${ENVELOPE_OPEN.length}) = '${ENVELOPE_OPEN}'
                   AND substr(${evPrompt}, ${headerEnd} - ${ENVELOPE_SENDER_CLOSE.length}, ${ENVELOPE_SENDER_CLOSE.length}) = '${ENVELOPE_SENDER_CLOSE}'
                   AND instr(substr(${evPrompt}, ${ENVELOPE_OPEN.length + 1}, ${headerEnd} - ${ENVELOPE_OPEN.length + ENVELOPE_SENDER_CLOSE.length + 1}), '"') = 0
                   AND ${markerAt(evPrompt, `${headerEnd} + 1`)}
                   AND instr(${evPrompt}, char(10) || '${CROSS_SESSION_CLOSE}') > ${headerEnd}))`;
}

export function hiveWorkerEnvelopeLikeSql(promptSql: string): string {
  return `(${promptSql} LIKE '${ENVELOPE_OPEN}%${ENVELOPE_SENDER_CLOSE}' || char(10) || '[hive:worker %] [message #%,%' || char(10) || '${CROSS_SESSION_CLOSE}%')`;
}

export function isHiveWorkerEnvelope(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const open = ENVELOPE_OPEN.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const senderClose = ENVELOPE_SENDER_CLOSE.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const close = CROSS_SESSION_CLOSE.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${open}[\\s\\S]*${senderClose}\\n\\[hive:worker [\\s\\S]*\\] \\[message #[\\s\\S]*,[\\s\\S]*\\n${close}`).test(p);
}

export function socketGraceDue(
  actorId: string,
  attemptAt: string | null,
  panePid: string,
  readTurn: () => { state: string; pane_pid: string } | null,
): boolean {
  const firstStop = (
    db
      .prepare("SELECT MIN(created_at) AS t FROM agent_state_log WHERE actor_id = ? AND event = 'stop' AND created_at >= ?")
      .get(actorId, attemptAt) as { t: string | null }
  ).t;
  let from = firstStop;
  if (from === null) {
    const turn = readTurn();
    if (turn !== null && turn.state === "working" && turn.pane_pid === panePid) return false;
    from = attemptAt;
  }
  return (
    db.prepare("SELECT (julianday('now') - julianday(?)) * 86400 >= ? AS due").get(from, SOCKET_CONFIRM_GRACE_SECONDS) as {
      due: number;
    }
  ).due === 1;
}

// True only for a completed local write. The socket sends no ack, so true never means the lead read it.
export function postClaudeWake(options: {
  socketPath: string;
  senderAddress: string;
  text: string;
  beforeWrite: () => boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) socket.end();
      else socket.destroy();
      resolve(ok);
    };
    const socket = createConnection(options.socketPath);
    const timer = setTimeout(() => finish(false), SOCKET_WRITE_BOUND_MS);
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      let allowed = false;
      try {
        allowed = options.beforeWrite();
      } catch {
        allowed = false;
      }
      if (!allowed) return finish(false);
      socket.write(claudeWakeFrame(options.senderAddress, options.text), (err) => finish(!err));
    });
  });
}
