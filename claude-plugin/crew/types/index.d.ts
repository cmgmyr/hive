export type Row = { key: string; color: string; id: string; slug: string; model: string; activity: string; ctx: string; rest: string; ctxAmber: boolean }
export type CrewView = {
  header: string
  rows: Row[]
  needsYou: { id: string; slug: string }[]
  footer: string[]
  error: string
  memory: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'hive-crew': { crew: CrewView | null }
  }
}
