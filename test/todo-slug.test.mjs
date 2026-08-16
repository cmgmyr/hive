import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the todo_slug tests");
after(() => cleanupTmux());

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

    await mcp.call("todo_update", { todo_id, slug: "renamed slug" });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, "renamed slug");
  });

  it("a todo with no slug falls back to a deterministic truncation of its title, not a blank field", async () => {
    const longTitle =
      "hive doctor should report PTY headroom because a fork failure cost a whole morning and named nothing useful";
    const { todo_id } = await mcp.call("todo_create", { title: longTitle });

    const first = await mcp.call("todo_get", { todo_id });
    assert.notEqual(first.slug, "");
    assert.ok(first.slug.length <= 40, "the fallback must respect the same bound a provided slug does");
    assert.ok(longTitle.startsWith(first.slug.replace(/…$/, "")), "the fallback must be a prefix of the title");

    const second = (await mcp.call("todo_list", { query: "PTY headroom" })).todos.find(
      (t) => t.todo_id === todo_id,
    );
    assert.equal(second.slug, first.slug);
  });

  it("a short title needs no truncation and comes back unchanged, with no ellipsis", async () => {

    const shortTitle = "short one";
    const { todo_id } = await mcp.call("todo_create", { title: shortTitle });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, shortTitle);
  });

  it("the fallback truncation never splits an astral character into a lone surrogate, and round-trips", async () => {

    const longTitle = `${"e".repeat(37)}\u{1F600} rest of title after the emoji`;
    const { todo_id } = await mcp.call("todo_create", { title: longTitle });
    const detail = await mcp.call("todo_get", { todo_id });

    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.ok(
      !LONE_SURROGATE.test(detail.slug),
      `slug must not contain a lone surrogate half: ${JSON.stringify(detail.slug)}`,
    );

    assert.ok(detail.slug.includes("\u{1F600}"), `slug must keep the emoji intact: ${JSON.stringify(detail.slug)}`);

    await assert.doesNotReject(() => mcp.call("todo_update", { todo_id, slug: detail.slug }));
  });

  it("the fallback's own output round-trips through slugParam's own bound, on an unbroken title", async () => {

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

    const { todo_id } = await mcp.call("todo_create", { title: "\r\n\t   " });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.equal(detail.slug, `todo ${todo_id}`);
  });

  it("todo_list's query matches an explicitly-set slug, not only title or body", async () => {

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

    const title = "clear test distinguishing title";
    const { todo_id } = await mcp.call("todo_create", { title, slug: "typo'd label" });
    await mcp.call("todo_update", { todo_id, slug: "" });
    const detail = await mcp.call("todo_get", { todo_id });
    assert.notEqual(detail.slug, "typo'd label");
    assert.notEqual(detail.slug, "");
    assert.equal(detail.slug, title, "a cleared slug must read as the same fallback fallbackSlug(title) computes");
  });

  it("refuses a slug over the length bound", async () => {

    const tooLong = "a".repeat(41);
    await assert.rejects(
      () => mcp.call("todo_create", { title: "x", slug: tooLong }),
      /too_big|40/i,
    );
  });

  it("refuses a slug containing a control character", async () => {

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
