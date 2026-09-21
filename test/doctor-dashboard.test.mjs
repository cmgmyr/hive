import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { cleanup } = isolateTmux("doctor dashboard path");
after(() => cleanup());

describe("hive doctor dashboard path", () => {
  it("reports a leftover old dashboard once and stays quiet when it is absent", async () => {
    const dirs = scratchDirs();
    const cli = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
    const init = await runCli(["init", "--no-profile"], cli);
    assert.equal(init.code, 0, init.stderr);
    const clean = await runCli(["doctor"], cli);
    assert.doesNotMatch(clean.stdout, /older hive wrote/);

    const oldDir = join(dirs.projectDir, ".claude", "dashboard");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "index.html"), "<html>old</html>");
    const stale = await runCli(["doctor"], cli);
    assert.match(stale.stdout, /info {2}dashboard: an older hive wrote \.claude\/dashboard\/index\.html; hive now writes \.hive\/dashboard\.html\. Delete the old file and directory\./);
  });
});
