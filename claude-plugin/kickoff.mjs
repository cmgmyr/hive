import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function reexecUnderPinnedInterpreter() {

  if (process.env.HIVE_KICKOFF_REEXEC) return;

  if (process.env.HIVE_AGENT_ID && process.env.HIVE_LEAD !== "1") return;
  if (!existsSync(join(process.cwd(), "hive.yml"))) return;

  const { checkAbi } = await import("../dist/abi.js");
  if (checkAbi().ok) return;

  const { dispatcherPath, readDispatcher } = await import("../dist/dispatcher.js");
  const dispatcher = readDispatcher(dispatcherPath());

  const node = dispatcher?.node ?? null;

  if (!node) return;

  if (node === process.execPath || !existsSync(node)) return;

  const result = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HIVE_KICKOFF_REEXEC: "1" },
  });

  if (result.error) return;
  process.exit(result.status ?? 1);
}

try {
  await reexecUnderPinnedInterpreter();
} catch {

}

const { runKickoff } = await import("../dist/kickoff.js");
await runKickoff(process.argv.slice(2));
