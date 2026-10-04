import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import { extractFacts, hasUnansweredLastRequest, isValidBrief } from '../hooks/brief.ts'
import { renderTemplate } from '../hooks/templates.ts'
import { parseBrief } from '../hooks/viewer.ts'

type Calls = { compacts: number; steps: number; cleared: number; seeded: string[]; written: Record<string, string>; completes: number; tokens: number; prompts: string[]; toasts: string[]; ran: number }

// The test runs sandboxed, with no file access, so these stand in for the files in templates/:
// the same headings and switches, shorter prose.
const SHIPPED_BRIEF = `Write a handoff brief with these sections.

## Work in Progress
What was being worked on.

## Questions Answered
Things established.

## Last Request from the User
Copy "Last Real User Message" verbatim. Then "Status: Answered / Partially answered / Not answered".

## Next Step
The next action.
`
const SHIPPED_INSTRUCTIONS = `## Instructions
{{#priority}}
**PRIORITY: The "Last Request from the User" section below is not yet answered. Answer that request as your first action.**
{{/priority}}

This turn was triggered by the system, not by a user.
{{#priority}}Do the PRIORITY request and nothing else.{{/priority}}
{{^priority}}If the brief includes in-progress or pending work, continue that work immediately.{{/priority}}

**You MUST produce a text response before ending your turn.**
`

const BASIC: SessionMessage[] = [
  { role: 'user', text: 'please refactor the parser', toolUses: [] },
  { role: 'assistant', text: 'on it', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: 'src/parser.ts' } }] },
]

const msg = (role: 'user' | 'assistant', text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role, text, toolUses })
const bash = (command: string, text?: string, isError?: true) => ({ tool_use_id: 'b', tool: 'Bash', input: { command }, ...(text === undefined ? {} : { text }), ...(isError ? { isError } : {}) })
const edit = (file_path: string, tool = 'Edit') => ({ tool_use_id: 'e', tool, input: { file_path } })

const TURN = { answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as const
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// The test runs under bun, which has timers; the hooks lib (es2023, no DOM) does not declare them.
declare const setTimeout: (fn: (...args: never[]) => void, ms: number) => unknown

// The engine beneath the plugin: everything the mod calls, answered from memory.
function engine(on: On, opts: { tokens: number; files?: Record<string, string>; env?: Record<string, string>; brief?: string | null; messages?: SessionMessage[]; toolChars?: number; streamToolChars?: number; store?: Record<string, unknown>; stepUsage?: boolean; surfaces?: ('terminal' | 'desktop' | 'mobile' | 'vscode')[] }): Calls {
  const calls: Calls = { compacts: 0, steps: 0, cleared: 0, seeded: [], written: {}, completes: 0, tokens: opts.tokens, prompts: [], toasts: [], ran: 0 }
  let sessionId = 'old-session'
  let clears = 0
  mock.env(on, { HOME: '/home/test', ...(opts.env ?? {}) })
  clock = mock.clock(on) // the panel's spinner and collapse timers
  on('session.surfaces', async () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => { // the engine draws nothing in the band
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  mock.store(on, opts.store) // the test's $ has no store noun: what the mod finds in its store is seeded here
  on('turn.complete', async () => ({ text: 'ok' }))
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: calls.tokens, window: 200_000 }, rateLimits: [] } }))
  on('session.id', async () => ({ value: sessionId }))
  on('session.cwd', async () => ({ value: '/home/test/proj' }))
  on('fs.read', async (_$, e) => {
    const text = calls.written[e.path] ?? opts.files?.[e.path]
    // The shipped defaults: the real files in the mod's templates/ folder.
    if (text === undefined && e.path.endsWith("/templates/brief.md")) return { value: SHIPPED_BRIEF }
    if (text === undefined && e.path.endsWith("/templates/instructions.md")) return { value: SHIPPED_INSTRUCTIONS }
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('session.messages', async () => ({ value: opts.messages ?? BASIC }))
  on('model.complete', async (_$, e) => {
    calls.completes++
    calls.prompts.push(e.prompt)
    return {
      value: opts.brief === null
        ? { isAnswered: false, reason: 'empty-reply', usage: USAGE }
        : { isAnswered: true, text: opts.brief ?? '## Next Step\nFinish the parser refactor.', usage: USAGE },
    }
  })
  on('fs.write', async (_$, e) => {
    calls.written[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => ({
    value: Object.keys(calls.written).filter(p => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes('/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.toast', async (_$, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.run', async () => {
    calls.cleared++
    sessionId = `new-session-${++clears}`
    return {}
  })
  on('prompt.submit', async (_$, e) => {
    calls.seeded.push(e.text)
    return { text: e.text }
  })
  on('classic.SessionStart', async () => ({}))
  on('session.compact', async (_$, e) => {
    calls.compacts++
    return { messages: e.messages }
  })
  // The real request: reached only when the mod lets the step through.
  on('turn.step', async function* (_$, e) {
    calls.steps++
    // stepUsage: the response reports the request's size, as the real engine does.
    const usage = opts.streamToolChars ? { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never
      : opts.stepUsage ? { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: calls.tokens - 10, cache_creation_input_tokens: 0 } as never
      : null
    if (usage) yield { kind: 'text', index: 0, text: 'reading' }
    yield { kind: 'stop', stopReason: 'tool_use', usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage }
  })
  on('tool.call', async (_$, e) => (calls.ran++, { result: { content: '' }, text: 'x'.repeat(('file_path' in e && e.file_path === '/streamed.txt' ? opts.streamToolChars : opts.toolChars) ?? 0) }))
  return calls
}

const STEP = { turnId: 't1', index: 1, model: 'claude-fable-5-1', messageCount: 10 }

// Runs one model request through the chain and returns the chunks that came out.
async function step($: TestBody extends (...a: infer A) => unknown ? A[0] : never, index = 1) {
  const chunks: { kind: string; text?: string }[] = []
  for await (const c of $.turn.step({ ...STEP, index })) chunks.push(c)
  return chunks
}

let clock: ReturnType<typeof mock.clock>

const mountBand = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120 } as never })

// Every string in a drawn tree, in order: Text children, a Markdown's text, a Button's label.
const textOf = (n: unknown): string => typeof n === 'string' ? n
  : Array.isArray(n) ? n.map(textOf).join('')
  : n && typeof n === 'object' ? Object.entries(n).map(([k, v]) => k === 'children' || k === 'text' || k === 'label' || k === 'props' ? textOf(v) : '').join('')
  : ''

// The band above the prompt as drawn, flattened to its text; '' when the mod draws nothing.
async function band($: Parameters<TestBody>[0]): Promise<string> {
  const ui = await mountBand($)
  try {
    return textOf(await ui.drawn())
  } finally {
    await ui.unmount()
  }
}

async function settle(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise(r => setTimeout(r, 10))
}

describe('auto-handoff', () => {
  test('below the threshold nothing happens', async ($, on) => {
    const calls = engine(on, { tokens: 100_000 })
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.completes).toBe(0)
    expect(calls.cleared).toBe(0)
  })

  test('at the threshold: brief to disk, /clear, then seed the new session', async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(calls.completes).toBe(1)
    expect(Object.keys(calls.written)).toEqual(['/home/test/.claude/state/auto-handoff/old-session.md', '/home/test/.claude/state/auto-handoff/pages/old-session.html'])
    expect(calls.written['/home/test/.claude/state/auto-handoff/old-session.md']).toContain('Finish the parser refactor')
    expect(calls.cleared).toBe(1)

    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    expect(calls.seeded.length).toBe(1)
    // The seed is one line pointing at the brief on disk, not the brief itself.
    expect(calls.seeded[0]).toContain('Read the brief at /home/test/.claude/state/auto-handoff/old-session.md')
    expect(calls.seeded[0]).not.toContain('Finish the parser refactor')
    expect(calls.seeded[0]?.split('\n').length).toBe(1)
  })

  test('fires once per session', async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.completes).toBe(1)
  })

  test('AUTO_HANDOFF_TOKENS lowers the threshold', async ($, on) => {
    const calls = engine(on, { tokens: 25_000, env: { AUTO_HANDOFF_TOKENS: '20000' } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(calls.cleared).toBe(1)
  })

  for (const name of ['AUTO_HANDOFF_DISABLE', 'DISABLE_AUTO_COMPACT']) {
    test(`kill switch: ${name} set means no brief and no clear`, async ($, on) => {
      const calls = engine(on, { tokens: 190_000, env: { [name]: '1' } })
      await $.turn.complete(TURN)
      await settle(() => false)
      expect(calls.completes).toBe(0)
      expect(calls.cleared).toBe(0)
    })
  }

  test('subagent turns are ignored', async ($, on) => {
    const calls = engine(on, { tokens: 190_000 })
    await $.turn.complete({ ...TURN, agentId: 'sub-1' })
    await settle(() => false)
    expect(calls.completes).toBe(0)
  })

  test('a failed Haiku brief falls back to the facts and still hands off', async ($, on) => {
    const calls = engine(on, { tokens: 190_000, brief: null, messages: [msg('assistant', 'done', [edit('/repo/src/a.ts')])] })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const brief = calls.written['/home/test/.claude/state/auto-handoff/old-session.md']
    expect(calls.cleared).toBe(1)
    expect(brief).toContain('did not return a usable brief')
    expect(brief).toContain('- /repo/src/a.ts')
  })

  test('a Haiku reply with no brief sections is replaced by the facts', async ($, on) => {
    const calls = engine(on, { tokens: 190_000, brief: 'Sure, I can help with that parser refactor!' })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const brief = calls.written['/home/test/.claude/state/auto-handoff/old-session.md']
    expect(brief).not.toContain('Sure, I can help')
    expect(brief).toContain('## Last Real User Message (verbatim)\nplease refactor the parser')
  })

  test('a blank viewer setting means no server, and the link is the local file', { options: { viewer: '' } }, async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    expect(calls.seeded[0]).toContain('file:///home/test/.claude/state/auto-handoff/pages/old-session.html')
  })

  test('the threshold userConfig field sets the threshold', { options: { threshold: 100_000 } }, async ($, on) => {
    const calls = engine(on, { tokens: 120_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(calls.cleared).toBe(1)
  })

  test('AUTO_HANDOFF_TOKENS overrides the threshold field', { options: { threshold: 100_000 } }, async ($, on) => {
    const calls = engine(on, { tokens: 120_000, env: { AUTO_HANDOFF_TOKENS: '150000' } })
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.cleared).toBe(0)
  })

  test('the brief opens with the handoff instructions', async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const brief = parseBrief(calls.written['/home/test/.claude/state/auto-handoff/old-session.md'] ?? '').body
    expect(brief.startsWith('## Instructions')).toBe(true)
    expect(brief).toContain('triggered by the system, not by a user')
    expect(brief).toContain('continue that work immediately')
    expect(brief).toContain('You MUST produce a text response')
    expect(brief).not.toContain('PRIORITY')
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    expect(calls.seeded[0]).toContain('follow its Instructions section')
  })

  test('each brief gets a viewer page, and the chain links forward once the next session hands off', async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    const dir = '/home/test/.claude/state/auto-handoff'
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const first = parseBrief(calls.written[`${dir}/old-session.md`] ?? '').header
    expect(first.chain).toBe('old-session')
    expect(first.tokens).toBe('165000')
    expect(calls.written[`${dir}/pages/old-session.html`]).toContain('Session Context')
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    // No Tailscale in the test, so the server falls back to localhost.
    expect(calls.seeded[0]).toContain('(readable copy: http://127.0.0.1:3846/old-sess)')
    expect(parseBrief(calls.written[`${dir}/old-session.md`] ?? '').header.to).toBe('new-session-1')
    // The seeded session hands off in turn: same chain, and its brief points back.
    // The seeded session's first turn sets its floor; the next one past the line hands off.
    calls.tokens = 47_000
    await $.turn.complete(TURN)
    calls.tokens = 260_000
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 1)
    const second = parseBrief(calls.written[`${dir}/new-session-1.md`] ?? '').header
    expect(second.chain).toBe('old-session')
    expect(second.from).toBe('old-session')
    expect(calls.written[`${dir}/pages/new-session-1.html`]).toContain('href="old-session.html"')
  })

  test('a session seeded before a hot reload keeps its chain: lineage comes from the store', async ($, on) => {
    // Seen live: the reload wiped the in-memory lineage, and the next brief started a new chain.
    const dir = '/home/test/.claude/state/auto-handoff'
    const calls = engine(on, { tokens: 165_000, store: { 'lineage:old-session': { from: 'earlier', chain: 'first' } } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const header = parseBrief(calls.written[`${dir}/old-session.md`] ?? '').header
    expect(header.from).toBe('earlier')
    expect(header.chain).toBe('first')
  })

  test('an unanswered last request puts a PRIORITY directive in the instructions', async ($, on) => {
    const brief = '## Last Request from the User\n"Make the thresholds vars"\nStatus: Partially answered.\n\n## Next Step\nAdd userConfig.'
    const calls = engine(on, { tokens: 165_000, brief })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const written = calls.written['/home/test/.claude/state/auto-handoff/old-session.md'] ?? ''
    expect(written).toContain('**PRIORITY:')
    expect(written).toContain('Do the PRIORITY request and nothing else.')
    expect(written.indexOf('**PRIORITY:')).toBeLessThan(written.indexOf('## Session Handoff Brief'))
  })

  test('the brief template file sets the sections Haiku is asked for', async ($, on) => {
    const files = { '/home/test/.claude/auto-handoff/brief.md': 'Write only:\n\n## Mood\nHow it went.' }
    const calls = engine(on, { tokens: 165_000, files, brief: '## Mood\nGood.' })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(calls.prompts[0]).toContain('## Mood\nHow it went.')
    expect(calls.prompts[0]).not.toContain('## Dead Ends')
    // Valid against the custom template, so Haiku's text is kept.
    expect(calls.written['/home/test/.claude/state/auto-handoff/old-session.md']).toContain('## Mood\nGood.')
  })

  test('the instructions template file replaces the instructions', { options: { instructionsTemplate: '/custom/i.md' } }, async ($, on) => {
    const calls = engine(on, { tokens: 165_000, files: { '/custom/i.md': '## Rules\nJust keep going.' } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const brief = parseBrief(calls.written['/home/test/.claude/state/auto-handoff/old-session.md'] ?? '').body
    expect(brief.startsWith('## Rules\nJust keep going.')).toBe(true)
  })

  test('a new session writes missing templates and leaves existing ones alone', async ($, on) => {
    const calls = engine(on, { tokens: 1_000, files: { '/home/test/.claude/auto-handoff/brief.md': 'mine' } })
    await $.classic.SessionStart({ source: 'startup' })
    expect(Object.keys(calls.written)).toEqual(['/home/test/.claude/auto-handoff/instructions.md'])
    expect(calls.written['/home/test/.claude/auto-handoff/instructions.md']).toContain('{{#priority}}')
  })

  test('renderTemplate keeps the branch that matches the flag', async () => {
    const t = 'A\n{{#priority}}P{{/priority}}{{^priority}}N{{/priority}}\nB'
    expect(renderTemplate(t, { priority: true })).toBe('A\nP\nB')
    expect(renderTemplate(t, { priority: false })).toBe('A\nN\nB')
  })

  test('hasUnansweredLastRequest reads only the last-request section', async () => {
    expect(hasUnansweredLastRequest('## Last Request from the User\n"x"\nStatus: Not answered')).toBe(true)
    expect(hasUnansweredLastRequest('## Last Request from the User\n"x"\nStatus: Answered')).toBe(false)
    expect(hasUnansweredLastRequest('## Last Request from the User\nStatus: Answered\n\n## Open Questions\nStatus: Not answered')).toBe(false)
    expect(hasUnansweredLastRequest('## Last Request from the User\nNo user message found. Status: Not answered')).toBe(false)
    expect(hasUnansweredLastRequest('## Next Step\nStatus: Not answered')).toBe(false)
  })

  test('the brief carries the transcript path, verify block and facts', async ($, on) => {
    const messages = [
      msg('user', 'fix #846 please'),
      msg('assistant', 'committing', [edit('/repo/mod.ts', 'Write'), bash("git commit -m 'feat: x'", '[main 47edd8e] feat(mods): auto-handoff\n 2 files changed')]),
    ]
    const calls = engine(on, { tokens: 190_000, messages })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const brief = calls.written['/home/test/.claude/state/auto-handoff/old-session.md']
    expect(brief).toContain('`~/.claude/projects/-home-test-proj/old-session.jsonl`')
    expect(brief).toContain('## How to Use This Brief')
    expect(brief).toContain('Finish the parser refactor')
    expect(brief).toContain('- feat(mods): auto-handoff (47edd8e)')
    expect(brief).not.toContain('## Last Real User Message') // Haiku's section quotes it; no duplicate
    const prompt = calls.prompts[0] ?? ''
    expect(prompt).toContain('- /repo/mod.ts')
    expect(prompt).toContain('## Questions Answered')
    expect(prompt.indexOf('## Extracted Facts')).toBeLessThan(prompt.indexOf('## Next Step'))
  })

  test('a /clear from the user without a pending handoff seeds nothing', async ($, on) => {
    const calls = engine(on, { tokens: 1_000 })
    await $.classic.SessionStart({ source: 'clear' })
    expect(calls.seeded.length).toBe(0)
  })

  test('a seeded session that starts above the threshold does not loop', async ($, on) => {
    // The 2026-10-03 live run: threshold 20k, every fresh session started at ~31k.
    const calls = engine(on, { tokens: 31_000, env: { AUTO_HANDOFF_TOKENS: '20000' } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    await $.turn.complete(TURN) // the seed turn: sets the floor
    await $.turn.complete(TURN) // still ~31k: below floor + growth (a quarter of the threshold)
    await settle(() => false)
    expect(calls.cleared).toBe(1)

    calls.tokens = 90_000 // grew 59k past the floor
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 1)
    expect(calls.cleared).toBe(2)
  })

  test('a seeded session measures its floor at its first request, not at the end of its first turn', async ($, on) => {
    // Seen live: the seed turn read the whole mod and ran the suite three times, 47k to 129k,
    // with the pre-request check off; the floor landed at 129k and the next handoff moved out to 179k.
    const calls = engine(on, { tokens: 165_000, stepUsage: true, toolChars: 560_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)

    calls.tokens = 47_000 // the fresh session, brief and CLAUDE.md loaded
    await step($, 0) // the seed turn's first request: this is the floor
    expect(calls.steps).toBe(1)
    await $.tool.call({ tool: 'Read', file_path: '/big.txt' }) // ~140k of reads land in the same turn
    const chunks = await step($, 1)
    expect(calls.steps).toBe(1) // stopped before the request that would carry 187k
    expect(chunks.some(c => c.kind === 'text' && c.text?.includes('auto-handoff'))).toBe(true)
    await settle(() => calls.cleared > 1)
    expect(calls.cleared).toBe(2)
  })

  // Hand off once per round with no typed prompt between rounds; growth clears the floor each time.
  async function unattendedRounds($: Parameters<TestBody>[0], calls: Calls, rounds: number) {
    for (let i = 0; i < rounds; i++) {
      const before = calls.cleared
      await $.turn.complete(TURN)
      await settle(() => calls.cleared > before)
      if (calls.cleared === before) return
      await $.classic.SessionStart({ source: 'clear' })
      await settle(() => calls.seeded.length >= calls.cleared)
      await $.turn.complete(TURN) // seed turn sets the floor
      calls.tokens += 60_000
    }
  }

  test('progress guard: no more than two handoffs without a typed prompt', async ($, on) => {
    const calls = engine(on, { tokens: 31_000, env: { AUTO_HANDOFF_TOKENS: '20000' } })
    await unattendedRounds($, calls, 4)
    await settle(() => false)
    expect(calls.cleared).toBe(2)
  })

  test('maxConsecutiveHandoffs sets the progress guard', { options: { maxConsecutiveHandoffs: 1 } }, async ($, on) => {
    const calls = engine(on, { tokens: 31_000, env: { AUTO_HANDOFF_TOKENS: '20000' } })
    await unattendedRounds($, calls, 3)
    await settle(() => false)
    expect(calls.cleared).toBe(1)
  })

  test('a seeded session gets 40k of headroom above its floor, not a config field', { options: { headroom: 1_000_000, growth: 1_000_000 } }, async ($, on) => {
    const calls = engine(on, { tokens: 120_000, env: { AUTO_HANDOFF_TOKENS: '100000' } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 90_000 // floor 90k: the line moves to 130k
    await $.turn.complete(TURN) // seed turn sets the floor
    calls.tokens = 125_000
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.cleared).toBe(1) // 125k: past the 100k threshold, short of floor + 40k
    calls.tokens = 131_000
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 1)
    expect(calls.cleared).toBe(2) // the ignored options did not hold it off
  })

  test('a threshold too close to the floor is raised, and the panel names the env var', async ($, on) => {
    // The 2026-10-04 live run: AUTO_HANDOFF_TOKENS=80000 left in a shell, seeded sessions start at
    // ~45k. max(80k, 45k + 20k) was 80k, so each seeded session handed off after ~35k of work: eight times.
    const calls = engine(on, { tokens: 85_000, env: { AUTO_HANDOFF_TOKENS: '80000' } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 45_000
    await $.turn.complete(TURN) // seed turn sets the floor: 35k of headroom, under the 40k minimum
    const warning = "threshold 80k (AUTO_HANDOFF_TOKENS) leaves 35k this session's 45k start: handing off at 85k instead"
    expect(await band($)).toContain(`⚠ ${warning}`)
    calls.tokens = 81_000 // past 80k; the old math handed off here
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.cleared).toBe(1)
    expect((await band($)).split(warning).length - 1).toBe(1) // warned once, not every turn
    calls.tokens = 86_000 // floor + 40k
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 1)
    expect(calls.cleared).toBe(2)
  })

  test('the headroom warning names /config when the threshold field is the source', { options: { threshold: 60_000 } }, async ($, on) => {
    const calls = engine(on, { tokens: 65_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 45_000
    await $.turn.complete(TURN)
    expect(await band($)).toContain('(threshold in /config)')
  })

  test('no headroom warning at the default threshold', async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 45_000
    await $.turn.complete(TURN)
    expect(await band($)).not.toContain('threshold')
  })

  test('progress guard: a typed prompt resumes handoffs', async ($, on) => {
    const calls = engine(on, { tokens: 31_000, env: { AUTO_HANDOFF_TOKENS: '20000' } })
    await unattendedRounds($, calls, 3)
    expect(calls.cleared).toBe(2)
    await $.prompt.submit({ text: 'keep going', origin: { kind: 'composer' } } as never)
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 2)
    expect(calls.cleared).toBe(3)
  })

  test('progress guard: a plugin or notification prompt is not progress', async ($, on) => {
    const calls = engine(on, { tokens: 31_000, env: { AUTO_HANDOFF_TOKENS: '20000' } })
    await unattendedRounds($, calls, 3)
    await $.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin', name: 'other' } } as never)
    await $.prompt.submit({ text: 'task done', origin: { kind: 'task-notification' } } as never)
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.cleared).toBe(2)
  })

  test('a turn whose tool output would cross the threshold stops before the next request', async ($, on) => {
    // The 2026-10-03 case: measured 63k, then reads worth ~140k land in one turn.
    const calls = engine(on, { tokens: 63_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, toolChars: 560_000 })
    await $.tool.call({ tool: 'Read', file_path: '/big.txt' })
    const chunks = await step($)
    expect(calls.steps).toBe(0)
    expect(chunks.some(c => c.kind === 'text' && c.text?.includes('auto-handoff'))).toBe(true)
    await settle(() => calls.cleared > 0)
    expect(calls.completes).toBe(1)
    expect(calls.cleared).toBe(1)
  })

  test('tool output that lands while the response streams still counts', async ($, on) => {
    // Seen live: eight reads ran mid-stream, then the stream's end zeroed the count.
    const calls = engine(on, { tokens: 61_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, streamToolChars: 400_000 })
    const stream = $.turn.step({ ...STEP, index: 1 })[Symbol.asyncIterator]()
    await stream.next() // the response is still streaming
    await $.tool.call({ tool: 'Read', file_path: '/streamed.txt' }) // core runs the tool now
    while (!(await stream.next()).done) {}
    expect(calls.steps).toBe(1)
    const chunks = await step($, 2)
    expect(calls.steps).toBe(1)
    expect(chunks.some(c => c.kind === 'text' && c.text?.includes('auto-handoff'))).toBe(true)
  })

  test('auto-compact is replaced by a handoff', async ($, on) => {
    const calls = engine(on, { tokens: 174_000, env: { AUTO_HANDOFF_TOKENS: '80000' } })
    const r = await $.session.compact({ trigger: 'auto', messages: BASIC })
    expect(r.skip).toContain('auto-handoff')
    expect(calls.compacts).toBe(0)
    await settle(() => calls.cleared > 0)
    expect(calls.cleared).toBe(1)
  })

  test('a manual /compact is left alone', async ($, on) => {
    const calls = engine(on, { tokens: 174_000, env: { AUTO_HANDOFF_TOKENS: '80000' } })
    await $.session.compact({ trigger: 'manual', messages: BASIC })
    expect(calls.compacts).toBe(1)
    expect(calls.completes).toBe(0)
  })

  test('auto-compact goes ahead when the kill switch is set', async ($, on) => {
    const calls = engine(on, { tokens: 174_000, env: { AUTO_HANDOFF_TOKENS: '80000', AUTO_HANDOFF_DISABLE: 'x' } })
    await $.session.compact({ trigger: 'auto', messages: BASIC })
    expect(calls.compacts).toBe(1)
    expect(calls.cleared).toBe(0)
  })

  test('small tool output under the threshold lets the request through', async ($, on) => {
    const calls = engine(on, { tokens: 63_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, toolChars: 20_000 })
    await $.tool.call({ tool: 'Read', file_path: '/small.txt' })
    await step($)
    expect(calls.steps).toBe(1)
    expect(calls.completes).toBe(0)
  })

  test('the first request of a turn is never stopped', async ($, on) => {
    const calls = engine(on, { tokens: 63_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, toolChars: 560_000 })
    await $.tool.call({ tool: 'Read', file_path: '/big.txt' })
    await step($, 0)
    expect(calls.steps).toBe(1)
  })

  test('a stale briefing marker from a mid-handoff reload is retried', async ($, on) => {
    // Seen live: threshold fired, the mod reloaded 71 ms later, the marker stayed at 'briefing'.
    const calls = engine(on, { tokens: 165_000, store: { 'fired:old-session': 'briefing' } })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(calls.completes).toBe(1)
    expect(calls.cleared).toBe(1)
  })

  test('a clearing or seeded marker still means fired once', async ($, on) => {
    const calls = engine(on, { tokens: 165_000, store: { 'fired:old-session': 'seeded:new-session-1' } })
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.completes).toBe(0)
  })

  test('the panel above the prompt walks the handoff, then collapses', async ($, on) => {
    const calls = engine(on, { tokens: 165_000, stepUsage: true })
    expect(await band($)).toBe('')
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    const clearing = await band($)
    expect(clearing).toContain('auto-handoff · 165k / 160k')
    expect(clearing).toContain('✓ brief written')
    expect(clearing).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] clearing/)
    await clock.advance(100)
    expect(await band($)).not.toBe(clearing) // the spinner moved

    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    expect(await band($)).toContain('✓ cleared')
    expect(await band($)).toContain('starting the fresh session')

    calls.tokens = 47_000
    await step($, 0) // the seed turn's first request
    const done = await band($)
    expect(done).toContain('✓ handed off · 165k → 47k')
    expect(done).toContain('[open brief](http://127.0.0.1:3846/old-sess)')
    expect(done).not.toContain('Dismiss')
    await clock.advance(10_000)
    expect(await band($)).toBe('')
    expect(calls.toasts).toEqual([])
  })

  test('on the mobile app, which draws no band, the key moments go out as toasts', async ($, on) => {
    const calls = engine(on, { tokens: 165_000, stepUsage: true, surfaces: ['terminal', 'mobile'] })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await settle(() => calls.toasts.length > 0)
    expect(calls.toasts).toEqual(['context 165k is past 160k: handing off'])
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 47_000
    await step($, 0)
    await settle(() => calls.toasts.length > 1)
    expect(calls.toasts).toEqual(['context 165k is past 160k: handing off', '↪ handed off · 165k → 47k'])
  })

  test('a facts-only brief stays on the panel until dismissed', async ($, on) => {
    const calls = engine(on, { tokens: 165_000, stepUsage: true, brief: null })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(await band($)).toContain('⚠ brief is facts only: the summary failed (empty-reply)')
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 47_000
    await step($, 0)
    await clock.advance(10_000)
    const ui = await mountBand($)
    expect(textOf(await ui.drawn())).toContain('⚠ brief is facts only')
    await ui.press({ key: 'dismiss' })
    expect(textOf(await ui.drawn())).toBe('')
    await ui.unmount()
  })

  test('past the threshold, tool calls are refused before they run', async ($, on) => {
    // Seen live: ~28 reads in one step took the session from 67k to 437k.
    const calls = engine(on, { tokens: 67_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, toolChars: 220_000 })
    const results = []
    for (let i = 0; i < 28; i++) results.push(await $.tool.call({ tool: 'Read', file_path: `/export-${i}.txt` }))
    expect(calls.ran).toBe(1) // 67k + 55k crosses 80k after the first read
    expect(results.slice(1).every(r => 'deny' in r && r.deny?.includes('[auto-handoff] Not run'))).toBe(true)
    expect(calls.cleared).toBe(0) // the refusal does not hand off by itself

    await step($)
    expect(calls.steps).toBe(0) // the next request is stopped, under the window, and the handoff runs
    await settle(() => calls.cleared > 0)
    expect(calls.cleared).toBe(1)
    expect(calls.compacts).toBe(0)
  })

  test('a refused tool call hands off at turn end even when the real size comes in under the threshold', async ($, on) => {
    // Seen live: the gate projected 83.7k, the response measured 72.5k, and the session stopped with no handoff.
    const calls = engine(on, { tokens: 67_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, toolChars: 220_000 })
    await $.tool.call({ tool: 'Read', file_path: '/a.txt' })
    const refused = await $.tool.call({ tool: 'Read', file_path: '/b.txt' })
    expect('deny' in refused && refused.deny?.includes('[auto-handoff] Not run')).toBe(true)
    calls.tokens = 72_500
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    expect(calls.cleared).toBe(1)
  })

  test('a refused tool call hands off at the next request, and the stop line does not claim a size under the threshold', async ($, on) => {
    const calls = engine(on, { tokens: 84_000, env: { AUTO_HANDOFF_TOKENS: '80000' } })
    const refused = await $.tool.call({ tool: 'Read', file_path: '/a.txt' })
    expect('deny' in refused).toBe(true)
    calls.tokens = 72_500 // the next measurement comes in under the threshold
    const chunks = await step($)
    expect(calls.steps).toBe(0)
    const text = chunks.map(c => c.text ?? '').join('')
    expect(text).toContain('A tool call was refused at the handoff threshold (80k)')
    expect(text).not.toContain('would carry')
    await settle(() => calls.cleared > 0)
    expect(calls.cleared).toBe(1)
  })

  test('without a refusal, a turn that ends under the threshold does not hand off', async ($, on) => {
    const calls = engine(on, { tokens: 67_000, env: { AUTO_HANDOFF_TOKENS: '80000' }, toolChars: 4_000 })
    await $.tool.call({ tool: 'Read', file_path: '/a.txt' })
    await $.turn.complete(TURN)
    await settle(() => false)
    expect(calls.cleared).toBe(0)
  })

  test("the person's own /clear dismisses the panel when no handoff is under way", async ($, on) => {
    const calls = engine(on, { tokens: 165_000, stepUsage: true, brief: null })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    calls.tokens = 47_000
    await step($, 0)
    await clock.advance(10_000)
    expect(await band($)).toContain('⚠ brief is facts only') // sticky
    await $.classic.SessionStart({ source: 'clear' })
    expect(await band($)).toBe('')
    expect(calls.seeded.length).toBe(1)
  })

  test('the handoff\'s own /clear keeps the panel', async ($, on) => {
    const calls = engine(on, { tokens: 165_000 })
    await $.turn.complete(TURN)
    await settle(() => calls.cleared > 0)
    await $.classic.SessionStart({ source: 'clear' })
    await settle(() => calls.seeded.length > 0)
    expect(await band($)).toContain('✓ cleared')
  })

  test('the tool gate never blocks a session the mod will not hand off', async ($, on) => {
    const calls = engine(on, { tokens: 165_000, env: { AUTO_HANDOFF_DISABLE: 'x' }, toolChars: 220_000 })
    await $.tool.call({ tool: 'Read', file_path: '/a.txt' })
    await $.tool.call({ tool: 'Read', file_path: '/b.txt' })
    expect(calls.ran).toBe(2)
  })

  test('the tool gate leaves subagents alone', async ($, on) => {
    const calls = engine(on, { tokens: 165_000, toolChars: 220_000 })
    await $.tool.call({ tool: 'Read', file_path: '/a.txt', agentId: 'sub-1' } as never)
    expect(calls.ran).toBe(1)
  })

  test('the pre-request check honours the kill switch', async ($, on) => {
    const calls = engine(on, { tokens: 63_000, env: { AUTO_HANDOFF_TOKENS: '80000', AUTO_HANDOFF_DISABLE: 'x' }, toolChars: 560_000 })
    await $.tool.call({ tool: 'Read', file_path: '/big.txt' })
    await step($)
    expect(calls.steps).toBe(1)
    expect(calls.completes).toBe(0)
  })
})

describe('extractFacts', () => {
  test('heredoc commit messages count when git output is not in yet', async () => {
    const f = extractFacts([msg('assistant', '', [bash("git add x && git commit -F - <<'EOF'\nfix(mods): loop guard\n\nWHY: chained six times\nEOF")])])
    expect(f.commits).toEqual(['fix(mods): loop guard'])
  })

  test('git output wins, and a commit that did not land is dropped', async () => {
    const f = extractFacts([msg('assistant', '', [
      bash('git commit -m "first"', '[main abc1234] first real subject\n 1 file changed'),
      bash('git commit -m "second"', 'nothing to commit, working tree clean'),
      bash('git commit -m "third"', 'hook rejected', true),
    ])])
    expect(f.commits).toEqual(['first real subject (abc1234)'])
  })

  test('files matching ignoreFiles are excluded; real edits are kept', async () => {
    const ignore = /(?:-state\.json|\/cache\/.*\.json)$/
    const f = extractFacts([msg('assistant', '', [
      edit('/a/data/favorites-state.json', 'Write'),
      edit('/a/data/cache/feed.json', 'Write'),
      edit('/a/notes/meeting.md'),
      edit('/a/src/brief.ts', 'Write'),
    ])], ignore)
    expect(f.filesModified).toEqual(['/a/notes/meeting.md', '/a/src/brief.ts'])
  })

  test('harness signals are never the last real request', async () => {
    const f = extractFacts([
      msg('user', 'Port all five gaps into the mod'),
      msg('user', 'Stop hook feedback: reply promises a check-back'),
      msg('user', '[Automatic handoff] The previous session reached its context limit.'),
      msg('user', '[auto-handoff] The previous session (x) reached its context limit'),
      msg('user', '', []),
    ])
    expect(f.lastUserMessage).toBe('Port all five gaps into the mod')
  })

  test('issue numbers come from the user and the assistant, not from tool noise', async () => {
    const f = extractFacts([msg('user', 'work #846'), msg('assistant', 'see #761 and color #fff', [bash('echo "#9999"')])])
    expect(f.issues).toEqual(['#846', '#761'])
  })

  test('brief validation needs at least one expected section', async () => {
    const template = '## Work in Progress\nWhat was happening.\n\n## Next Step\nThe next action.'
    expect(isValidBrief('## Next Step\nGo.', template)).toBe(true)
    expect(isValidBrief('Sure! Here is a summary.', template)).toBe(false)
  })
})
