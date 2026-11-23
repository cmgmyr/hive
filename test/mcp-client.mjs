import { spawn } from "node:child_process";

export class JsonRpcClient {
  constructor(command, args, { cwd, env = {}, timeoutMs = 15000, closeTimeoutMs = 3000, clientInfo, stderr = "inherit" }) {
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", stderr],
    });
    this.timeoutMs = timeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.clientInfo = clientInfo ?? { name: "hive-test", version: "0" };
    this.nextId = 1;
    this.pending = new Map();

    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const resolve = this.pending.get(msg.id);
        if (resolve) {
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  send(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} (id ${id})`));
      }, this.timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method = "notifications/initialized", params) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.notify();
  }

  async call(name, args = {}) {
    const msg = await this.request("tools/call", { name, arguments: args });
    if (msg.error) throw new Error(msg.error.message);
    const text = msg.result?.content?.[0]?.text ?? "";
    if (msg.result?.isError) throw new Error(text);
    return text ? JSON.parse(text) : null;
  }

  async close() {
    this.child.stdin.end();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const timeout = new Promise((resolve) => setTimeout(resolve, this.closeTimeoutMs).unref());
    await Promise.race([exited, timeout]);
    if (this.child.exitCode == null) this.child.kill("SIGKILL");
  }
}

export function startMcpClient(command, args, options) {
  return new JsonRpcClient(command, args, options);
}
