import { spawn } from "node:child_process";
import { isTrusted } from "./leadLaunch.js";
import { loadProjectYml } from "./projectYml.js";

const GATE_NAME = "hive:todo-completion-gate";
const TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_BYTES = 4096;
const GATE_APPROVAL_MESSAGE =
  "completion gate in hive.yml is not approved yet; run `hive` in a terminal in this project to review it.";

export interface TodoCompletionGateInput {
  projectId: number;
  projectPath: string;
  todoId: number;
  title: string;
  actorId: string;
  argv: readonly string[];
}

export function completionGateTrust(argv: readonly string[]) {
  return {
    name: GATE_NAME,
    command: JSON.stringify(argv),
    dir: null,
    env: {},
  } as const;
}

export function todoCompletionGateTrusted(projectId: number, argv: readonly string[]): boolean {
  const trust = completionGateTrust(argv);
  return isTrusted(projectId, trust.name, trust.command, trust.dir, trust.env);
}

export function assertValidTodoCompletionGate(
  input: TodoCompletionGateInput,
  message: string | undefined,
): void {
  if (message) throw failure("invalid", input, null, null, Buffer.alloc(0), Buffer.alloc(0), message);
}

export function assertTodoCompletionGateCurrent(
  input: TodoCompletionGateInput,
  originalArgv: readonly string[],
): void {
  const current = loadProjectYml(input.projectPath);
  if (current.completionGateError || !current.config?.completion_gate) {
    throw failure("changed", input, null, null, Buffer.alloc(0), Buffer.alloc(0));
  }
  if (JSON.stringify(current.config.completion_gate) !== JSON.stringify(originalArgv)) {
    throw failure("changed", input, null, null, Buffer.alloc(0), Buffer.alloc(0), GATE_APPROVAL_MESSAGE);
  }
  if (!todoCompletionGateTrusted(input.projectId, originalArgv)) {
    throw failure("untrusted", input, null, null, Buffer.alloc(0), Buffer.alloc(0));
  }
}

function failure(
  reason: string,
  input: TodoCompletionGateInput,
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: Buffer,
  stderr: Buffer,
  detail?: string,
): Error {
  const output = [
    stdout.length ? `stdout tail:\n${stdout.toString("utf8")}` : "",
    stderr.length ? `stderr tail:\n${stderr.toString("utf8")}` : "",
  ].filter(Boolean).join("\n");
  return new Error(
    `[todo_completion_gate:${reason}] todo ${input.todoId}; exit ${code ?? "unavailable"}` +
      `${signal ? `; signal ${signal}` : ""}${output ? `\n${output}` : ""}` +
      (detail ? `\n${detail}` : "") +
      (reason === "untrusted"
        ? `\n${GATE_APPROVAL_MESSAGE}`
        : ""),
  );
}

export async function runTodoCompletionGate(input: TodoCompletionGateInput): Promise<void> {
  if (!todoCompletionGateTrusted(input.projectId, input.argv)) {
    throw failure("untrusted", input, null, null, Buffer.alloc(0), Buffer.alloc(0));
  }

  const [file, ...args] = input.argv;
  await new Promise<void>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const child = spawn(file!, args, {
      cwd: input.projectPath,
      env: {
        ...process.env,
        HIVE_TODO_ID: String(input.todoId),
        HIVE_TODO_TITLE: input.title,
        HIVE_PROJECT_ID: String(input.projectId),
        HIVE_ACTOR_ID: input.actorId,
      },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const appendTail = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      chunks.push(chunk);
      let total = current + chunk.length;
      while (total > OUTPUT_TAIL_BYTES && chunks.length) {
        const excess = total - OUTPUT_TAIL_BYTES;
        if (chunks[0].length <= excess) {
          total -= chunks.shift()!.length;
        } else {
          chunks[0] = chunks[0].subarray(excess);
          total -= excess;
        }
      }
      return total;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = appendTail(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = appendTail(stderr, chunk, stderrBytes); });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      } else child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      finish(failure("timeout", input, null, null, Buffer.concat(stdout), Buffer.concat(stderr)));
    }, TIMEOUT_MS);
    child.once("error", () => finish(failure("spawn", input, null, null, Buffer.concat(stdout), Buffer.concat(stderr))));
    child.once("close", (code, signal) => {
      if (timedOut) return;
      if (code === 0) finish();
      else finish(failure(signal ? "signal" : "failed", input, code, signal, Buffer.concat(stdout), Buffer.concat(stderr)));
    });
  });
}
