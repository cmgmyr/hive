import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "./db.js";
import { shellQuote } from "./tmux.js";

// Generates the settings file that agent_spawn passes to claude via
// --settings. The hooks report exact session state (working/idle/waiting)
// into the hive DB, replacing output-quiescence heuristics.
export function ensureHooksFile(): string {
  const hookScript = join(dirname(fileURLToPath(import.meta.url)), "hook.js");
  // Absolute process.execPath, not a bare `node`: a version manager resolves a
  // bare `node` from the working directory the hook fires in, which is the
  // worker's session, not this one. hooks.ts imports dataDir from ./db.js, so
  // guardAbi() has already passed in THIS process by the time this line runs;
  // this interpreter is proven able to load the addon, by construction, not
  // merely nominated the way a dispatcher pin would be (which can be stale,
  // absent, or since removed by a version manager). Quoted because this path
  // reaches a shell: Claude Code hooks run via `sh -c` whenever `args` is
  // omitted, and this dev machine's own process.execPath contains a space
  // (Herd's nvm path).
  //
  // The proof above rests on this file importing dataDir from ./db.js.
  // .claude/rules/store-and-datadir.md pushes toward reading the data dir at
  // call time through the deliberately store-free dataDir.ts instead; if this
  // file ever stops importing db.js, the guarantee behind process.execPath has
  // to be re-established, not assumed to still hold.
  //
  // A re-exec guard like kickoff.mjs's was considered and rejected here, but
  // not because it covers nothing: hooks.json is rewritten on every spawn, so
  // every worker spawned after this fix lands gets the correct interpreter,
  // but a worker already RUNNING when the fix lands loaded its hook command at
  // its own claude process's start and keeps the pre-fix bare `node` until
  // that worker itself is respawned. A re-exec guard would have covered that
  // worker too; this fix does not, and that is the one case where (a) is
  // strictly better. Restarting the LEAD does not close the gap either:
  // workers keep running across a lead restart by design (see README, "hive
  // workers keep running when the lead detaches, restarts, or crashes"), and
  // cmdLead only ever touches the lead's own window. What actually closes it
  // is the same as any other dispatcher or hive.yml change that only takes
  // effect for a freshly spawned process: respawn that worker. kickoff.mjs
  // carries its guard because claude-plugin/hooks.json is tracked in git and
  // can never carry an absolute path at all, which is a permanent constraint;
  // this file's gap is a one-time transition cost at this fix's rollout, not a
  // standing one, which is why (b) alone was still worth taking here.
  //
  // This process's own interpreter could in principle be gone from disk by
  // the time a worker actually runs the command (a version manager pruning an
  // old install between this write and that read), so check rather than
  // writing a path that would silently start nothing.
  if (!existsSync(process.execPath)) {
    throw new Error(
      `hive: this process's own interpreter (${process.execPath}) no longer exists on disk; refusing to register worker-state hooks under a path that would start nothing.`,
    );
  }
  const node = shellQuote(process.execPath);
  const cmd = (event: string) => ({
    hooks: [{ type: "command", command: `${node} ${shellQuote(hookScript)} ${event}` }],
  });
  const settings = {
    hooks: {
      Stop: [cmd("stop")],
      UserPromptSubmit: [cmd("prompt")],
      Notification: [cmd("notify")],
    },
  };
  const path = join(dataDir, "hooks.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return path;
}
