import {
  codexInputBoxState,
  codexPaneChoiceCheck,
  codexPaneHasInputBox,
  inputBoxState,
  paneChoiceCheck,
  paneHasInputBox,
  type InputBoxState,
} from "./tmux.js";

export interface WorkerArgsInput {
  displayName?: string;
  namedByCaller: boolean;
}

export interface BriefDeliveryCapability {
  settingsArgs(path: string): string[];
  systemPromptArgs(path: string): string[];
}

export interface PaneChoiceCheck {
  awaitingChoice: boolean | null;
  tail: string;
}

// Resolved once at the call site, never threaded as a command string into tmux.ts's primitives.
export interface PaneClassifier {
  choiceCheck(target: string): PaneChoiceCheck;
  inputBoxState(target: string): InputBoxState | null;
  hasInputBox(target: string): boolean | null;
}

export interface HarnessCapabilities {
  readonly name: string;

  matches(command: string): boolean;

  argsFor(input: WorkerArgsInput): string[];

  readonly briefDelivery: BriefDeliveryCapability | null;

  readonly stateSource: boolean;

  readonly transcriptDir: boolean;
  readonly contextTokens: boolean;

  // Whether hive pre-mints the id and passes it at spawn. INDEPENDENT of supportsResume: codex
  // resumes but mints its own, so the two must stay separate fields.
  readonly mintsSessionId: boolean;

  readonly supportsResume: boolean;
  readonly supportsRename: boolean;

  readonly classifiesPaneScreen: boolean;
  readonly paneClassifier: PaneClassifier | null;

  // Whether MCP registrations for this harness carry a scope at all; not where its config lives.
  readonly hasScopes: boolean;

  // Whether agent_spawn must call ensureCodexHome before launch. A flag, not a name check, like
  // every other branch here.
  readonly needsHome: boolean;

  // The CLI's own [PROMPT] positional, auto-submitted as the first user turn. null for claude on
  // purpose: its SessionStart hook already synthesizes one, so this would fire a second time.
  readonly initialPromptArgs: ((message: string) => string[]) | null;
}

export function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

// Stripped before comparing basenames - never a wrapper's own flags. Negative controls live in
// test/harness-wrapper-matching.test.mjs.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const KNOWN_WRAPPERS = new Set(["env", "nice", "arch", "time"]);

function basenameOf(token: string): string {
  return token.split("/").pop() ?? "";
}

function resolvedCommand(command: string): { prefix: string; basename: string } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    if (ENV_ASSIGNMENT.test(tokens[i])) {
      i++;
      continue;
    }
    if (KNOWN_WRAPPERS.has(basenameOf(tokens[i])) && i + 1 < tokens.length) {
      i++;
      continue;
    }
    break;
  }
  return { prefix: tokens.slice(0, i + 1).join(" "), basename: basenameOf(tokens[i] ?? "") };
}

function resolvedCommandBasename(command: string): string {
  return resolvedCommand(command).basename;
}

// For a caller rebuilding an invocation over a recorded command that may carry stale flags
// (agent_resume). Reuses matches()'s own walk rather than a second parser.
export function resolvedCommandPrefix(command: string): string {
  return resolvedCommand(command).prefix;
}

const claudeHarness: HarnessCapabilities = {
  name: "claude",

  matches: (command) => resolvedCommandBasename(command) === "claude",

  argsFor: ({ displayName, namedByCaller }) =>
    displayName && !namedByCaller ? ["--name", displayName] : [],

  briefDelivery: {
    settingsArgs: (path) => ["--settings", path],
    systemPromptArgs: (path) => ["--append-system-prompt-file", path],
  },

  stateSource: true,

  transcriptDir: true,
  contextTokens: true,

  mintsSessionId: true,
  supportsResume: true,
  supportsRename: true,

  classifiesPaneScreen: true,
  paneClassifier: { choiceCheck: paneChoiceCheck, inputBoxState, hasInputBox: paneHasInputBox },

  hasScopes: true,

  needsHome: false,

  initialPromptArgs: null,
};

export const codexHarness: HarnessCapabilities = {
  name: "codex",

  matches: (command) => resolvedCommandBasename(command) === "codex",

  argsFor: () => [],

  briefDelivery: null,

  // State comes from codex's own hooks, same mechanism as claude's. Its transcript format and
  // token accounting are unproven, so the two flags below stay false.
  stateSource: true,

  transcriptDir: false,
  contextTokens: false,

  // `codex resume <SESSION_ID>` is a positional; no --session-id flag exists, so codex mints its
  // own. This pair disagreeing is why they are two fields.
  mintsSessionId: false,
  supportsResume: true,
  supportsRename: false,

  classifiesPaneScreen: true,
  paneClassifier: {
    choiceCheck: codexPaneChoiceCheck,
    inputBoxState: codexInputBoxState,
    hasInputBox: codexPaneHasInputBox,
  },

  hasScopes: false,

  needsHome: true,

  // Auto-submits with no Enter; verified live on v0.149.0.
  initialPromptArgs: (message) => [message],
};

const unknownHarness: HarnessCapabilities = {
  name: "unknown",

  matches: () => false,

  argsFor: () => [],

  briefDelivery: null,

  stateSource: false,

  transcriptDir: false,
  contextTokens: false,

  mintsSessionId: false,
  supportsResume: false,
  supportsRename: false,

  classifiesPaneScreen: false,
  paneClassifier: null,

  hasScopes: false,

  needsHome: false,

  initialPromptArgs: null,
};

const HARNESSES: HarnessCapabilities[] = [claudeHarness, codexHarness];

export function harnessFor(command: string): HarnessCapabilities {
  return HARNESSES.find((harness) => harness.matches(command)) ?? unknownHarness;
}

// The one source of known harness names; hive.yml's `agents:` and agent_spawn both validate here.
export function harnessNames(): string[] {
  return HARNESSES.map((harness) => harness.name);
}

export function registerHarness(harness: HarnessCapabilities): void {
  if (HARNESSES.some((h) => h.name === harness.name)) {
    throw new Error(`a harness named "${harness.name}" is already registered`);
  }
  if ((harness.paneClassifier != null) !== harness.classifiesPaneScreen) {
    throw new Error(
      `harness "${harness.name}" sets classifiesPaneScreen to ${harness.classifiesPaneScreen} but ` +
        `paneClassifier is ${harness.paneClassifier == null ? "missing" : "set"}. Every call site that reads ` +
        "classifiesPaneScreen assumes paneClassifier is present whenever it is true, and never consulted " +
        "when it is false; the two must agree.",
    );
  }
  if (harness.supportsRename && !harness.classifiesPaneScreen) {
    throw new Error(
      `harness "${harness.name}" sets supportsRename without classifiesPaneScreen. agent_rename PASTES ` +
        "AND SUBMITS /rename into a live pane, and the guards that decide whether that is safe (a dialog " +
        "on screen, unsubmitted human text in the box) can only read a screen this table says hive can " +
        "classify. Set classifiesPaneScreen, or leave supportsRename off.",
    );
  }
  HARNESSES.push(harness);
}

export function unregisterHarness(name: string): void {
  const index = HARNESSES.findIndex((harness) => harness.name === name);
  if (index !== -1) HARNESSES.splice(index, 1);
}

export function isClaudeCommand(command: string): boolean {
  return harnessFor(command).name === "claude";
}

// An empty command is "no fact recorded", never "unclassifiable" - reading it the other way stops
// every wake a plain session ever set for itself.
export function screenClassifiable(command: string): boolean {
  if (command.trim() === "") return true;
  return harnessFor(command).classifiesPaneScreen;
}

// Defaults to claude's, not null: otherwise screenClassifiable's "true" above becomes a lie the
// first time anything reads the pane it was supposed to gate.
export function paneClassifierFor(command: string): PaneClassifier | null {
  if (command.trim() === "") return claudeHarness.paneClassifier;
  return harnessFor(command).paneClassifier;
}

export function transcriptDirFor(command: string): boolean {
  return harnessFor(command).transcriptDir;
}

// ANY transcript to corroborate a stall against: a resolvable directory, or a path the harness
// reported through its own hook payload. One predicate so both call sites admit the same rows.
export function hasTranscriptSignal(row: { command: string; transcript_path: string }): boolean {
  return transcriptDirFor(row.command) || row.transcript_path !== "";
}
