import { describe, expect, test } from 'claude-code/testing'
import { chainOf, parseBrief, renderPage, sections, viewerLink, withHeader } from '../hooks/viewer.ts'
import { SERVER_JS } from '../hooks/server.ts'

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

  test('viewerLink is the short served link, or the local file with no server', () => {
    expect(viewerLink({ host: '100.64.0.1', port: '3846' }, '/pages', 'abc12345')).toBe('http://100.64.0.1:3846/abc12345')
    expect(viewerLink(undefined, '/pages', 'abc12345')).toBe('file:///pages/abc12345.html')
    // A compacted segment's page: its _<n> stays in the short link.
    expect(viewerLink({ host: '100.64.0.1', port: '3846' }, '/pages', 'abc12345-0000-4000_2')).toBe('http://100.64.0.1:3846/abc12345_2')
  })

  test('renderPage links the chain and escapes a brief that tries to close the script tag', () => {
    const a = { id: 'aaaaaaaa-1', header: { chain: 'aaaaaaaa-1', at: '2026-10-04T00:00:00Z', to: 'bbbbbbbb-2' }, body: '## Work in Progress\nFirst.' }
    const b = { id: 'bbbbbbbb-2', header: { chain: 'aaaaaaaa-1', from: 'aaaaaaaa-1', at: '2026-10-04T01:00:00Z' }, body: '## Next Step\n</script><b>x</b>' }
    const page = renderPage(b, [a, b])
    expect(page).toContain('href="aaaaaaaa-1.html"')
    expect(page).toContain('Handoff Chain')
    expect(page).not.toContain('</script><b>')
  })

  test('previous and next follow the chain, even where a header lost its from', () => {
    const e = (id: string, at: string, header: Record<string, string>) => ({ id, header: { at, ...header }, body: '' })
    const a = e('aaaaaaaa-1', '1', { to: 'bbbbbbbb-2' })
    const b = e('bbbbbbbb-2', '2', { to: 'cccccccc-3' }) // a reload dropped its from
    const c = e('cccccccc-3', '3', { from: 'bbbbbbbb-2', to: 'dddddddd-4' })
    const mid = renderPage(b, [a, b, c])
    expect(mid).toContain('<a href="aaaaaaaa-1.html">← previous</a>')
    expect(mid).toContain('<a href="cccccccc-3.html">next →</a>')
    const last = renderPage(c, [a, b, c])
    expect(last).toContain('next: dddddddd, still running')
    expect(last).not.toContain('href="dddddddd-4.html"')
    expect(renderPage(a, [a, b, c])).not.toContain('← previous')
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

  test('chainOf joins a run whose chain id broke partway, through from/to links', () => {
    const e = (id: string, at: string, header: Record<string, string>) => ({ id, header: { at, ...header }, body: '' })
    const entries = [
      e('a', '1', { chain: 'a', to: 'b' }),
      e('b', '2', { chain: 'a', from: 'a', to: 'c' }),
      e('c', '3', { chain: 'c', to: 'd' }), // the reload lost its from
      e('d', '4', { chain: 'c', from: 'c' }),
      e('x', '5', { chain: 'x' }),
    ]
    expect(chainOf(entries, 'd').map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(chainOf(entries, 'a').map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(chainOf(entries, 'x').map(x => x.id)).toEqual(['x'])
  })

  // A second session finds the port taken. Its child used to die with an unhandled EADDRINUSE
  // stack trace in the log; it now says so in one line and exits 0. (Run live: see the 0.8.2 commit.)
  test('the server exits quietly when the port is taken', () => {
    expect(SERVER_JS).toContain("err.code === 'EADDRINUSE'")
    expect(SERVER_JS).toContain('process.exit(0)')
    expect(SERVER_JS.indexOf(".on('error'")).toBeLessThan(SERVER_JS.indexOf('.listen('))
  })
})
