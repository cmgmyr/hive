import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { scratchDirs } from "./helpers.mjs";

process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
const { attachMode, resolvedAutoAttach, setAttachMode, setAutoAttach } = await import("../dist/config.js");

const withAutoAttach = (value, fn) => {
  const saved = process.env.HIVE_AUTO_ATTACH;
  if (value === undefined) delete process.env.HIVE_AUTO_ATTACH;
  else process.env.HIVE_AUTO_ATTACH = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HIVE_AUTO_ATTACH;
    else process.env.HIVE_AUTO_ATTACH = saved;
  }
};

describe("auto-attach config", () => {
  it("resolves env over config over the default, including legacy 0", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    withAutoAttach(undefined, () =>
      assert.deepEqual(resolvedAutoAttach(), { value: "auto", source: "detection" }),
    );
    setAutoAttach("on");
    withAutoAttach(undefined, () =>
      assert.deepEqual(resolvedAutoAttach(), { value: "on", source: "config" }),
    );
    withAutoAttach("off", () =>
      assert.deepEqual(resolvedAutoAttach(), { value: "off", source: "env" }),
    );
    withAutoAttach("0", () =>
      assert.deepEqual(resolvedAutoAttach(), { value: "off", source: "env" }),
    );
  });

  it("treats unknown env and config values as absent", () => {
    const dir = scratchDirs().dataDir;
    process.env.HIVE_DATA_DIR = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ autoAttach: "sometimes" }));
    withAutoAttach("also-invalid", () =>
      assert.deepEqual(resolvedAutoAttach(), { value: "auto", source: "detection" }),
    );
  });

  it("preserves attach and unrelated keys when written", () => {
    const dir = scratchDirs().dataDir;
    process.env.HIVE_DATA_DIR = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ attach: "raw", future: "kept" }));
    setAutoAttach("off");
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.deepEqual(config, { attach: "raw", future: "kept", autoAttach: "off" });
  });
});

describe("attach mode config", () => {
  it("defaults to auto when no config file exists", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    assert.equal(attachMode(), "auto");
  });

  it("defaults to auto on malformed JSON", () => {
    const dir = scratchDirs().dataDir;
    process.env.HIVE_DATA_DIR = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");
    assert.equal(attachMode(), "auto");
  });

  it("round-trips a written value", () => {
    process.env.HIVE_DATA_DIR = scratchDirs().dataDir;
    setAttachMode("raw");
    assert.equal(attachMode(), "raw");
    setAttachMode("control");
    assert.equal(attachMode(), "control");
  });

  it("preserves an unrelated key across a write", () => {
    const dir = scratchDirs().dataDir;
    process.env.HIVE_DATA_DIR = dir;
    setAttachMode("raw");
    const path = join(dir, "config.json");
    const before = JSON.parse(readFileSync(path, "utf8"));
    before.future = "kept";
    writeFileSync(path, JSON.stringify(before));

    setAttachMode("control");

    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.attach, "control");
    assert.equal(after.future, "kept");
  });

  it("falls back to auto on an unknown value", () => {
    const dir = scratchDirs().dataDir;
    process.env.HIVE_DATA_DIR = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ attach: "invisible" }));
    assert.equal(attachMode(), "auto");
  });

  it("lets storeDir()'s own refusal propagate rather than reading as an absent file", () => {

    const savedDataDir = process.env.HIVE_DATA_DIR;
    const savedAttachMode = process.env.HIVE_ATTACH_MODE;
    delete process.env.HIVE_DATA_DIR;
    delete process.env.HIVE_ATTACH_MODE;
    try {
      assert.throws(() => attachMode(), /refused to use its real store/);
    } finally {
      process.env.HIVE_DATA_DIR = savedDataDir;
      if (savedAttachMode === undefined) delete process.env.HIVE_ATTACH_MODE;
      else process.env.HIVE_ATTACH_MODE = savedAttachMode;
    }
  });
});
