import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { describe, it } from "node:test";

import { resolvedTmuxSocket, tmuxSocketUnder, withEnv } from "./helpers.mjs";

const sharedSocket = tmuxSocketUnder(realpathSync("/tmp"));

describe("resolvedTmuxSocket() (todo 368 finding I)", () => {
  it("returns null for a reachable TMUX_TMPDIR, not the shared socket", () => {
    withEnv({ TMUX: undefined, TMUX_TMPDIR: "/nonexistent/hive-368-finding-i" }, () => {
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

  it("still trusts an inherited TMUX naming a genuinely private socket", () => {
    withEnv({ TMUX: "/private/tmp/tmux-501/hivespike,12936,0", TMUX_TMPDIR: undefined }, () => {
      assert.equal(resolvedTmuxSocket(), "/private/tmp/tmux-501/hivespike");
    });
  });
});
