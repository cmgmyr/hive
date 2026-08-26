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

// The pane-level predicates each harness's chrome needs, resolved once at the call site (harnessFor)
// rather than threaded as a command string into src/tmux.ts's capture primitives - see todo 523.
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

  // Whether hive itself must pre-mint a UUID and pass it at spawn (claude's --session-id), as
  // opposed to the harness minting its own and reporting it back through its first hook payload
  // (codex). Independent of supportsResume: codex proves the two properties can disagree (todo
  // 563) - it resumes, but does not take an externally supplied id, so agent_spawn must not mint
  // one for it. transcriptDir is not part of this: nothing today needs a transcript-dir-only
  // harness to trigger minting, so folding that case into a dedicated field (rather than the old
  // `transcriptDir || supportsResume` at agents.ts) is a rename for claude, not a behavior change.
  readonly mintsSessionId: boolean;

  readonly supportsResume: boolean;
  readonly supportsRename: boolean;

  readonly classifiesPaneScreen: boolean;
  readonly paneClassifier: PaneClassifier | null;

  // Whether MCP registrations for this harness carry a scope at all; not where its config lives.
  readonly hasScopes: boolean;

  // Whether agent_spawn must call ensureCodexHome (src/codexHome.ts) before launch: a per-worker
  // home directory carrying its own hooks.json, MCP registration and brief, set as an env var
  // rather than reached through briefDelivery's CLI-arg shape. Only codex needs this today; kept
  // as a capability flag rather than a name check for the same reason every other branch here is.
  readonly needsHome: boolean;

  // The CLI's own [PROMPT] positional, submitted as the first user turn with no keystroke needed -
  // live-verified on codex v0.149.0 (a bare `codex "..."` responded with no Enter pressed). null
  // for claude on purpose: a claude lead's SessionStart hook already synthesizes initialUserMessage
  // itself (src/kickoff.ts), so appending a second, redundant initial turn here would fire twice.
  // Codex's SessionStart hook schema rejects that same field outright (additionalProperties:false;
  // see kickoff.ts's `forCodex` branch), so this positional is the only channel left for a codex
  // lead to open on triage rather than sit idle holding a board nobody told it to act on.
  readonly initialPromptArgs: ((message: string) => string[]) | null;
}

export function commandHead(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "";
}

function commandBasename(command: string): string {
  return commandHead(command).split("/").pop() ?? "";
}

const claudeHarness: HarnessCapabilities = {
  name: "claude",

  matches: (command) => commandBasename(command) === "claude",

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

// Registered below (todo 524): proven end to end that hive can drive a codex pane - hook-trust
// bypass and brief delivery both verified live, see the tmux-and-panes reference.
export const codexHarness: HarnessCapabilities = {
  name: "codex",

  matches: (command) => commandBasename(command) === "codex",

  argsFor: () => [],

  briefDelivery: null,

  // Earned by todo 525 (C3): busy/idle/session-boundary now come from codex's own hooks (prompt,
  // stop, the rekeyed subagent latch) - the same mechanism, and the same measured exactness, as
  // claude's. transcriptDir/contextTokens stay false below; nothing in this lane proves codex's
  // transcript format or token accounting - that is a separate lane (staleness), not this one.
  stateSource: true,

  transcriptDir: false,
  contextTokens: false,

  // codex resumes via `codex resume <SESSION_ID>` (a subcommand positional, live-verified on
  // v0.149.0 - no --session-id flag exists anywhere in `codex --help`), so it mints its OWN id
  // rather than taking one from hive: mintsSessionId stays false while supportsResume flips true
  // (todo 563). The two disagreeing is exactly why they are separate fields.
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

  // codex [PROMPT] auto-submits with no Enter needed - live-verified 2026-08-25 on v0.149.0.
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

// The one source of known harness names - hive.yml's `agents:` key and agent_spawn's `harness`
// parameter both validate against this rather than each keeping their own copy of the list.
export function harnessNames(): string[] {
  return HARNESSES.map((harness) => harness.name);
}

// Registration is the extension point a later harness (or a test proving this table's
// independence property) adds an entry through, rather than editing every call site.
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

// An empty command is "no fact recorded", never "unclassifiable": a wake can name a pane that has no
// agents row at all (resolveDelivery's TMUX_PANE fallback), and reading that as unclassifiable stops
// every wake a plain session ever set for itself.
export function screenClassifiable(command: string): boolean {
  if (command.trim() === "") return true;
  return harnessFor(command).classifiesPaneScreen;
}

// The predicate-level twin of screenClassifiable's empty-command case above: a pane with no agents
// row has, historically, always been a plain claude session, so its predicates default to claude's
// rather than to unknownHarness's null - which would make screenClassifiable's "true" a lie the first
// time anything actually reads the pane it was supposed to gate.
export function paneClassifierFor(command: string): PaneClassifier | null {
  if (command.trim() === "") return claudeHarness.paneClassifier;
  return harnessFor(command).paneClassifier;
}

// One named predicate for stall detection's transcript-corroboration gate (src/cli.ts, src/scheduler.ts),
// rather than each call site reading harnessFor(...).transcriptDir inline.
export function transcriptDirFor(command: string): boolean {
  return harnessFor(command).transcriptDir;
}
