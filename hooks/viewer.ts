// The handoff viewer: one self-contained HTML page per brief, written to a pages/ folder beside
// the briefs. Each brief starts with a small header (from, to, chain, tokens, at, cwd); briefs that
// share a chain id or a from/to link are one run of handoffs, and every page in a run lists all of them.
// The page renders the brief's markdown in the browser from a CDN, so the mod ships no packages.

export type Header = { from?: string; to?: string; chain?: string; tokens?: string; at?: string; cwd?: string; viewer?: string }
export type Entry = { id: string; header: Header; body: string }

const HEADER_KEYS = ['from', 'to', 'chain', 'tokens', 'at', 'cwd', 'viewer'] as const

/** Splits a brief into its header and body. A brief with no header is a chain of one. */
export function parseBrief(text: string): { header: Header; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { header: {}, body: text }
  const header: Header = {}
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (kv && (HEADER_KEYS as readonly string[]).includes(kv[1]!)) header[kv[1] as keyof Header] = kv[2]!.trim()
  }
  return { header, body: text.slice(m[0].length) }
}

export function withHeader(header: Header, body: string): string {
  const lines = HEADER_KEYS.filter(k => header[k] !== undefined).map(k => `${k}: ${header[k]}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

/** Every brief linked to id, oldest first. Briefs join through a shared chain id or a from/to
 * link, so a run whose chain id broke partway (a hot reload once dropped it) still reads as one. */
export function chainOf(entries: readonly Entry[], id: string): Entry[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const e of entries) {
    join(e.id, `chain:${e.header.chain || e.id}`)
    if (e.header.from) join(e.id, e.header.from)
    if (e.header.to) join(e.id, e.header.to)
  }
  const root = find(id)
  return entries.filter(e => find(e.id) === root).sort((a, b) => (a.header.at ?? '').localeCompare(b.header.at ?? ''))
}

/** The page's address: served when the mod runs a server, else the local file. */
export function viewerLink(serve: { host: string; port: string } | undefined, pagesDir: string, sessionId: string): string {
  return serve ? `http://${serve.host}:${serve.port}/${sessionId}.html` : `file://${pagesDir}/${sessionId}.html`
}

// Sections meant for the fresh session, not for a person reading the page.
const HIDDEN = new Set(['Instructions', 'How to Use This Brief'])

/** The brief's "## " sections, minus the ones written for the model. */
export function sections(body: string): string[] {
  return body.split(/^(?=## )/m).map(s => s.trim()).filter(s => s && !HIDDEN.has(/^## (.+)$/m.exec(s)?.[1]?.trim() ?? ''))
}

function oneLiner(body: string): string {
  const m = /## Work in Progress\s*\n+([\s\S]+?)(?:\n\n|\n##|$)/.exec(body)
  if (!m) return ''
  const s = m[1]!.replace(/\s+/g, ' ').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^\d+\.\s*|^-\s*/, '').trim()
  return s.length > 120 ? `${s.slice(0, 117)}…` : s
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const short = (id: string) => id.slice(0, 8)
const when = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}
const tokens = (t?: string) => (t && Number(t) ? ` · ${Math.round(Number(t) / 1000)}k` : '')
const chip = (id: string, current: boolean) => `<span class="chip${current ? ' on' : ''}" title="${esc(id)}">${esc(short(id))}</span>`

/** The page for one brief. chain is every brief in its chain, oldest first (the brief itself included). */
export function renderPage(entry: Entry, chain: readonly Entry[]): string {
  const ids = new Set(chain.map(e => e.id))
  const { header } = entry
  const link = (id: string | undefined, label: string) =>
    id && ids.has(id) ? `<a href="${esc(id)}.html">${label}</a>` : id ? `<span>${label}</span>` : ''
  const meta = [
    chip(entry.id, false),
    `<span>${esc(when(header.at))}${esc(tokens(header.tokens))}</span>`,
    header.cwd ? `<span>${esc(header.cwd)}</span>` : '',
    link(header.from !== entry.id ? header.from : undefined, '← previous'),
    // The brief's own session handed off to `to`; that page exists once `to` hands off too.
    header.to ? link(header.to, `→ ${esc(short(header.to))}`) : '',
  ].filter(Boolean).join('')
  const rows = chain.length > 1 ? chain.map((e, i) => {
    const current = e.id === entry.id
    const c = current ? chip(e.id, true) : `<a href="${esc(e.id)}.html">${chip(e.id, false)}</a>`
    const latest = i === chain.length - 1 ? '<span class="latest">latest</span>' : ''
    const wip = oneLiner(e.body)
    return `<div class="row"><div>${c}</div><div class="rowtext"><div><span class="when">${i + 1}. ${esc(when(e.header.at))}${esc(tokens(e.header.tokens))}</span>${latest}</div>${wip ? `<div class="wip">${esc(wip)}</div>` : ''}</div></div>`
  }).join('') : ''
  const history = rows ? `<div class="section"><h2>Handoff Chain</h2>${rows}</div>` : ''
  // JSON in a script tag: escape "<" so a brief can never close the tag.
  const data = JSON.stringify(sections(entry.body)).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Context ${esc(short(entry.id))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700&family=Fraunces:opsz,wght@9..144,400;9..144,700;9..144,900&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js"></script>
<style>
  :root { color-scheme: light; --paper: #F7F3ED; --ink: #1C1C1C; --red: #E63946; --blue: #457B9D; --green: #2A9D8F;
    --font-display: 'Fraunces', serif; --font-body: 'DM Sans', sans-serif; --font-mono: 'DM Mono', monospace; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-body); background: var(--ink); color: var(--ink); font-size: 16px; line-height: 1.7; -webkit-font-smoothing: antialiased; min-height: 100vh; }
  .card { max-width: 760px; margin: 0 auto; padding-bottom: 48px; }
  .header { background: var(--ink); padding: 28px 16px 24px; }
  .header h1 { font-family: var(--font-display); font-size: 1.5rem; font-weight: 900; color: var(--paper); margin: 0 0 8px; }
  .meta { font-family: var(--font-mono); font-size: 12px; color: rgba(247,243,237,0.5); display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: center; }
  .meta a { color: rgba(247,243,237,0.75); text-decoration: none; }
  .meta a:hover { color: var(--paper); }
  .meta .chip { background: rgba(247,243,237,0.1); color: rgba(247,243,237,0.7); }
  .chip { font-family: var(--font-mono); font-size: 11px; background: rgba(28,28,28,0.08); color: var(--ink); padding: 2px 7px; border-radius: 6px; white-space: nowrap; }
  .chip.on { background: var(--ink); color: var(--paper); }
  .section { background: var(--paper); padding: 24px 16px; border-bottom: 1px solid rgba(28,28,28,0.1); overflow-wrap: break-word; }
  @media (min-width: 600px) { .header, .section { padding-left: 32px; padding-right: 32px; } }
  .row { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(28,28,28,0.08); }
  .row a { text-decoration: none; }
  .rowtext { min-width: 0; flex: 1; }
  .when { font-size: 12px; color: #777; font-family: var(--font-mono); margin-right: 6px; }
  .latest { font-size: 10px; font-family: var(--font-mono); background: var(--green); color: #fff; padding: 1px 6px; border-radius: 4px; }
  .wip { font-size: 13px; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  h2 { font-family: var(--font-display); font-weight: 700; font-size: 1.35rem; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 2px solid var(--ink); line-height: 1.2; }
  h3 { font-family: var(--font-display); font-weight: 700; font-size: 1.05rem; color: var(--blue); margin: 16px 0 6px; }
  p { margin: 0 0 12px; } p:last-child { margin-bottom: 0; }
  code { font-family: var(--font-mono); background: rgba(28,28,28,0.07); padding: 1px 5px; border-radius: 3px; font-size: 0.85em; word-break: break-all; }
  pre { background: var(--ink); color: var(--paper); padding: 14px 18px; margin: 12px 0; font-size: 0.85em; white-space: pre-wrap; word-break: break-all; box-shadow: 4px 4px 0 var(--blue); }
  pre code { background: none; padding: 0; color: inherit; }
  ul, ol { padding-left: 20px; margin: 0 0 12px; } li { margin-bottom: 5px; line-height: 1.55; }
  li::marker { color: var(--red); } ol li::marker { color: var(--ink); }
  a { color: var(--blue); text-underline-offset: 2px; } a:hover { color: var(--red); }
  strong { font-weight: 600; }
</style>
</head>
<body>
<div class="card">
  <div class="header"><h1>↕ Session Context</h1><div class="meta">${meta}</div></div>
  ${history}
  <div id="brief"></div>
</div>
<script id="data" type="application/json">${data}</script>
<script>
  var parts = JSON.parse(document.getElementById('data').textContent), out = document.getElementById('brief');
  parts.forEach(function (md) {
    var div = document.createElement('div');
    div.className = 'section';
    if (window.marked && window.DOMPurify) div.innerHTML = DOMPurify.sanitize(marked.parse(md));
    else { var pre = document.createElement('pre'); pre.textContent = md; div.appendChild(pre); }
    out.appendChild(div);
  });
</script>
</body>
</html>
`
}
