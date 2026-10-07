import { createConnection } from "node:net";

export const CROSS_SESSION_CLOSE = "</cross-session-message>";
export const SOCKET_WAKE_FOOTER = "Automated hive wake. Do not reply to this sender.";
const SOCKET_WRITE_BOUND_MS = 1000;

export function senderAddress(socketPath: string): string {
  const encoded = socketPath.replace(/[^A-Za-z0-9/._-]/gu, (c) =>
    [...Buffer.from(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
  return `uds:${encoded}`;
}

export function claudeWakeFrame(senderAddress: string, text: string): string {
  const content = `<cross-session-message from="${senderAddress}" from-name="hive">\n${text}\n${CROSS_SESSION_CLOSE}`;
  return JSON.stringify({ type: "user", from: senderAddress, message: { role: "user", content } }) + "\n";
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
