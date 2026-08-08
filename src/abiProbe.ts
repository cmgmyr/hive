// A child-process entry point, not a library. `hive doctor` spawns this under
// the `node` that a given project directory resolves, and reads one line of
// JSON back off stdout (src/sessionProbe.ts, todo 306).
//
// It exists as its own file because the question is about ANOTHER
// INTERPRETER. checkAbi() reads `process.versions` and dlopens the addon into
// the process calling it, so it can only ever answer for the process it runs
// in. Asking it about the Node a different directory resolves means running it
// there, in a child.
//
// TWO PROPERTIES ARE LOAD-BEARING, and both are inherited rather than restated
// here, so keep them true of anything this file imports.
//
// It must not open the store. abi.js and dispatcher.js are deliberately
// store-free (see their headers) - the same property claude-plugin/kickoff.mjs
// depends on for its own pre-store ABI check. An import that reaches db.js
// would make this probe run guardAbi() and exit(1) instead of reporting.
//
// It must not require the addon on an interpreter that cannot load it.
// checkAbi() compares Node-API levels BEFORE it requires anything, because
// below better-sqlite3's floor the require does not throw - it kills the
// process inside dlopen with no output at all. That ordering is what makes it
// safe to run this under an arbitrary, unknown interpreter, which is the whole
// job here. See src/abi.ts's header and .claude/rules/native-addon.md.
import { checkAbi, describeAbi } from "./abi.js";

const status = checkAbi();
// process.execPath, never a version string: an interpreter measurement is
// reported by absolute path, because "under 24.18.1" is a label and this
// project has already paid for the difference once
// (.claude/sessions/dead-ends/2026-08-06-two-variable-interpreter-measurement.md).
// The version rides along for a human reading doctor's output; the path is the
// fact.
process.stdout.write(
  `${JSON.stringify({
    execPath: process.execPath,
    version: process.version,
    ok: status.ok,
    failure: status.failure,
    detail: describeAbi(status),
  })}\n`,
);
