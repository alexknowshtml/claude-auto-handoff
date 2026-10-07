import { describe, expect, test } from 'claude-code/testing'
import { assembleBrief, briefPrompt } from '../hooks/brief.ts'
import { parseTokens } from '../hooks/config.ts'
import { blockId, cover, historySection, oneParagraph, parseLog, parseTree, pending, renderHistory, repoRoot } from '../hooks/history.ts'
import type { Entry } from '../hooks/history.ts'

const NO_FACTS = { filesModified: [], commits: [], issues: [] }
const entries = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({
  at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`, session: `s${i}`.padEnd(8, 'x'), text: `entry ${i}`,
}))

describe('history', () => {
  test('cover tiles the whole log in aligned blocks, within the budget, finest at the present', () => {
    for (const T of [1, 5, 24, 25, 100, 1000, 4096]) {
      const blocks = cover(T, 24)
      expect(blocks.length <= 24).toBe(true)
      expect(blocks[0]![0]).toBe(0)
      expect(blocks.at(-1)![1]).toBe(T)
      for (let i = 1; i < blocks.length; i++) expect(blocks[i]![0]).toBe(blocks[i - 1]![1])
      for (const [lo, hi] of blocks) {
        const n = hi - lo
        expect(n & (n - 1)).toBe(0)
        expect(lo % n).toBe(0)
      }
      const size = (b: readonly [number, number]) => b[1] - b[0]
      expect(size(blocks.at(-1)!) <= size(blocks[0]!)).toBe(true)
    }
  })

  test('when everything fits, every entry is its own line', () => {
    expect(cover(5, 24)).toEqual([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]])
  })

  test('pending lists the buildable blocks smallest first, skipping built ones', () => {
    expect(pending(5, () => false).map(blockId)).toEqual(['0-1', '2-3', '0-3'])
    expect(pending(4, b => blockId(b) === '0-1').map(blockId)).toEqual(['2-3', '0-3'])
  })

  test('renderHistory shows a summary where the tree has one, its halves where it does not', () => {
    const log = entries(40)
    const all = Object.fromEntries(pending(40, () => false).map(b => [blockId(b), `summary ${blockId(b)}`]))
    const full = renderHistory(log, all, 24)
    expect(full.lines.length <= 24).toBe(true)
    expect(full.lines[0]).toMatch(/^#0-\d+ 2026-10-01\.\.2026-10-\d\d · summary 0-\d+$/)
    expect(full.lines.at(-1)).toBe('#39 2026-10-12 s39xxxxx · entry 39')
    // Nothing compressed yet: every entry whole, the oldest dropped past twice the budget.
    const none = renderHistory(entries(60), {}, 24)
    expect(none.lines.length).toBe(48)
    expect(none.omitted).toBe(12)
    expect(none.lines[0]).toBe('#12 2026-10-13 s12xxxxx · entry 12')
  })

  test('historySection is empty for a new project and names the log otherwise', () => {
    expect(historySection([], {}, 24, '/l')).toBe('')
    const s = historySection(entries(2), {}, 24, '/h/log.jsonl')
    expect(s.startsWith('## Project History\n')).toBe(true)
    expect(s).toContain('`/h/log.jsonl`')
    expect(s.endsWith('#1 2026-10-02 s1xxxxxx · entry 1')).toBe(true)
  })

  test('parseLog skips a torn line; parseTree reads junk as no summaries', () => {
    const good = JSON.stringify({ at: '2026-10-04T00:00:00Z', session: 'abc', text: 'did it' })
    expect(parseLog(`${good}\n{"at":"2026-10-0\n${good}\n`).length).toBe(2)
    expect(parseTree('not json')).toEqual({})
    expect(parseTree('{"0-1":"ok","2-3":7,"4-5":" "}')).toEqual({ '0-1': 'ok' })
  })

  test('oneParagraph folds lines and cuts to the limit', () => {
    expect(oneParagraph('a\n\nb  c')).toBe('a b c')
    expect(oneParagraph('x'.repeat(700)).length).toBe(600)
  })

  test('repoRoot reads git\'s common dir, so worktrees share one history', () => {
    expect(repoRoot('/Users/k/project/.git\n')).toBe('/Users/k/project')
    expect(repoRoot('/srv/bare.git')).toBe('/srv/bare.git')
    expect(repoRoot('')).toBe(undefined)
    expect(repoRoot('.git')).toBe(undefined)
  })

  test('parseTokens reads what /handoff takes', () => {
    expect(parseTokens('60k')).toBe(60_000)
    expect(parseTokens('1.5m')).toBe(1_500_000)
    expect(parseTokens('120000')).toBe(120_000)
    expect(parseTokens('soon')).toBe(undefined)
    expect(parseTokens('5')).toBe(undefined)
  })
})

describe('brief inputs', () => {
  test('Haiku reads each call with what it returned, long output cut in the middle', () => {
    const p = briefPrompt([{ role: 'assistant', text: 'checking', toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: { command: 'npm test' }, text: `${'a'.repeat(1000)}FAILED: 3 tests` }] }], NO_FACTS, 'TEMPLATE')
    expect(p).toContain('[tool Bash] {"command":"npm test"}\n  → aaa')
    expect(p).toContain(' […] ')
    expect(p).toContain('FAILED: 3 tests')
  })

  test('the previous brief rides along before the conversation, its headings a level down', () => {
    const p = briefPrompt([], NO_FACTS, 'TEMPLATE', '## Decisions Made\nUse the v2 API.')
    expect(p).toContain('### Decisions Made\nUse the v2 API.')
    expect(p.indexOf('## Previous Brief') < p.indexOf('## Conversation')).toBe(true)
    expect(briefPrompt([], NO_FACTS, 'TEMPLATE')).not.toContain('Previous Brief')
  })

  test('the brief sends the next session to no subagent, and ends with the history', () => {
    const b = assembleBrief({ sessionId: 's', transcript: 't', instructions: '## Instructions' }, NO_FACTS, '## Next Step\nGo.', '## Project History\n#0 x')
    expect(b).not.toContain('subagent')
    expect(b.endsWith('## Project History\n#0 x')).toBe(true)
  })
})
