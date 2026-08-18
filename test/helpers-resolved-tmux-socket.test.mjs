import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolvedTmuxSocket, tmuxSocketUnder, withEnv } from "./helpers.mjs";

const sharedSocket = tmuxSocketUnder(realpathSync("/tmp"));
const uid = process.getuid?.() ?? 0;

describe("resolvedTmuxSocket() (todo 368 finding I)", () => {
  it("returns null for an UNREACHABLE TMUX_TMPDIR, not the shared socket", () => {
    withEnv({ TMUX: undefined, TMUX_TMPDIR: "/nonexistent/hive-368-finding-i" }, () => {
      assert.equal(resolvedTmuxSocket(), null);
    });
  });

  it("returns null for a REACHABLE TMUX_TMPDIR that resolves to the shared socket", () => {
    withEnv({ TMUX: undefined, TMUX_TMPDIR: "/tmp" }, () => {
      assert.equal(resolvedTmuxSocket(), null);
    });
  });

  it("does not trust an inherited TMUX that names the shared socket directly", () => {
    withEnv({ TMUX: `${sharedSocket},1,0`, TMUX_TMPDIR: undefined }, () => {
      assert.equal(
        resolvedTmuxSocket(),
        null,
        "an inherited TMUX naming the shared socket is exactly the 'already on the crew's server' case, not a trusted result",
      );
    });
  });

  it("does not trust an inherited TMUX reaching the shared socket through a symlinked base", () => {

    // The alias is built here rather than borrowing /tmp -> /private/tmp, which only exists on
    // darwin - and the darwin CI leg runs on schedule only, so a darwin-shaped fixture would never
    // discriminate on any push or PR.
    const dir = mkdtempSync(join(tmpdir(), "hive-tmux-alias-"));
    const alias = join(dir, "shared-by-another-name");
    symlinkSync(realpathSync("/tmp"), alias);
    try {
      withEnv({ TMUX: `${join(alias, `tmux-${uid}`, "default")},1,0`, TMUX_TMPDIR: undefined }, () => {
        assert.equal(
          resolvedTmuxSocket(),
          null,
          "tmuxSocketPath() canonicalises an inherited TMUX before comparing, and this must too, or a raw compare reads the shared server as private",
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still trusts an inherited TMUX naming a genuinely private socket", () => {
    withEnv({ TMUX: "/private/tmp/tmux-501/hivespike,12936,0", TMUX_TMPDIR: undefined }, () => {
      assert.equal(resolvedTmuxSocket(), "/private/tmp/tmux-501/hivespike");
    });
  });
});
