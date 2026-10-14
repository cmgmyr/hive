import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseRulePaths } from "../scripts/covering-rules.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const readRepo = (file) => readFileSync(join(REPO, file), "utf8");

const DOC_GLOBS = [".claude/rules/*.md", ".agents/skills/hive-internals/references/*.md"];
const docFiles = () => DOC_GLOBS.flatMap((g) => globSync(g, { cwd: REPO }).sort());

const stripFences = (text) => text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));

const SPAN_RE = /`([^`\n]+)`/g;
const PATH_SPAN_RE = /^(?:\.claude|\.agents|src|test|scripts|docs|claude-plugin)\/[\w.*/-]+$/;
const LINE_CITATION_RE = /^(?:[\w./-]+\.(?:ts|mjs|js|sh|md|json))?(?::L?\d[\d,-]*|#L\d+(?:-L?\d+)?)$/;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const SYM_RUN_RE = new RegExp(
  String.raw`((?:\x60${IDENT}(?:\(\))?\x60(?:\/|, | and | or )?)+) \(\x60([^\x60\n]+)\x60\)`,
  "g",
);
const IN_PATH_RE = new RegExp(
  String.raw`((?:\x60${IDENT}(?:\(\))?\x60(?:\/|, | and | or )?)+) in \x60([^\x60\n]+)\x60`,
  "g",
);
const POSSESSIVE_RE = new RegExp(String.raw`\x60([^\x60\n]+)\x60's \x60(${IDENT})(?:\(\))?\x60`, "g");

// Names the rules cite as calls that live outside hive's own source tree.
const EXTERNAL_CALLS = new Set([
  "execFileSync", "spawnSync", "readFileSync", "writeFileSync", "realpath", "lstat", "setTimeout",
  "require", "import", "fetch", "kill", "availableParallelism", "login_tty",
]);

const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1").replace(/^\s*#(?!!).*$/, ""))
    .join("\n");

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasSymbol = (content, symbol) => new RegExp(`(?<![\\w$])${escapeRe(symbol)}(?![\\w$])`).test(content);

const sourceCorpus = (() => {
  const files = ["src/**/*.ts", "scripts/**/*", "claude-plugin/**/*.mjs", "test/helpers.mjs"].flatMap((g) =>
    globSync(g, { cwd: REPO }),
  );
  return files
    .filter((f) => existsSync(join(REPO, f)))
    .map((f) => {
      try {
        return stripComments(readRepo(f));
      } catch {
        return "";
      }
    })
    .join("\n");
})();

function pathExists(spec) {
  if (spec.includes("*")) return globSync(spec, { cwd: REPO }).length > 0;
  return existsSync(join(REPO, spec));
}

function spansOf(text) {
  return [...stripFences(text).matchAll(SPAN_RE)].map((m) => m[1]);
}

function lineCitations(text) {
  return spansOf(text).filter((s) => LINE_CITATION_RE.test(s)).map((s) => `line citation \`${s}\``);
}

function missingPaths(text) {
  return spansOf(text)
    .filter((s) => PATH_SPAN_RE.test(s) && !pathExists(s))
    .map((s) => `path \`${s}\` does not exist`);
}

function missingSymbols(text) {
  const prose = stripFences(text);
  const failures = [];
  const claim = (symbols, path) => {
    if (!PATH_SPAN_RE.test(path) || path.includes("*") || !existsSync(join(REPO, path))) return;
    if (!/\.(?:ts|mjs|js|sh)$/.test(path)) return;
    const content = stripComments(readRepo(path));
    for (const symbol of symbols) {
      if (!hasSymbol(content, symbol)) failures.push(`symbol \`${symbol}\` is not in ${path}`);
    }
  };
  for (const m of prose.matchAll(SYM_RUN_RE)) {
    const symbols = [...m[1].matchAll(new RegExp(String.raw`\x60(${IDENT})(?:\(\))?\x60`, "g"))].map((s) => s[1]);
    claim(symbols, m[2]);
  }
  for (const m of prose.matchAll(IN_PATH_RE)) {
    const symbols = [...m[1].matchAll(new RegExp(String.raw`\x60(${IDENT})(?:\(\))?\x60`, "g"))].map((s) => s[1]);
    claim(symbols, m[2]);
  }
  for (const m of prose.matchAll(POSSESSIVE_RE)) claim([m[2]], m[1]);
  return failures;
}

function missingCalls(text) {
  return [...new Set(spansOf(text))]
    .map((s) => new RegExp(`^(${IDENT})\\(\\)$`).exec(s)?.[1])
    .filter((name) => name && !EXTERNAL_CALLS.has(name) && !hasSymbol(sourceCorpus, name))
    .map((name) => `call \`${name}()\` is not defined anywhere in src/, scripts/ or claude-plugin/`);
}

const check = (text) => [...lineCitations(text), ...missingPaths(text), ...missingSymbols(text), ...missingCalls(text)];

describe("rule and reference citations name real files and symbols", () => {
  it("finds the rule and reference files it is meant to check", () => {
    assert.ok(docFiles().length >= 14, `expected 7 rules and 8 references, found ${docFiles().length}`);
  });

  it("cites only real paths, real symbols and no line numbers across .claude/rules and the hive-internals references", () => {
    const failures = docFiles().flatMap((file) => check(readRepo(file)).map((f) => `${file}: ${f}`));
    assert.deepEqual(failures, []);
  });

  it("fails a planted src/tmux.ts:123 line citation", () => {
    assert.deepEqual(lineCitations("See `src/tmux.ts:123` for the guard."), ["line citation `src/tmux.ts:123`"]);
  });

  it("fails a planted split citation whose line number sits in its own span", () => {
    assert.deepEqual(lineCitations("`attach()` calls it (`src/cli.ts`, `:526`)."), ["line citation `:526`"]);
  });

  it("fails a planted #L12 and :L12 line citation", () => {
    assert.deepEqual(lineCitations("See `src/tmux.ts#L12` and `src/tmux.ts:L12`."), [
      "line citation `src/tmux.ts#L12`",
      "line citation `src/tmux.ts:L12`",
    ]);
  });

  it("fails a planted path that does not exist", () => {
    assert.deepEqual(missingPaths("See `src/noSuchModule.ts` for it."), ["path `src/noSuchModule.ts` does not exist"]);
  });

  it("fails a planted symbol the cited file does not contain", () => {
    assert.deepEqual(missingSymbols("`noSuchSymbolAnywhere()` (`src/tmux.ts`) does it."), [
      "symbol `noSuchSymbolAnywhere` is not in src/tmux.ts",
    ]);
    assert.deepEqual(missingSymbols("`src/tmux.ts`'s `noSuchSymbolAnywhere` does it."), [
      "symbol `noSuchSymbolAnywhere` is not in src/tmux.ts",
    ]);
  });

  it("fails a planted symbol in the `fn` in `path` shape", () => {
    assert.deepEqual(missingSymbols("`launchAgent` and `noSuchSymbolAnywhere` in `src/spawn.ts` do it."), [
      "symbol `noSuchSymbolAnywhere` is not in src/spawn.ts",
    ]);
  });

  it("fails a planted call that only a code comment mentions, because a comment defines nothing", () => {
    const commentOnly = "isLive";
    assert.ok(new RegExp(commentOnly).test(readRepo("src/tools/wakes.ts")), "precondition: wakes.ts still mentions isLive in a comment");
    assert.deepEqual(missingCalls("It calls `isLive()` first."), [
      "call `isLive()` is not defined anywhere in src/, scripts/ or claude-plugin/",
    ]);
  });

  it("fails a planted call that is defined nowhere in the tree", () => {
    assert.deepEqual(missingCalls("It calls `noSuchSymbolAnywhere()` first."), [
      "call `noSuchSymbolAnywhere()` is not defined anywhere in src/, scripts/ or claude-plugin/",
    ]);
  });

  it("passes a real path, a real symbol and a real call", () => {
    assert.deepEqual(check("`rowOwnership()` (`src/tmux.ts`) reads `src/tools/*.ts` and `.claude/rules/tmux-and-panes.md`."), []);
  });

  it("skips a citation inside a fenced code block, because a fence shows an example and claims nothing", () => {
    assert.deepEqual(check("```\nsrc/noSuchModule.ts:12 `src/noSuchModule.ts:12`\n```\n"), []);
  });
});

describe("rule paths: frontmatter covers the files the rules govern", () => {
  const GOVERNED = {
    ".claude/rules/worker-state.md": ["src/stateProvenance.ts", "src/leadHandoff.ts", "src/portfolio.ts"],
    ".claude/rules/tmux-and-panes.md": ["src/leadHandoff.ts", "src/portfolio.ts", "src/projectRemove.ts"],
  };

  for (const [rule, files] of Object.entries(GOVERNED)) {
    for (const file of files) {
      it(`${rule} fires on ${file}`, () => {
        assert.ok(existsSync(join(REPO, file)), `${file} no longer exists; drop it from this list`);
        assert.ok(parseRulePaths(readRepo(rule)).includes(file), `${rule} paths: does not list ${file}`);
      });
    }
  }
});
