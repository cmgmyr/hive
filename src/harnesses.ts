export interface WorkerArgsInput {
  displayName?: string;
  namedByCaller: boolean;
}

export interface BriefDeliveryCapability {
  settingsArgs(path: string): string[];
  systemPromptArgs(path: string): string[];
}

export interface HarnessCapabilities {
  readonly name: string;

  matches(command: string): boolean;

  argsFor(input: WorkerArgsInput): string[];

  readonly briefDelivery: BriefDeliveryCapability | null;

  readonly stateSource: boolean;

  readonly transcriptDir: boolean;
  readonly contextTokens: boolean;

  readonly supportsResume: boolean;
  readonly supportsRename: boolean;

  readonly supportsInputBoxProbe: boolean;

  // Whether MCP registrations for this harness carry a scope at all; not where its config lives.
  readonly hasScopes: boolean;
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

  supportsResume: true,
  supportsRename: true,

  supportsInputBoxProbe: true,

  hasScopes: true,
};

const unknownHarness: HarnessCapabilities = {
  name: "unknown",

  matches: () => false,

  argsFor: () => [],

  briefDelivery: null,

  stateSource: false,

  transcriptDir: false,
  contextTokens: false,

  supportsResume: false,
  supportsRename: false,

  supportsInputBoxProbe: false,

  hasScopes: false,
};

const HARNESSES: HarnessCapabilities[] = [claudeHarness];

export function harnessFor(command: string): HarnessCapabilities {
  return HARNESSES.find((harness) => harness.matches(command)) ?? unknownHarness;
}

// Registration is the extension point a later harness (or a test proving this table's
// independence property) adds an entry through, rather than editing every call site.
export function registerHarness(harness: HarnessCapabilities): void {
  if (HARNESSES.some((h) => h.name === harness.name)) {
    throw new Error(`a harness named "${harness.name}" is already registered`);
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
