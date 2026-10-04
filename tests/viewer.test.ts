import { describe, expect, test } from 'claude-code/testing'
import { parseBrief, renderPage, sections, viewerLink, withHeader } from '../hooks/viewer.ts'

describe('viewer', () => {
  test('parseBrief extracts header and body', () => {
    const brief = `---
from: abc123
to: def456
chain: main-chain
tokens: 150000
at: 2026-10-04T12:00:00Z
cwd: /home/user/project
---
## Work in Progress
Building the viewer.

## Next Step
Test it.`
    const { header, body } = parseBrief(brief)
    expect(header.from).toBe('abc123')
    expect(header.chain).toBe('main-chain')
    expect(body).toContain('## Work in Progress')
  })

  test('parseBrief handles briefs with no header', () => {
    const brief = `## Work in Progress\nDoing stuff`
    const { header, body } = parseBrief(brief)
    expect(header).toEqual({})
    expect(body).toBe(brief)
  })

  test('withHeader round-trips a brief', () => {
    const header = { from: 'abc', to: 'def', tokens: '150000' }
    const body = '## Work\nStuff'
    const result = withHeader(header, body)
    const { header: h2, body: b2 } = parseBrief(result)
    expect(h2.from).toBe('abc')
    expect(h2.to).toBe('def')
    expect(b2).toBe(body)
  })

  test('viewerLink is the served page, or the local file with no server', () => {
    expect(viewerLink({ host: '100.64.0.1', port: '3846' }, '/pages', 'abc12345')).toBe('http://100.64.0.1:3846/abc12345.html')
    expect(viewerLink(undefined, '/pages', 'abc12345')).toBe('file:///pages/abc12345.html')
  })

  test('renderPage links the chain and escapes a brief that tries to close the script tag', () => {
    const a = { id: 'aaaaaaaa-1', header: { chain: 'aaaaaaaa-1', at: '2026-10-04T00:00:00Z', to: 'bbbbbbbb-2' }, body: '## Work in Progress\nFirst.' }
    const b = { id: 'bbbbbbbb-2', header: { chain: 'aaaaaaaa-1', from: 'aaaaaaaa-1', at: '2026-10-04T01:00:00Z' }, body: '## Next Step\n</script><b>x</b>' }
    const page = renderPage(b, [a, b])
    expect(page).toContain('href="aaaaaaaa-1.html"')
    expect(page).toContain('Handoff Chain')
    expect(page).not.toContain('</script><b>')
  })

  test('sections extracts visible sections', () => {
    const body = `## Work in Progress
Doing X

## Instructions
Don't read this

## Next Step
Do Y

## How to Use This Brief
Also don't read`
    const visible = sections(body)
    expect(visible.length).toBe(2)
    expect(visible[0]).toContain('Work in Progress')
    expect(visible[1]).toContain('Next Step')
  })
})
