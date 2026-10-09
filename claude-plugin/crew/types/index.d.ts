export type Part = { text: string; amber?: boolean }
export type Row = { key: string; color: string; id: string; slug: string; detail: string; parts: Part[] }
export type CrewView = {
  header: string
  rows: Row[]
  needsYou: { id: string; slug: string }[]
  footer: { text: string; amber?: boolean }[]
  error: string
  memory: Record<string, number>
  noData: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'hive-crew': { crew: CrewView | null }
  }
}
