import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

// This file only calls todo_create/todo_get/todo_list/todo_update, but
// McpClient starts the same MCP server every tool runs on, including
// agent_spawn, so it can reach tmux and test/CLAUDE.md requires isolation
// unconditionally (test/suite-isolation.test.mjs enforces this by reading
// the file, not by observing whether a given file happens to use it).
const { cleanup: cleanupTmux } = isolateTmux("the todo_slug tests");
after(() => cleanupTmux());

// Same class fallbackSlug/slugParam guard against - every C0 control byte
// and DEL - checked locally rather than imported, since this file exercises
// behaviour through the real MCP tools, not by importing src/tmux.js.
const findControlChar = (s) => /[\x00-\x1F\x7F]/.test(s);

const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("todo slug (todo 318)", () => {
  it("todo_create stores a provided slug, and todo_get/todo_list both surface it", async () => {
    // Mutation this dies against: drop `slug` from the INSERT column list in
    // todo_create's handler (src/tools/todos.ts). Without it, the row's slug
    // stays '' and summarize() falls back to a truncation of the title,
    // which reads nothing like "pane steal" - so this assertion would fail
    // rather than silently pass.
    const { todo_id } = await mcp.call("todo_create", {
      title: "the focus-stealing bug from spawning a worker",
      slug: "pane steal",
    });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, "pane steal");

    const list = await mcp.call("todo_list", {});
    const row = list.todos.find((t) => t.todo_id === todo_id);
    assert.ok(row, "the created todo must appear in todo_list");
    assert.equal(row.slug, "pane steal");
  });

  it("todo_update changes the slug on an existing todo", async () => {
    const { todo_id } = await mcp.call("todo_create", {
      title: "needs a better label later",
      slug: "first guess",
    });
    // Mutation this dies against: drop `slug: patch.slug ?? null` from
    // updateTodo's UPDATE statement bindings. Without it the COALESCE always
    // receives NULL and the column never moves off "first guess", so this
    // assertion would still read the old value.
    await mcp.call("todo_update", { todo_id, slug: "renamed slug" });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, "renamed slug");
  });

  it("a todo with no slug falls back to a deterministic truncation of its title, not a blank field", async () => {
    const longTitle =
      "hive doctor should report PTY headroom because a fork failure cost a whole morning and named nothing useful";
    const { todo_id } = await mcp.call("todo_create", { title: longTitle });

    // Mutation this dies against: summarize() returning row.slug directly
    // (i.e. '' for a slug-less row) instead of `row.slug || fallbackSlug(...)`.
    // A blank slug would fail every assertion below, including the
    // non-empty check.
    const first = await mcp.call("todo_get", { todo_id });
    assert.notEqual(first.slug, "");
    assert.ok(first.slug.length <= 40, "the fallback must respect the same bound a provided slug does");
    assert.ok(longTitle.startsWith(first.slug.replace(/…$/, "")), "the fallback must be a prefix of the title");

    // Consistency is the entire point of this field (todo 318, comment 699):
    // read it again through the other surface and require byte-identical
    // output, proving this is a deterministic computation and not a fresh
    // judgement call made per read.
    const second = (await mcp.call("todo_list", { query: "PTY headroom" })).todos.find(
      (t) => t.todo_id === todo_id,
    );
    assert.equal(second.slug, first.slug);
  });

  it("a short title needs no truncation and comes back unchanged, with no ellipsis", async () => {
    // test/CLAUDE.md shape 6: a fixture that never exceeds the bound cannot
    // test the bound. This case and the long-title case above must both
    // exist, or only one branch of fallbackSlug's length check is exercised.
    const shortTitle = "short one";
    const { todo_id } = await mcp.call("todo_create", { title: shortTitle });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, shortTitle);
  });

  it("the fallback truncation never splits an astral character into a lone surrogate, and round-trips", async () => {
    // Mutation this dies against: restore the naive `trimmed.slice(0,
    // SLUG_MAX_LEN)` in fallbackSlug (src/tools/todos.ts) in place of the
    // code-point-safe walk. 37 filler chars leave exactly enough of
    // CUT_BUDGET (39, SLUG_MAX_LEN minus the reserved ellipsis unit) for
    // the emoji's own 2 UTF-16 units to fit whole (37 + 2 = 39) - reproduced
    // directly against the real fallbackSlug before this fix (see todo
    // 318's own record): a code-unit slice at a fixed position split the
    // pair and left an unpaired surrogate half, not valid UTF-16, and not a
    // "usable label" by the lane's own standard - it rides into wake
    // bodies, board entries and receipts.
    const longTitle = `${"e".repeat(37)}\u{1F600} rest of title after the emoji`;
    const { todo_id } = await mcp.call("todo_create", { title: longTitle });
    const detail = await mcp.call("todo_get", { todo_id });

    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.ok(
      !LONE_SURROGATE.test(detail.slug),
      `slug must not contain a lone surrogate half: ${JSON.stringify(detail.slug)}`,
    );
    // The emoji itself must survive whole, not merely "no crash": the cut
    // must land AFTER the full character, not drop it to dodge the split.
    assert.ok(detail.slug.includes("\u{1F600}"), `slug must keep the emoji intact: ${JSON.stringify(detail.slug)}`);

    // Counselors' own concrete failure: a slug read back from todo_get must
    // be acceptable input to the tool that would have produced it.
    await assert.doesNotReject(() => mcp.call("todo_update", { todo_id, slug: detail.slug }));
  });

  it("the fallback's own output round-trips through slugParam's own bound, on an unbroken title", async () => {
    // test/CLAUDE.md shape 6, corrected per counselors: the PTY-headroom
    // fixture above word-wraps well under 40 chars, so a naive
    // `slug.length <= 40` assertion against it can never fail regardless of
    // whether the reserved-ellipsis-unit math is right. An UNBROKEN title
    // forces the "no space in budget" branch, which is the one that
    // actually uses the full CUT_BUDGET.
    //
    // Mutation this dies against: CUT_BUDGET = SLUG_MAX_LEN instead of
    // SLUG_MAX_LEN - 1 (src/tools/todos.ts) - i.e. not reserving a unit for
    // the appended ellipsis. Measured against the real function before this
    // fix: a 41-char unbroken title truncated to 40 chars + "…" = 41 UTF-16
    // units, one over slugParam's own z.string().max(40), so todo_update
    // rejected the exact value todo_get had just returned - the receipt did
    // not round-trip through its own writer.
    const unbrokenTitle = "c".repeat(41);
    const { todo_id } = await mcp.call("todo_create", { title: unbrokenTitle });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.ok(detail.slug.length <= 40, `fallback slug must respect slugParam's own bound: ${detail.slug.length}`);
    await assert.doesNotReject(
      () => mcp.call("todo_update", { todo_id, slug: detail.slug }),
      "a slug read from todo_get must be accepted by the tool that produced it",
    );
  });

  it("the fallback strips a control character from the title instead of carrying it into the slug", async () => {
    // Mutation this dies against: drop the stripControlChars() call from
    // fallbackSlug (src/tools/todos.ts), i.e. `title.trim()` instead of
    // `stripControlChars(title).trim()`. `title` carries no control-char
    // guard (an existing, unconstrained parameter this lane does not
    // widen), so this is the path that serves ~300 pre-existing rows and
    // every title-only todo_create - and both posture files this lane
    // wrote tell a lead to carry a slug into a wake body, delivered
    // VERBATIM into a pane, where a bare CR submits the line early.
    const title = "restart\rthe worker pane";
    const { todo_id } = await mcp.call("todo_create", { title });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.ok(
      !findControlChar(detail.slug),
      `fallback slug must not carry a raw control character: ${JSON.stringify(detail.slug)}`,
    );
    assert.equal(detail.slug, "restart the worker pane");
  });

  it("a title that is entirely whitespace/control characters still yields a non-blank slug", async () => {
    // Mutation this dies against: drop `|| \`todo ${row.id}\`` from
    // summarize() (src/tools/todos.ts). Without it this todo's slug reads
    // as '' - the exact blank-field failure this field exists to prevent,
    // now unreachable through fallbackSlug alone once control characters
    // are stripped (the fix above), since a title that is ONLY control
    // characters/whitespace trims to "" the same way an all-whitespace one
    // already did.
    const { todo_id } = await mcp.call("todo_create", { title: "\r\n\t   " });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, `todo ${todo_id}`);
  });

  it("todo_list's query matches an explicitly-set slug, not only title or body", async () => {
    // Mutation this dies against: drop `OR t.slug LIKE ?` from
    // listTodoSummaries's query clause (src/tools/todos.ts). The slug's
    // whole purpose is letting a lead find a todo by the name people
    // actually use for it; title/body here deliberately share no substring
    // with the query term, so a title/body-only match returns nothing.
    const marker = "zzqueryslugmarker";
    const { todo_id } = await mcp.call("todo_create", {
      title: "an unrelated title with no shared words",
      body: "an unrelated body",
      slug: marker,
    });
    const results = await mcp.call("todo_list", { query: marker });
    assert.ok(
      results.todos.some((t) => t.todo_id === todo_id),
      "a todo must be findable by its own slug through todo_list's query filter",
    );
  });

  it("passing an empty string clears a slug back to the computed fallback", async () => {
    // Mutation this dies against: restore `.min(1)` on slugParam
    // (src/tools/todos.ts). Before this fix there was no way to reset a
    // typo'd slug: COALESCE(?, slug) only skips the column on NULL/omitted,
    // and min(1) refused "" as a value, so a bad slug was permanent.
    // Short and under SLUG_MAX_LEN on purpose, so fallbackSlug returns it
    // verbatim and the assertion below isn't also computing a truncation.
    const title = "clear test distinguishing title";
    const { todo_id } = await mcp.call("todo_create", { title, slug: "typo'd label" });
    await mcp.call("todo_update", { todo_id, slug: "" });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.notEqual(detail.slug, "typo'd label");
    assert.notEqual(detail.slug, "");
    assert.equal(detail.slug, title, "a cleared slug must read as the same fallback fallbackSlug(title) computes");
  });

  it("refuses a slug over the length bound", async () => {
    // Mutation this dies against: remove .max(SLUG_MAX_LEN) from slugParam
    // (src/tools/todos.ts). Without it this call would succeed instead of
    // throwing, and the assertion below would never run its catch branch.
    const tooLong = "a".repeat(41);
    await assert.rejects(
      () => mcp.call("todo_create", { title: "x", slug: tooLong }),
      /too_big|40/i,
    );
  });

  it("refuses a slug containing a control character", async () => {
    // Mutation this dies against: remove the findUnsafeControlChar .refine()
    // from slugParam (src/tools/todos.ts). Without it neither call below
    // would throw. Two cases, not one: a newline would corrupt a
    // single-line rendering (a board line, a wake body); a raw control byte
    // like 0x03 is the same hazard normalizeAgentName guards a worker name
    // against, since a slug reaches a pane through a wake body too.
    await assert.rejects(
      () => mcp.call("todo_create", { title: "x", slug: "line one\nline two" }),
      /control character/i,
    );
    await assert.rejects(
      () => mcp.call("todo_create", { title: "x", slug: "bell\x07ringer" }),
      /control character/i,
    );
  });
});
