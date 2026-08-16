export function awaitingFirstPrompt(row: { resumed_at: string }): boolean {
  return typeof row.resumed_at === "string" && row.resumed_at !== "";
}

export function awaitingFirstPromptSql(alias: string): string {
  return `${alias}.resumed_at != ''`;
}
