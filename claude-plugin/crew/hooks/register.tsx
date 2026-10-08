import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { REFRESH_MS, buildCrewView, failedView, readCrew } from '../model.mjs'
import type { CrewView } from '../types'

const PANE = 'hive-crew'
const crew = atom({ plugin: 'hive-crew', key: 'crew' } as const, null as CrewView | null)

let polling = false

async function startPolling($: EngineInterface) {
  if (polling) return
  polling = true
  const cwd = await $.session.cwd()
  let busy = false
  const refresh = async () => {
    if (busy) return
    busy = true
    try {
      const snapshot = await readCrew((argv, init) => $.process.run(argv, init), cwd)
      await update($, crew, prev => buildCrewView(snapshot, prev, Date.now()))
    } catch (err) {
      await update($, crew, prev => failedView(prev, String(err instanceof Error ? err.message : err)))
    } finally {
      busy = false
    }
  }
  await refresh()
  $.clock.every(REFRESH_MS, refresh)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HIVE_LEAD"'])
    if (stdout !== '1') return next(e)
    await $.command.register({ name: 'hive-crew', description: "Show this hive project's crew in a side pane" })
    await startPolling($)
    const now = await read($, crew)
    if (now && !now.error) void $.ui.open({ id: PANE, title: 'hive crew' })
    return next(e)
  })

  on('command.run', { command: 'hive-crew' }, async $ => {
    await startPolling($)
    await $.ui.open({ id: PANE, title: 'hive crew' })
    return { text: 'hive crew pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const c = await read($, crew)
    if (!c) return <Text dimColor>reading the hive crew…</Text>
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{c.header}</Text>
        {c.error && <Text color="red" wrap="truncate-end">read failed: {c.error}</Text>}
        {c.rows.length === 0 && <Text dimColor>  no lanes</Text>}
        {c.rows.map(r => (
          <Box flexDirection="column">
            <Text wrap="truncate-end"><Text color={r.color}>● </Text>{r.id} <Text dimColor>{r.slug}</Text></Text>
            <Text wrap="truncate-end" dimColor>  {r.model}{r.model ? ' · ' : ''}{r.activity}{r.ctx ? ' · ' : ''}<Text color={r.ctxAmber ? 'yellow' : undefined}>{r.ctx}</Text>{r.rest ? ' · ' : ''}{r.rest}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text bold color={c.needsYou.length ? 'red' : undefined}>needs you</Text>
        {c.needsYou.length === 0 && <Text dimColor>  nothing</Text>}
        {c.needsYou.map(t => <Text wrap="truncate-end">  {t.id} <Text dimColor>{t.slug}</Text></Text>)}
        <Text> </Text>
        {c.footer.map(line => <Text dimColor wrap="truncate-end">{line}</Text>)}
      </Box>
    )
  })
}
