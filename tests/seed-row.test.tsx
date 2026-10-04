import { test, expect } from 'claude-code/testing'
import { linkify } from '../hooks/register.tsx'

const PLUGIN = 'auto-handoff'
const PATH = '/home/me/.claude/state/auto-handoff/dbd019e5-410b-4d91-8db9-6755b2924e48.md'
const URL = 'http://100.85.122.99:3846/dbd019e5-410b-4d91-8db9-6755b2924e48.html'
const SEED = `[auto-handoff] ↪ Handoff from session dbd019e5. The previous session hit its context limit and was cleared. Read the brief at ${PATH} before doing anything else (readable copy: ${URL}) and follow its Instructions section. Open your first reply with the line "↪ Handoff from session dbd019e5".`

const row = (text: string, origin: Record<string, unknown>) => ({
  component: 'UserMessage' as const,
  props: { text, origin, isExpanded: false } as never,
})

test('linkify turns the brief path and viewer URL into markdown links', async () => {
  const out = linkify(SEED)
  expect(out).toContain(`[dbd019e5-410b-4d91-8db9-6755b2924e48.md](file://${PATH})`)
  expect(out).toContain(`[${URL}](${URL})`)
  // Everything else stays as written.
  expect(out.startsWith('[auto-handoff] ↪ Handoff from session dbd019e5.')).toBe(true)
  expect(out).toContain('follow its Instructions section.')
})

test('linkify leaves a seed with no viewer link alone except for the path', async () => {
  const text = `[auto-handoff] ↪ Handoff from session abc. Read the brief at ${PATH} before doing anything else and follow its Instructions section.`
  const out = linkify(text)
  expect(out).toContain(`(file://${PATH})`)
  expect(out).not.toContain('http')
})

test('the seed row draws as a Markdown with clickable links on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...row(SEED, { kind: 'plugin', name: PLUGIN }) })
    const md = await ui.find({ type: 'Markdown' })
    expect(md).toBeDefined()
    expect(md?.text).toContain(`(file://${PATH})`)
    expect(md?.text).toContain(`[${URL}](${URL})`)
    await ui.unmount()
  }
})

test('rows from other plugins or the person are left to the engine', async ($, on) => {
  // Stands for the engine's own drawing beneath the plugin: a plain Text of the row.
  on('ui.render', { component: 'UserMessage' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  const cases: Array<[string, Record<string, unknown>]> = [
    [SEED, { kind: 'plugin', name: 'some-other-plugin' }],
    [SEED, { kind: 'composer' }],
    ['[auto-handoff] Not run: the context is past the handoff threshold.', { kind: 'plugin', name: PLUGIN }],
  ]
  for (const [text, origin] of cases) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...row(text, origin) })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    expect((await ui.find({ type: 'Text' }))?.text).toBe(text)
    await ui.unmount()
  }
})
