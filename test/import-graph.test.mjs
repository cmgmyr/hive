import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { API } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";
import { REPO } from "./helpers.mjs";

const MINIMUM_REAL_EDGES = 250;
const PARSER_SOURCE = "typescript/unstable/sync Program.getSourceFile";
const UNSUPPORTED_SOURCE_EXTENSIONS = new Set([".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);

function sourceFiles(dir, root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, root);
    if (!entry.isFile()) return [];
    const extension = extname(path);
    if (UNSUPPORTED_SOURCE_EXTENSIONS.has(extension)) {
      throw new Error(`${relative(root, path).split(sep).join("/")}: unsupported source extension ${extension}`);
    }
    return extension === ".ts" ? [path] : [];
  });
}

function parseProject(root = REPO) {
  const src = resolve(root, "src");
  const config = resolve(root, "tsconfig.json");
  const api = new API();
  const snapshot = api.updateSnapshot({ openProjects: [{ uri: new URL(`file://${config}`).href }] });
  const project = snapshot.getProjects().find((candidate) => resolve(candidate.configFileName) === config);
  assert.ok(project, `TypeScript parser did not open ${config}`);
  const files = new Map();
  try {
    for (const file of sourceFiles(src, root)) {
      const parsed = project.program.getSourceFile(file);
      assert.ok(parsed, `TypeScript parser returned no AST for ${relative(root, file)}`);
      files.set(relative(root, file).split(sep).join("/"), parsed);
    }
  } finally {
    api.close();
  }
  return files;
}

function literalText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function namedImports(node) {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
}

function localSpecifier(specifier) {
  return specifier.startsWith(".") || isAbsolute(specifier);
}

function resolveLocal(from, specifier, files, root = REPO) {
  const target = isAbsolute(specifier) ? resolve(specifier) : resolve(dirname(resolve(root, from)), specifier);
  const candidates = [];
  const extension = extname(target);
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    candidates.push(target.slice(0, -extension.length) + ".ts");
  } else if (extension === ".ts") {
    candidates.push(target);
  } else if (!extension) {
    candidates.push(`${target}.ts`, join(target, "index.ts"));
  } else {
    if (!existsSync(target)) throw new Error(`${from}: unresolved local module ${JSON.stringify(specifier)}`);
    return null;
  }
  for (const candidate of candidates) {
    const normalized = relative(root, candidate).split(sep).join("/");
    if (files.has(normalized)) return normalized;
  }
  throw new Error(`${from}: unresolved local module ${JSON.stringify(specifier)}`);
}

function enclosingFunctionName(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text ?? "";
    if (ts.isMethodDeclaration(parent)) return parent.name?.getText() ?? "";
  }
  return "";
}

function edgeGraph(files, root = REPO) {
  const edges = [];
  for (const [file, source] of files) {
    const requireNames = new Set(["require"]);
    const pending = [source];
    while (pending.length) {
      const node = pending.pop();
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const callee = node.initializer.expression;
        if (ts.isIdentifier(callee) && callee.text === "createRequire") requireNames.add(node.name.text);
      }
      node.forEachChild((child) => { pending.push(child); });
    }

    const add = (specifier, kind, names = [], typeOnly = false) => {
      if (!localSpecifier(specifier)) return;
      const to = resolveLocal(file, specifier, files, root);
      if (to) edges.push({ from: file, to, kind, names, specifier, typeOnly });
    };
    const walk = [source];
    while (walk.length) {
      const node = walk.pop();
      if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
        const specifier = literalText(node.moduleSpecifier);
        if (specifier !== null) {
          add(specifier, "import", namedImports(node), node.importClause?.isTypeOnly ?? false);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const specifier = literalText(node.moduleSpecifier);
        if (specifier !== null) add(specifier, "re-export");
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        const specifier = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null;
        if (specifier !== null) add(specifier, "import-type");
        else if (argument) throw new Error(`${file}: computed ImportTypeNode ${argument.getText(source)}`);
      } else if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
        const requireCall = ts.isIdentifier(expression) && requireNames.has(expression.text);
        if (dynamicImport || requireCall) {
          const specifier = node.arguments.length === 1 ? literalText(node.arguments[0]) : null;
          if (specifier !== null) add(specifier, dynamicImport ? "dynamic-import" : "require");
          else {
            const abiException = file === "src/abi.ts" && enclosingFunctionName(node) === "checkAbi" &&
              ts.isIdentifier(expression) && expression.text !== "require" && node.arguments.length === 1 &&
              ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === "addon";
            if (!abiException) throw new Error(`${file}: computed module load ${node.getText(source)}`);
          }
        }
      }
      node.forEachChild((child) => { walk.push(child); });
    }
  }
  const unique = new Map(edges.map((edge) => [`${edge.from}\0${edge.to}\0${edge.kind}\0${edge.names.join(",")}`, edge]));
    return [...unique.values()].sort((a, b) => `${a.from}\0${a.to}\0${a.kind}`.localeCompare(`${b.from}\0${b.to}\0${b.kind}`));
}

function toolBoundaryViolations(edges) {
  return edges.filter((edge) => edge.to.startsWith("src/tools/") && !edge.from.startsWith("src/tools/") &&
    !(edge.from === "src/index.ts" && edge.kind === "import" && !edge.typeOnly && edge.names.length > 0 && edge.names.every((name) => name.startsWith("register"))));
}

function sourceStringFragments(source) {
  const fragments = [];
  const walk = [source];
  while (walk.length) {
    const node = walk.pop();
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      fragments.push(node.text);
    }
    node.forEachChild((child) => { walk.push(child); });
  }
  return fragments;
}

function importedLocals(source, modulePath, exportedName) {
  const locals = [];
  const walk = [source];
  while (walk.length) {
    const node = walk.pop();
    if (ts.isImportDeclaration(node) && literalText(node.moduleSpecifier) === modulePath) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === exportedName) locals.push(element.name.text);
        }
      }
    }
    node.forEachChild((child) => { walk.push(child); });
  }
  return locals;
}

function callsNamed(source, names) {
  const walk = [source];
  while (walk.length) {
    const node = walk.pop();
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) return true;
    node.forEachChild((child) => { walk.push(child); });
  }
  return false;
}

function protocolOwnershipViolations(files) {
  const violations = [];
  const owners = [
    { pattern: /wake-pane:/u, owner: "src/leaseStore.ts", label: "pane lease key" },
    { pattern: /INSERT\s+INTO\s+leases/iu, owner: "src/leaseStore.ts", label: "lease insert SQL" },
    { pattern: /UPDATE\s+leases/iu, owner: "src/leaseStore.ts", label: "lease update SQL" },
    { pattern: /DELETE\s+FROM\s+leases/iu, owner: "src/leaseStore.ts", label: "lease delete SQL" },
    { pattern: /<cross-session-message from="/u, owner: "src/claudeWake.ts", label: "envelope opener" },
    { pattern: /" from-name="hive">/u, owner: "src/claudeWake.ts", label: "envelope sender suffix" },
    { pattern: /<\/cross-session-message>/u, owner: "src/claudeWake.ts", label: "envelope closer" },
    { pattern: /wake-sender\.sock/u, owner: "src/claudeWake.ts", label: "socket sender path" },
    { pattern: /Automated hive wake\. Do not reply to this sender\./u, owner: "src/claudeWake.ts", label: "wake socket footer" },
    { pattern: /Automated hive worker message\. Do not reply to this socket sender\./u, owner: "src/claudeWake.ts", label: "message socket footer" },
  ];
  for (const [file, source] of files) {
    if (!file.startsWith("src/")) continue;
    const fragments = sourceStringFragments(source);
    const strings = fragments.join("\n");
    for (const { pattern, owner, label } of owners) {
      if (file !== owner && fragments.some((fragment) => pattern.test(fragment))) violations.push(`${file}: copied ${label}; owner is ${owner}`);
    }
    if (file !== "src/claudeWake.ts") {
      const declarations = [];
      const walk = [source];
      while (walk.length) {
        const node = walk.pop();
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /GRACE_SECONDS$/u.test(node.name.text)) {
          declarations.push(node.name.text);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "DELIVERY_METHOD" && file !== "src/wakeSql.ts") {
          violations.push(`${file}: copied socket method vocabulary; owner is src/wakeSql.ts`);
        }
        node.forEachChild((child) => { walk.push(child); });
      }
      if (declarations.length) violations.push(`${file}: local socket grace declaration ${declarations.join(", ")}`);
      if (fragments.some((fragment) => /MIN\s*\(\s*created_at\s*\)[\s\S]*event\s*=\s*['"]stop['"][\s\S]*created_at\s*>=/iu.test(fragment))) {
        violations.push(`${file}: copied first-stop socket grace query; owner is src/claudeWake.ts`);
      }
    }
    if (["src/leadMessageDelivery.ts", "src/leadHandoff.ts", "src/scheduler.ts"].includes(file) && /-7 days/u.test(strings)) {
      violations.push(`${file}: copied message/log retention literal; owners are src/leadMessage.ts and src/wakeSql.ts`);
    }
    if (file === "src/leadMessageDelivery.ts") {
      const declarations = [];
      const walk = [source];
      while (walk.length) {
        const node = walk.pop();
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["MESSAGE_STATUS", "MESSAGE_METHOD"].includes(node.name.text)) {
          declarations.push(node.name.text);
        }
        node.forEachChild((child) => { walk.push(child); });
      }
      if (declarations.length) violations.push(`${file}: copied message vocabulary declaration ${declarations.join(", ")}; owner is src/leadMessage.ts`);
    }
  }

  const requiredImports = {
    "src/scheduler.ts": {
      "./leaseStore.js": ["tryAcquirePaneLease", "releasePaneLease"],
      "./claudeWake.js": ["postClaudeWake", "socketSenderAddress", "socketGraceDue", "promptMarkerEvidenceSql", "quietMessagingOn"],
    },
    "src/leadMessageDelivery.ts": {
      "./leaseStore.js": ["tryAcquirePaneLease", "releasePaneLease"],
      "./claudeWake.js": ["postClaudeWake", "socketSenderAddress", "socketGraceDue", "promptMarkerEvidenceSql", "quietMessagingOn"],
    },
    "src/leadState.ts": {
      "./claudeWake.js": ["hiveWorkerEnvelopeLikeSql", "isHiveWorkerEnvelope"],
    },
  };
  for (const [file, modules] of Object.entries(requiredImports)) {
    const source = files.get(file);
    if (!source) continue;
    for (const [modulePath, names] of Object.entries(modules)) {
      for (const name of names) {
        const locals = importedLocals(source, modulePath, name);
        if (locals.length === 0) violations.push(`${file}: missing named import ${name} from ${modulePath}`);
        else if (!callsNamed(source, new Set(locals))) violations.push(`${file}: imported ${name} from ${modulePath} is not called`);
      }
    }
  }
  return violations.sort();
}

function withParsedFiles(fileMap, callback) {
  const root = mkdtempSync(join(tmpdir(), "hive-import-graph-"));
  try {
    for (const [path, contents] of Object.entries(fileMap)) {
      const target = resolve(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    writeFileSync(resolve(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
      include: ["src/**/*.ts"],
    }));
    return callback(parseProject(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cyclePaths(files, edges) {
  const graph = new Map([...files.keys()].map((file) => [file, []]));
  for (const edge of edges) graph.get(edge.from).push(edge.to);
  for (const targets of graph.values()) targets.sort();
  let nextIndex = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (file) => {
    index.set(file, nextIndex); low.set(file, nextIndex++); stack.push(file); onStack.add(file);
    for (const target of graph.get(file)) {
      if (!index.has(target)) { visit(target); low.set(file, Math.min(low.get(file), low.get(target))); }
      else if (onStack.has(target)) low.set(file, Math.min(low.get(file), index.get(target)));
    }
    if (low.get(file) === index.get(file)) {
      const component = [];
      let target;
      do { target = stack.pop(); onStack.delete(target); component.push(target); } while (target !== file);
      if (component.length > 1 || graph.get(file).includes(file)) components.push(component.sort());
    }
  };
  for (const file of [...graph.keys()].sort()) if (!index.has(file)) visit(file);
  return components.map((component) => {
    const allowed = new Set(component);
    const path = [];
    const active = new Set();
    const start = component[0];
    const find = (file) => {
      path.push(file); active.add(file);
      for (const target of graph.get(file).filter((next) => allowed.has(next))) {
        if (target === start) return [...path, start];
        if (!active.has(target)) { const found = find(target); if (found) return found; }
      }
      path.pop(); active.delete(file); return null;
    };
    return find(start) ?? [start, start];
  });
}

describe("source import graph", () => {
  it("src has no import cycles", () => {
    const files = parseProject();
    const edges = edgeGraph(files);
    assert.ok(edges.some((edge) => edge.from === "src/index.ts" && edge.to === "src/tools/agents.ts"), `${PARSER_SOURCE} must include the known src/index.ts -> src/tools/agents.ts edge`);
    assert.ok(edges.length > MINIMUM_REAL_EDGES, `${PARSER_SOURCE} floor requires more than ${MINIMUM_REAL_EDGES} edges, got ${edges.length}`);
    const cycles = cyclePaths(files, edges);
    assert.deepEqual(cycles, [], cycles.map((cycle) => cycle.join(" -> ")).join("\n"));
  });

  it("fails closed with the file name when src contains an unsupported source extension", () => {
    assert.throws(
      () => withParsedFiles({ "src/not-in-graph.mts": "export {};" }, () => {}),
      /src\/not-in-graph\.mts: unsupported source extension \.mts/,
    );
  });

  it("only the MCP entry imports tool modules", () => {
    const files = parseProject();
    const edges = edgeGraph(files);
    const forbidden = toolBoundaryViolations(edges);
    assert.deepEqual(forbidden, [], forbidden.map((edge) => `${edge.from} -> ${edge.to} (${edge.kind})`).join("\n"));
    withParsedFiles({
      "src/index.ts": 'import { registerAgents } from "./tools/agents.js";',
      "src/tools/agents.ts": "export function registerAgents() {}",
      "src/type.ts": 'import type { AgentRow } from "./tools/agents.js";',
      "src/dynamic.ts": 'void import("./tools/agents.js");',
      "src/require.ts": 'require("./tools/agents.js");',
      "src/reexport.ts": 'export * from "./tools/agents.js";',
    }, (fixtureFiles, root) => {
      const violations = toolBoundaryViolations(edgeGraph(fixtureFiles, root));
      assert.equal(violations.length, 4, violations.map((edge) => `${edge.from} -> ${edge.to} (${edge.kind})`).join("\n"));
      assert.deepEqual(violations.map((edge) => edge.kind).sort(), ["dynamic-import", "import", "re-export", "require"]);
    });
  });

  it("shared delivery protocols have one source owner", () => {
    const violations = protocolOwnershipViolations(parseProject());
    assert.deepEqual(violations, [], violations.join("\n"));
  });

  it("protocol ownership gate rejects copied lease and socket fragments", () => {
    const fixtures = {
      "src/leaseStore.ts": "export {};",
      "src/claudeWake.ts": "export {};",
      "src/leadMessage.ts": "export {};",
      "src/wakeSql.ts": "export {};",
      "src/scheduler.ts": `const key = "wake-pane:";
        const lease = "INSERT INTO leases";
        const update = "UPDATE leases";
        const release = "DELETE FROM leases";
        const frame = '<cross-session-message from="';
        const suffix = '" from-name="hive">';
        const close = '</cross-session-message>';
        const path = "wake-sender.sock";
        const footer = "Automated hive wake. Do not reply to this sender.";
        const grace = 60;
        const GRACE_SECONDS = 60;
        const DELIVERY_METHOD = { socket: "socket" };
        const graceSql = "SELECT MIN(created_at) FROM agent_state_log WHERE event = 'stop' AND created_at >= ?";`,
      "src/leadMessageDelivery.ts": `const MESSAGE_STATUS = { complete: "complete" };
        const MESSAGE_METHOD = { pty: "pty" };
        const footer = "Automated hive worker message. Do not reply to this socket sender.";
        const retention = "-7 days";`,
      "src/leadHandoff.ts": `const retention = "-7 days";`,
    };
    withParsedFiles(fixtures, (files) => {
      const violations = protocolOwnershipViolations(files);
      for (const expected of ["pane lease key", "lease insert SQL", "lease update SQL", "lease delete SQL", "envelope opener", "envelope sender suffix", "envelope closer", "socket sender path", "wake socket footer", "message socket footer", "socket grace declaration", "socket method vocabulary", "first-stop socket grace query", "message/log retention literal", "message vocabulary declaration"]) {
        assert.ok(violations.some((violation) => violation.includes(expected)), `${expected}:\n${violations.join("\n")}`);
      }
    });
  });

  it("reports cycles through every supported edge form", () => {
    const fixture = {
      "src/a0.ts": 'import "./b0.js";', "src/b0.ts": 'import "./a0.js";',
      "src/a1.ts": 'export * from "./b1.js";', "src/b1.ts": 'import "./a1.js";',
      "src/a2.ts": 'type B = import("./b2.js").B;', "src/b2.ts": 'import "./a2.js";',
      "src/a3.ts": 'void import("./b3.js");', "src/b3.ts": 'import "./a3.js";',
      "src/a4.ts": 'require("./b4.js");', "src/b4.ts": 'import "./a4.js";',
      "src/a5.ts": 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./b5.js");',
      "src/b5.ts": 'import "./a5.js";',
      "src/self.ts": 'import "./self.js";',
      "src/d1.ts": 'import "./d2.js"; import "./d3.js";',
      "src/d2.ts": 'import "./d4.js";', "src/d3.ts": 'import "./d4.js";', "src/d4.ts": "export {};",
    };
    withParsedFiles(fixture, (files, root) => {
      const edges = edgeGraph(files, root);
      const cycles = cyclePaths(files, edges);
      assert.equal(cycles.length, 7, cycles.map((cycle) => cycle.join(" -> ")).join("\n"));
      assert.ok(edges.some((edge) => edge.kind === "re-export"));
      assert.ok(edges.some((edge) => edge.kind === "import-type"));
      assert.ok(edges.some((edge) => edge.kind === "dynamic-import"));
      assert.ok(edges.some((edge) => edge.kind === "require" && edge.from === "src/a5.ts"));
      assert.deepEqual(cycles.find((cycle) => cycle.length === 2), ["src/self.ts", "src/self.ts"]);
    });
  });

  it("rejects unresolved local imports", () => {
    withParsedFiles({ "src/a.ts": 'import "./missing.js";' }, (files, root) => {
      assert.throws(() => edgeGraph(files, root), /src\/a\.ts: unresolved local module/);
    });
    withParsedFiles({ "src/a.ts": 'import "./missing.json";' }, (files, root) => {
      assert.throws(() => edgeGraph(files, root), /src\/a\.ts: unresolved local module/);
    });
  });

  it("rejects computed module loads", () => {
    withParsedFiles({
      "src/computed.ts": 'const target = "./local.js"; import(target);',
    }, (files, root) => assert.throws(() => edgeGraph(files, root), /computed module load/));
    withParsedFiles({
      "src/computed.ts": 'const target = "./local.js"; require(target);',
    }, (files, root) => assert.throws(() => edgeGraph(files, root), /computed module load/));
    withParsedFiles({
      "src/computed.ts": 'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); const target = "./local.js"; load(target);',
    }, (files, root) => assert.throws(() => edgeGraph(files, root), /computed module load/));
  });

  it("native addon load is outside the source graph", () => {
    withParsedFiles({
      "src/abi.ts": 'import { createRequire } from "node:module"; function checkAbi(addon: string) { const requireFromHere = createRequire(import.meta.url); requireFromHere(addon); }',
    }, (files, root) => assert.deepEqual(edgeGraph(files, root), []));
    withParsedFiles({
      "src/other.ts": 'import { createRequire } from "node:module"; function checkAbi(addon: string) { const requireFromHere = createRequire(import.meta.url); requireFromHere(addon); }',
    }, (files, root) => assert.throws(() => edgeGraph(files, root), /computed module load/));
    withParsedFiles({
      "src/abi.ts": 'import { createRequire } from "node:module"; function loadAddon(addon: string) { const requireFromHere = createRequire(import.meta.url); requireFromHere(addon); }',
    }, (files, root) => assert.throws(() => edgeGraph(files, root), /computed module load/));
  });

  it("ignores import-looking comments and string literals", () => {
    withParsedFiles({
      "src/a.ts": `// import './fake.js'\nconst text = "require('./also-fake.js')";`,
    }, (files, root) => assert.deepEqual(edgeGraph(files, root), []));
  });
});
