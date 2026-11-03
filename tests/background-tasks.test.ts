import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { backgroundTasks, extractFacts, factsBlock } from '../hooks/brief.ts'

type Tool = { tool: string; input: Record<string, unknown>; isError?: boolean }
const msg = (tools: Tool[]) => ({ role: 'assistant', text: '', toolUses: tools.map((t, i) => ({ tool_use_id: `t${i}`, ...t })) }) as unknown as SessionMessage
const monitor = (command: string, description: string) => ({ tool: 'Monitor', input: { command, description, timeout_ms: 1_800_000 } })

describe('background tasks', () => {
  test('monitors and background Bash, newest per command, inputs in full; errors and foreground skipped', () => {
    const watch = 'cd ~/work/board && node scripts/board.ts watch --heartbeat 0'
    const m = [msg([
      monitor(watch, 'old description'),
      monitor('tail -f daemon.log | grep doctor', 'doctor'),
      { tool: 'Bash', input: { command: 'npm test', run_in_background: true } },
      { tool: 'Bash', input: { command: 'ls' } },
      { tool: 'Monitor', input: { command: 'broken' }, isError: true },
      monitor(watch, 'board events'),
    ])]
    const tasks = backgroundTasks(m)
    expect(tasks).toHaveLength(3)
    expect(tasks[2]).toContain(watch)
    expect(tasks[2]).toContain('board events')
    expect(tasks.join()).not.toContain('old description')
    expect(tasks.join()).not.toContain('"ls"')
    expect(tasks.join()).not.toContain('broken')
    const block = factsBlock(extractFacts(m), false)
    expect(block).toContain('## Background Tasks Started This Session (exact inputs)')
    expect(block).toContain('re-arm with these exact inputs')
  })

  test('a long command is kept far past the 300-character tool summary', () => {
    const long = 'node -e ' + 'x'.repeat(900)
    expect(backgroundTasks([msg([monitor(long, 'filter')])])[0]).toContain(long)
  })

  test('none started, the section says so', () => {
    expect(factsBlock(extractFacts([]), false)).toContain('## Background Tasks Started This Session (exact inputs)\nStarted this session; they may have ended since. Check before re-arming, and re-arm with these exact inputs.\nNone.')
  })
})
