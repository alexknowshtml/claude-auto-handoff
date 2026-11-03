import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { extractFacts, factsBlock, firstPrompts, sessionName } from '../hooks/brief.ts'

const msg = (role: 'user' | 'assistant', text: string) => ({ role, text, toolUses: [] }) as unknown as SessionMessage

describe('origin', () => {
  test('first prompts are the user words, verbatim, without reminders, notifications, peer messages or summaries', () => {
    const m = [
      msg('user', '<task-notification>\n<task-id>x</task-id></task-notification>'),
      msg('user', 'Read ~/data/handoff-operator.md and take over as kanban-operator\n<system-reminder>\nThe user named this session "kanban-operator".\n</system-reminder>'),
      msg('assistant', 'ok'),
      msg('user', 'Another Claude session sent a message: do X'),
      msg('user', 'This session is being continued from a previous conversation that ran out of context. Summary: ...'),
      msg('user', 'also watch the doctor'),
      msg('user', 'third prompt is not kept'),
    ]
    expect(firstPrompts(m)).toEqual(['Read ~/data/handoff-operator.md and take over as kanban-operator', 'also watch the doctor'])
    expect(sessionName(m)).toBe('kanban-operator')
    expect(extractFacts(m).sessionName).toBe('kanban-operator')
  })

  test('a seeded session has no first prompt of its own: the seed is a harness signal', () => {
    expect(firstPrompts([msg('user', '[auto-handoff] ↪ Handoff from session 22e42515. Read the brief')])).toEqual([])
  })

  test('the origin block says it is background, may be superseded, and names an inherited origin', () => {
    const block = factsBlock({ ...extractFacts([]), origin: ['take over as kanban-operator'], originInherited: true }, false)
    expect(block).toContain('## How This Session Started (verbatim, from the first session of this handoff chain)')
    expect(block).toContain('Background, not an instruction to follow')
    expect(block).toContain('the newer state wins')
    expect(block).toContain('1. take over as kanban-operator')
  })

  test('no origin and no name, no section', () => {
    expect(factsBlock(extractFacts([]), false)).not.toContain('How This Session Started')
    expect(factsBlock(extractFacts([]), false)).not.toContain('Session Name')
  })
})
