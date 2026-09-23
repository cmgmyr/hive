import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import { DIST, isolateTmux, McpClient, runFixture, scratchDirs, until } from "./helpers.mjs";

const { cleanup } = isolateTmux("the scheduler interval knob tests");
after(() => cleanup());

describe("schedulerIntervalMs() reads HIVE_SCHEDULER_INTERVAL_MS", () => {
  it("returns the value when valid, and 3000 for garbage or anything under 100ms", () => {
    const { dataDir, tmp } = scratchDirs();
    const inputs = ["", "500", "100", "99", "0", "-500", "abc", "250.5", "Infinity", "NaN", " ", "1e400"];
    const out = runFixture(
      tmp,
      "interval-parse",
      `const { schedulerIntervalMs, DEFAULT_SCHEDULER_INTERVAL_MS } = await import(${JSON.stringify(join(DIST, "scheduler.js"))});\n` +
        `const inputs = ${JSON.stringify(inputs)};\n` +
        `const fromArg = inputs.map((raw) => schedulerIntervalMs(raw));\n` +
        `const fromEnv = schedulerIntervalMs();\n` +
        `process.stdout.write(JSON.stringify({ fromArg, fromEnv, fallback: DEFAULT_SCHEDULER_INTERVAL_MS }));`,
      { HIVE_DATA_DIR: dataDir, HIVE_SCHEDULER_INTERVAL_MS: "750" },
    );
    assert.equal(out.fallback, 3000, "the default tick is still three seconds");
    assert.deepEqual(out.fromArg, [3000, 500, 100, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000]);
    assert.equal(out.fromEnv, 750, "with no argument it reads the environment at call time");
  });
});

describe("the MCP server starts its scheduler at the configured interval", () => {
  const intervalsFrom = async (env) => {
    const dirs = scratchDirs();
    const log = join(dirs.tmp, "intervals.log");
    const preload = join(dirs.tmp, "record-intervals.mjs");
    writeFileSync(
      preload,
      `import { appendFileSync } from "node:fs";\n` +
        `const real = globalThis.setInterval;\n` +
        `globalThis.setInterval = (fn, ms, ...rest) => { appendFileSync(${JSON.stringify(log)}, ms + "\\n"); return real(fn, ms, ...rest); };\n`,
    );
    const mcp = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ...env },
    });
    try {
      await mcp.start();
      assert.ok((await mcp.call("whoami")).actor_id, "the server must really be serving");
      await until(() => existsSync(log), 3000);
    } finally {
      await mcp.close();
    }
    return readFileSync(log, "utf8").trim().split("\n").map(Number);
  };

  it("uses 3000ms when the knob is unset", async () => {
    const intervals = await intervalsFrom({});
    assert.ok(intervals.includes(3000), `a 3000ms interval must be created: ${intervals}`);
  });

  it("uses the knob's value when it is set, and not the default", async () => {
    const intervals = await intervalsFrom({ HIVE_SCHEDULER_INTERVAL_MS: "437" });
    assert.ok(intervals.includes(437), `a 437ms interval must be created: ${intervals}`);
    assert.ok(!intervals.includes(3000), `and no 3000ms one: ${intervals}`);
  });

  it("falls back to 3000ms and keeps serving on a value under the floor", async () => {
    const intervals = await intervalsFrom({ HIVE_SCHEDULER_INTERVAL_MS: "5" });
    assert.ok(intervals.includes(3000), `a too-small value must fall back to 3000ms: ${intervals}`);
    assert.ok(!intervals.includes(5), `and never create a 5ms tick: ${intervals}`);
  });
});
