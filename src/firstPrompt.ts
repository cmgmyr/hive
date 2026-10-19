export function awaitingFirstPrompt(row: { resumed_at: string }): boolean {
  return typeof row.resumed_at === "string" && row.resumed_at !== "";
}

export function awaitingFirstPromptSql(alias: string): string {
  return `${alias}.resumed_at != ''`;
}

export function finishedIdle(row: { agent_state: string; resumed_at: string }): boolean {
  return row.agent_state === "idle" && !awaitingFirstPrompt(row);
}

export function finishedIdleSql(alias: string): string {
  return `${alias}.agent_state = 'idle' AND NOT (${awaitingFirstPromptSql(alias)})`;
}
