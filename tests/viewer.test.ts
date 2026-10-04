import { describe, expect, test } from 'claude-code/testing'
import { parseBrief, withHeader, viewerLink, parseServe, sections } from '../hooks/viewer.ts'

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

  test('viewerLink formats the URL correctly', () => {
    const url = viewerLink('http://example.com/{sessionId}', '', '', 'abc12345')
    expect(url).toBe('http://example.com/abc12345')
  })

  test('viewerLink defaults to tailscale serve address', () => {
    const url = viewerLink('', '100.85.122.99:3846', '/pages', 'abc12345')
    expect(url).toBe('http://100.85.122.99:3846/abc12345.html')
  })

  test('parseServe validates host:port', () => {
    const result = parseServe('100.85.122.99:3846')
    expect(result).toEqual({ host: '100.85.122.99', port: '3846' })

    const ipv6 = parseServe('[::1]:3000')
    expect(ipv6).toEqual({ host: '::1', port: '3000' })

    const bad = parseServe('not-a-host')
    expect(bad).toBeUndefined()
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
