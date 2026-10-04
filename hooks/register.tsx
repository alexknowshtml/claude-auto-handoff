import type { EngineInterface, Register, Timer } from 'claude-code'
import { assembleBrief, briefPrompt, extractFacts, isValidBrief, markUnverifiedFigures } from './brief.ts'
import { chainOf, parseBrief, renderPage, viewerLink, withHeader } from './viewer.ts'
import type { Entry } from './viewer.ts'
import { SERVER_JS, parseAddress } from './server.ts'
import { isSpinning, panelTree } from './panel.tsx'
import type { Line, Panel } from './panel.tsx'

// At the token threshold, Haiku writes a handoff brief, the mod runs /clear, then seeds the
// fresh session with a pointer to the brief. Interactive terminal sessions only: where a
// wrapper pipes the session and owns the context limit (DISABLE_AUTO_COMPACT), the mod only logs.

const BRIEF_DIR = '.claude/state/auto-handoff'
// The two numbers are userConfig fields (plugin.json), set in /config. Defaults match the manifest.
// threshold: matches HANDOFF_ARM_TOKENS in context-warning.ts.
// MIN_HEADROOM and maxUnattended are loop guards. A seeded session must grow MIN_HEADROOM past its
// first-turn size (its floor) before it can hand off again, and at most maxUnattended handoffs may
// run before the user types a prompt. MIN_HEADROOM is fixed: seeded sessions start near 45k, so at
// the default threshold it never moves the line; it only matters when the threshold is set low.
// 40k is the empirical line where a seeded session can read its brief and still do real work. The
// 2026-10-03 live run (threshold 20k, seeded sessions start at ~31k) chained six times with no
// guard; the 2026-10-04 run (AUTO_HANDOFF_TOKENS=80000 left in a shell, floor ~45k) chained eight
// times with a guard of a quarter of the threshold, because max(80k, 45k + 20k) is still 80k, and
// 35k of room goes in reading the brief. Progress, not time: a 15-minute chain cap could block a
// real session that fills fast.
// The rest shape the brief: two template files and a pattern for files
// that never count as edits.
// viewer: where the mod serves the brief pages, "host:port"; "tailscale" as the host means this
// machine's Tailscale IP, or 127.0.0.1 without Tailscale. Blank: no server, and the link is the local file.
type Config = { threshold: number; maxUnattended: number; briefTemplate: string; instructionsTemplate: string; ignoreFiles?: RegExp; viewer: string }
const DEFAULTS: Config = { threshold: 160_000, maxUnattended: 2, briefTemplate: '~/.claude/auto-handoff/brief.md', instructionsTemplate: '~/.claude/auto-handoff/instructions.md', viewer: 'tailscale:3846' }
const MIN_HEADROOM = 40_000
// Each template's default, a file in the mod's templates/ folder.
const TEMPLATES = [['briefTemplate', 'brief.md'], ['instructionsTemplate', 'instructions.md']] as const
type TemplateKey = typeof TEMPLATES[number][0]
// Used only when the shipped default is unreadable too, so the fresh session still knows what to do.
const LAST_RESORT_INSTRUCTIONS = '## Instructions\n\nThis turn was triggered by the system, not by a user. Read this brief and continue the work it describes.'
let cfg: Config = DEFAULTS
// Origins the engine stamps on a prompt the person sent; the seed arrives as { kind: 'plugin' }.
const USER_ORIGINS = new Set(['composer', 'bridge'])
// Rough chars-per-token for tool output, used to project the next request's size.
const CHARS_PER_TOKEN = 4
// The panel above the prompt (panel.tsx) is the whole UI. No status entry: the host draws one
// as "⚠ auto-handoff:", which reads as an error.
const LOG = `~/${BRIEF_DIR}/auto-handoff.log`

// problem: why the brief is facts only, when Haiku's summary was unusable.
type Pending = { oldSession: string; briefPath: string; tokens: number; chain: string; link: string; problem?: string }

// The seed prompt's first characters; the render hook knows the seed row by them.
const SEED_PREFIX = '[auto-handoff] ↪ Handoff from session'
// The seed text with its brief path and viewer URL as markdown links. The path becomes a
// file: link labelled by its file name; the URL links to itself. Exported for the test.
export function linkify(text: string): string {
  return text
    .replace(/(?<=\bat )(\/\S+\.md)(?=[\s)]|$)/, (p) => `[${p.slice(p.lastIndexOf('/') + 1)}](file://${p})`)
    .replace(/(https?:\/\/[^\s)]+)/, (u) => `[${u}](${u})`)
}

const k = (n: number) => `${Math.round(n / 1000)}k`
const short = (sessionId: string) => sessionId.slice(0, 8)

// Module variables survive /clear; $.state does not.
let pending: Pending | undefined
let inFlight = false
let seededSession: string | undefined
let floor: number | undefined
let unattended = 0 // handoffs since the user last typed a prompt
let pausedSession: string | undefined
// The handoff the fresh session came from, until its first request is measured and shown on the panel.
let handedFrom: { session: string; tokens: number; link: string; problem?: string } | undefined
// The seeded session's place in its chain of handoffs, for its own brief's header. Also kept in
// the store as lineage:<session>, because a hot reload resets module variables: a session seeded
// before a reload would otherwise start a new chain when it hands off.
type Lineage = { from: string; chain: string; depth?: number }
let lineage: Lineage | undefined
// Tokens added since the last response measured the context: tool results and the
// response's own output. turn.complete alone missed a turn whose reads jumped from 63k
// straight past the window, because the request that would have measured it failed.
let unmeasured = 0
// The session whose tool call the gate refused. The refusal tells the model a handoff is coming,
// so one must follow even when the next response measures under the threshold: the gate counts
// tool output at CHARS_PER_TOKEN, which ran high in a live test (projected 83.7k, measured 72.5k)
// and left a session that stopped working with no handoff.
let gated: string | undefined
// From the latest SessionStart; /clear starts a new transcript file.
let transcriptPath: string | undefined

async function log($: EngineInterface, line: string) {
  try {
    const home = await $.env.get('HOME')
    await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', 'sh', `${new Date().toISOString()} ${line}`, `${home}/${BRIEF_DIR}/auto-handoff.log`])
  } catch {}
}

const expand = (path: string, home: string) => path.replace(/^~(?=\/|$)/, home)

const readText = async ($: EngineInterface, path: string) => {
  try {
    const text = await $.fs.read(path)
    if (typeof text === 'string' && text.trim()) return text
  } catch {}
  return undefined
}
const shipped = ($: EngineInterface, key: TemplateKey) => `${$.plugin.root}/templates/${TEMPLATES.find(t => t[0] === key)![1]}`

// The template file at its configured path, else the default the mod ships, else ''.
async function template($: EngineInterface, key: TemplateKey): Promise<string> {
  return await readText($, expand(cfg[key], await $.env.get('HOME') ?? '')) ?? await readText($, shipped($, key)) ?? ''
}

// A new session writes each template to its path if nothing is there yet, so the files exist
// to be edited. A file the user wrote is never touched.
async function writeMissingTemplates($: EngineInterface) {
  const home = await $.env.get('HOME') ?? ''
  for (const [key] of TEMPLATES) {
    const path = expand(cfg[key], home)
    try { await $.fs.read(path); continue } catch {}
    const text = await readText($, shipped($, key))
    if (!text) { await log($, `template default unreadable ${shipped($, key)}`); continue }
    try { await $.fs.write(path, text) } catch (err) { await log($, `template write failed ${path} ${String(err)}`) }
  }
}

// The viewer server's address: the Tailscale host resolved to this machine's IPv4, or localhost
// when Tailscale is missing, logged out or has no address, so the link still opens on this machine.
async function serveAddress($: EngineInterface): Promise<{ host: string; port: string } | undefined> {
  const addr = cfg.viewer ? parseAddress(cfg.viewer) : undefined
  if (!addr || addr.host !== 'tailscale') return addr
  const local = { host: '127.0.0.1', port: addr.port }
  try {
    const { exitCode, stdout } = await $.process.run(['tailscale', 'ip', '-4'])
    const ip = stdout.trim().split('\n')[0]?.trim()
    return exitCode === 0 && ip ? { host: ip, port: addr.port } : local
  } catch {
    return local
  }
}

let serving = false
// The address this module's server listens on. Links use it, so a session that started on
// localhost keeps handing out working links after Tailscale comes up.
let servedAt: { host: string; port: string } | undefined
let lastServeTry = 0
// Starts the server unless this module already runs one. The spawn loop is the child's life: it
// runs on after the caller returns and ends with the child or the module. A second session finds
// the port taken, its child exits, and the first session's server keeps serving the same folder.
function ensureServer($: EngineInterface, pagesDir: string, addr: { host: string; port: string }) {
  if (serving) return
  serving = true
  servedAt = addr
  void (async () => {
    try {
      for await (const { text } of $.process.spawn({ argv: ['node', '-e', SERVER_JS, pagesDir, addr.host, addr.port] })) await log($, text.trim())
    } catch (err) {
      await log($, `viewer server failed ${String(err)}`)
    } finally {
      serving = false
      servedAt = undefined
    }
  })()
}

// Keeps a server up for the session's life. Called on startup and after each turn, so a session
// whose mod was reloaded, or whose server exited, serves again. At most one try a minute: when
// another session holds the port, the child here exits at once.
async function keepServing($: EngineInterface) {
  if (serving || Date.now() - lastServeTry < 60_000 || await $.env.get('AUTO_HANDOFF_DISABLE')) return
  lastServeTry = Date.now()
  const addr = await serveAddress($)
  const home = await $.env.get('HOME')
  if (addr && home) ensureServer($, `${home}/${BRIEF_DIR}/pages`, addr)
}

/** Writes the page of every brief in sessionId's chain, so each page lists the whole chain. */
async function writeChainPages($: EngineInterface, briefDir: string, pagesDir: string, sessionId: string): Promise<void> {
  const own = await $.fs.read(`${briefDir}/${sessionId}.md`)
  if (typeof own !== 'string') return
  const all: Entry[] = []
  for (const f of await $.fs.list(briefDir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.md')) continue
    const id = f.name.slice(0, -3)
    try {
      const text = await $.fs.read(`${briefDir}/${f.name}`)
      if (typeof text !== 'string') continue
      const { header, body } = parseBrief(text)
      all.push({ id, header, body })
    } catch {}
  }
  const chain = chainOf(all, sessionId)
  for (const e of chain) await $.fs.write(`${pagesDir}/${e.id}.html`, renderPage(e, chain))
}

// Writes the pages for sessionId's chain and makes sure the server is up. Returns the page's
// link, or '' when the pages could not be written. Never throws: the viewer is not the handoff.
async function viewer($: EngineInterface, briefDir: string, pagesDir: string, sessionId: string): Promise<string> {
  try {
    await $.process.run(['mkdir', '-p', pagesDir])
    await writeChainPages($, briefDir, pagesDir, sessionId)
    const addr = await serveAddress($)
    if (addr) ensureServer($, pagesDir, addr)
    return viewerLink(servedAt ?? addr, pagesDir, sessionId)
  } catch (err) {
    await log($, `viewer error session=${sessionId} ${String(err)}`)
    return ''
  }
}

async function storedLineage($: EngineInterface, sessionId: string): Promise<Lineage | undefined> {
  try {
    const v = await $.store.get(`lineage:${sessionId}`) as Partial<Lineage> | undefined
    return typeof v?.from === 'string' && typeof v.chain === 'string' ? { from: v.from, chain: v.chain, depth: typeof v.depth === 'number' ? v.depth : undefined } : undefined
  } catch {
    return undefined
  }
}

async function handoff($: EngineInterface, sessionId: string, tokens: number, threshold: number) {
  try {
    const own = sessionId === seededSession && lineage ? lineage : await storedLineage($, sessionId)
    const messages = await $.session.messages()
    const facts = extractFacts(messages, cfg.ignoreFiles)
    const { base, source } = await configured($)
    facts.handoffTokens = tokens
    facts.threshold = threshold
    facts.thresholdSource = threshold > base ? `${source} (${k(base)}), raised to leave ${k(MIN_HEADROOM)} above the starting size` : source
    if (sessionId === seededSession && floor !== undefined) facts.seededSessionStartSize = floor
    facts.unattendedCount = unattended
    // A session with no lineage starts its chain. One seeded before depth existed stays unknown.
    const depth = own ? own.depth : 1
    if (depth !== undefined) facts.depth = depth
    const briefTemplate = await template($, 'briefTemplate')
    const result = await $.model.complete({
      model: 'haiku',
      system: 'You summarize coding sessions into precise handoff briefs.',
      prompt: briefPrompt(messages, facts, briefTemplate),
      maxTokens: 4_000,
      timeoutMs: 60_000,
    })
    // A failed, empty or sectionless reply falls back to the facts.
    const text = result.isAnswered ? result.text : ''
    const problem = !result.isAnswered ? result.reason : !text.trim() ? 'empty' : !isValidBrief(text, briefTemplate) ? 'no-sections' : undefined
    if (problem) await log($, `haiku brief unusable session=${sessionId} reason=${problem}; using facts-only brief`)
    const checked = markUnverifiedFigures(text, facts)
    if (!problem && checked.flagged.length) await log($, `brief figures not in Handoff Numbers session=${sessionId}: ${checked.flagged.join(', ')}`)
    const home = await $.env.get('HOME')
    const cwd = await $.session.cwd()
    const brief = assembleBrief({
      sessionId,
      // Claude Code keeps transcripts under the cwd with every non-alphanumeric character as '-'.
      transcript: transcriptPath ?? `~/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`,
      instructions: await template($, 'instructionsTemplate') || LAST_RESORT_INSTRUCTIONS,
    }, facts, problem ? undefined : checked.text)
    const briefDir = `${home}/${BRIEF_DIR}`
    const briefPath = `${briefDir}/${sessionId}.md`
    const pagesDir = `${briefDir}/pages`
    const chain = own?.chain ?? sessionId
    const header = { from: own?.from, chain, depth: depth !== undefined ? String(depth) : undefined, tokens: String(tokens), at: new Date().toISOString(), cwd }
    await $.fs.write(briefPath, withHeader(header, brief))
    const link = await viewer($, briefDir, pagesDir, sessionId)
    pending = { oldSession: sessionId, briefPath, tokens, chain, link, problem }
    steps($, [briefStep(problem), { mark: 'spin', text: 'clearing' }])
    await $.store.set(`fired:${sessionId}`, problem ? `clearing-facts-only:${problem}` : 'clearing')
    await log($, `brief written ${briefPath} (${brief.length} chars); queueing /clear`)
    $.command.run({ command: 'clear' }).catch(async (err: unknown) => {
      pending = undefined
      // fired stays 'clearing', so this session does not try again; it carries on as it is.
      failed($, '/clear was rejected', `this session keeps going; the brief is at ${briefPath}`)
      await log($, `clear rejected ${String(err)}`)
    })
  } catch (err) {
    pending = undefined
    // fired stays 'briefing', which tryHandoff treats as an orphan: the next turn tries again.
    failed($, 'no brief written', 'this session keeps going and tries again after the next turn')
    await log($, `handoff error session=${sessionId} ${String(err)}; no clear`)
  }
}

// Shared by turn.complete and turn.step: the fired, kill-switch and loop-guard checks, then
// the handoff itself. Returns true when a handoff started.
async function tryHandoff($: EngineInterface, sessionId: string, tokens: number, threshold: number, via: string): Promise<boolean> {
  const fired = await $.store.get(`fired:${sessionId}`)
  // Every caller checks inFlight first, so a 'briefing' marker seen here is an orphan: the
  // module reloaded mid-handoff and the brief never landed. Retry instead of going quiet.
  if (fired === 'briefing') await log($, `stale briefing marker session=${sessionId} (mod reloaded mid-handoff); retrying`)
  else if (fired) return false

  const pane = await paneVar($)
  if (pane) {
    await $.store.set(`fired:${sessionId}`, 'skipped-pane')
    await log($, `skip session=${sessionId} tokens=${tokens} reason=${pane} set`)
    return false
  }

  // Not marked fired: once the user types, the next turn can hand off.
  if (unattended >= cfg.maxUnattended) {
    if (pausedSession !== sessionId) {
      pausedSession = sessionId
      await log($, `loop guard session=${sessionId}: ${unattended} handoffs with no user prompt; paused until one`)
      showPanel($, { header: { mark: 'warn', text: `auto-handoff paused after ${unattended} handoffs in a row` }, steps: [{ mark: 'warn', text: 'send a message to resume' }], sticky: true },
        `paused after ${unattended} handoffs in a row: send a message to resume`)
    }
    return false
  }
  unattended++

  inFlight = true
  gated = undefined
  await $.store.set(`fired:${sessionId}`, 'briefing')
  await log($, `threshold session=${sessionId} tokens=${tokens} threshold=${threshold} via=${via}`)
  showPanel($, { header: { mark: 'spin', text: `auto-handoff · ${k(tokens)} / ${k(threshold)}` }, steps: [{ mark: 'spin', text: 'writing brief' }] },
    `context ${k(tokens)} is past ${k(threshold)}: handing off`)
  // Not awaited: the brief can take a while and /clear only runs once the session is idle.
  handoff($, sessionId, tokens, threshold).finally(() => { inFlight = false })
  return true
}

// Kill switches. AUTO_HANDOFF_DISABLE turns the mod off for one session. DISABLE_AUTO_COMPACT
// means something else owns the context limit (a wrapper that pipes the session, where /clear
// would break the pipe), so the mod stays out of its way too.
async function paneVar($: EngineInterface): Promise<string | undefined> {
  // Literal names: the host lists the variables a module reads.
  if (await $.env.get('AUTO_HANDOFF_DISABLE')) return 'AUTO_HANDOFF_DISABLE'
  if (await $.env.get('DISABLE_AUTO_COMPACT')) return 'DISABLE_AUTO_COMPACT'
  return undefined
}

// Whether tryHandoff would go ahead for this session. The tool gate refuses calls only then,
// so a session the mod will not hand off (pane, loop guard, already fired) is never blocked.
async function canHandOff($: EngineInterface, sessionId: string): Promise<boolean> {
  if (unattended >= cfg.maxUnattended || await paneVar($)) return false
  const fired = await $.store.get(`fired:${sessionId}`)
  return !fired || fired === 'briefing'
}

// The panel above the prompt. A module variable rather than $.state: $.state does not survive
// /clear, and the panel carries the handoff across it.
const FRAME_MS = 100 // the host redraws the band ten times a second at most
const DONE_MS = 10_000
let shown: Panel | undefined
let frame = 0
let spin: Timer | undefined
let collapse: Timer | undefined

// The band above the prompt is drawn on the terminal and desktop only. On the mobile app or in
// VS Code nothing shows it, so the moments that matter go out as a toast there too: the
// threshold tripping, the result, and anything that stays up until dismissed. Never per step.
const BAND_SURFACES = new Set(['terminal', 'desktop'])
async function toastOffBand($: EngineInterface, text: string) {
  try {
    if ((await $.session.surfaces()).some((s) => !BAND_SURFACES.has(s))) $.ui.toast(text, { timeoutMs: 30_000 })
  } catch (err) {
    await log($, `surfaces error ${String(err)}`)
  }
}

function showPanel($: EngineInterface, p: Panel, toast?: string) {
  if (toast) void toastOffBand($, toast)
  shown = p
  collapse?.cancel()
  collapse = undefined
  if (isSpinning(p)) {
    spin ??= $.clock.every(FRAME_MS, () => {
      frame++
      $.ui.invalidate('ui.render')
    })
  } else {
    spin?.cancel()
    spin = undefined
    if (!p.sticky) collapse = $.clock.after(DONE_MS, () => hidePanel($))
  }
  $.ui.invalidate('ui.render')
}

function hidePanel($: EngineInterface) {
  shown = undefined
  spin?.cancel()
  collapse?.cancel()
  spin = collapse = undefined
  $.ui.invalidate('ui.render')
}

// The steps under the panel's current header; a panel lost to a reload gets a plain one.
function steps($: EngineInterface, lines: Line[]) {
  showPanel($, { header: shown?.header ?? { mark: 'spin', text: 'auto-handoff' }, steps: lines })
}

// Adds a step to the panel on screen, or opens one under `header` when nothing is showing.
function addStep($: EngineInterface, step: Line, header: Line, sticky = false) {
  const p = shown ?? { header, steps: [] }
  showPanel($, { ...p, steps: [...p.steps, step], sticky: p.sticky || sticky }, step.mark === 'spin' || step.mark === 'done' ? undefined : step.text)
}

// A facts-only brief is the one quiet failure: the handoff works, but the brief is thin.
const briefStep = (problem?: string): Line => problem
  ? { mark: 'warn', text: `brief is facts only: the summary failed (${problem})` }
  : { mark: 'done', text: 'brief written' }

function failed($: EngineInterface, what: string, next: string) {
  showPanel($, { header: { mark: 'fail', text: `handoff failed: ${what}` }, steps: [{ mark: 'fail', text: next }, { mark: 'fail', text: `log: ${LOG}` }], sticky: true },
    `handoff failed: ${what}. ${next}`)
}

// The fresh session's first measurement: the panel's last step, which says the handoff worked.
// It collapses on its own unless the brief was facts only.
function showHandedOff($: EngineInterface, fresh: number) {
  if (!handedFrom) return
  const { tokens, link, problem } = handedFrom
  showPanel($, { header: { mark: 'done', text: `handed off · ${k(tokens)} → ${k(fresh)}` }, steps: problem ? [briefStep(problem)] : [], link: link || undefined, sticky: !!problem },
    `↪ handed off · ${k(tokens)} → ${k(fresh)}${problem ? ' · the brief is facts only' : ''}`)
  handedFrom = undefined
}

// The configured threshold and where it came from. The env var wins so a test run needs no
// /config change; it also outlives the test in that shell, which is why the headroom warning names it.
async function configured($: EngineInterface): Promise<{ base: number; source: string }> {
  const env = Number(await $.env.get('AUTO_HANDOFF_TOKENS'))
  return env > 0 ? { base: env, source: 'AUTO_HANDOFF_TOKENS' } : { base: cfg.threshold, source: 'threshold in /config' }
}

// A seeded session hands off no sooner than MIN_HEADROOM past its floor, whatever the threshold says.
async function thresholdFor($: EngineInterface, sessionId: string): Promise<number> {
  const { base } = await configured($)
  return sessionId === seededSession ? Math.max(base, (floor ?? 0) + MIN_HEADROOM) : base
}

// Once per seeded session, as its floor lands: when the configured threshold leaves less than
// MIN_HEADROOM above the floor, say so, with the number, the source, and where the line moved to.
// Without this the 2026-10-04 chain looked like a guard bug; nobody had run `env | grep AUTO_HANDOFF`.
let warnedSession: string | undefined
async function warnTightThreshold($: EngineInterface, sessionId: string) {
  if (floor === undefined || warnedSession === sessionId) return
  warnedSession = sessionId
  const { base, source } = await configured($)
  const headroom = base - floor
  if (headroom >= MIN_HEADROOM) return
  await log($, `tight threshold session=${sessionId} threshold=${base} source=${source} floor=${floor} headroom=${headroom} effective=${floor + MIN_HEADROOM}`)
  const left = headroom > 0 ? `leaves ${k(headroom)}` : 'is below'
  addStep($, { mark: 'warn', text: `threshold ${k(base)} (${source}) ${left} this session's ${k(floor)} start: handing off at ${k(floor + MIN_HEADROOM)} instead` }, { mark: 'warn', text: 'auto-handoff' }, true)
}

// A non-positive or non-numeric value falls back to the default rather than handing off at 0.
const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
const str = (v: unknown, fallback: string) => typeof v === 'string' && v.trim() ? v.trim() : fallback
// A bad pattern is dropped, not fatal: a typo in /config should not stop handoffs.
function pattern(v: unknown): RegExp | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  try { return new RegExp(v) } catch { return undefined }
}

export const register: Register = (on, options) => {
  cfg = {
    threshold: num(options.threshold, DEFAULTS.threshold),
    maxUnattended: num(options.maxConsecutiveHandoffs, DEFAULTS.maxUnattended),
    briefTemplate: str(options.briefTemplate, DEFAULTS.briefTemplate),
    instructionsTemplate: str(options.instructionsTemplate, DEFAULTS.instructionsTemplate),
    ignoreFiles: pattern(options.ignoreFiles),
    viewer: typeof options.viewer === 'string' ? options.viewer.trim() : DEFAULTS.viewer,
  }
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId) await keepServing($)
      if (e.agentId || inFlight || pending) return r // subagent turns fire turn.complete too
      const tokens = (await $.session.usage()).context.tokens
      if (tokens === undefined) return r
      const sessionId = await $.session.id()
      if (sessionId === seededSession && floor === undefined) {
        // Fallback only: turn.step sets the floor from the seed turn's first response. Reached
        // when that response carried no usage.
        floor = tokens
        await log($, `floor set at turn end session=${sessionId} tokens=${tokens} (first response carried no usage)`)
        showHandedOff($, tokens)
        await warnTightThreshold($, sessionId)
        return r
      }
      const threshold = await thresholdFor($, sessionId)
      if (tokens < threshold && gated !== sessionId) return r
      await tryHandoff($, sessionId, tokens, threshold, gated === sessionId ? 'turn.complete gated' : 'turn.complete')
    } catch (err) {
      await log($, `turn.complete error ${String(err)}`)
    }
    return r
  })

  // Tool output lands in the next request; count it before that request is sent. Past the
  // threshold, refuse the call instead: one step of parallel reads took a session from 67k to
  // 437k with no request in between for turn.step to stop. A refused call never runs; the
  // next request trips turn.step and the handoff goes through the normal path.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId) {
      try {
        const sessionId = await $.session.id()
        const tokens = (await $.session.usage()).context.tokens
        const projected = (tokens ?? 0) + unmeasured
        const threshold = await thresholdFor($, sessionId)
        if (inFlight || pending || (tokens !== undefined && projected >= threshold && await canHandOff($, sessionId))) {
          if (!inFlight && !pending) gated = sessionId
          await log($, `tool refused session=${sessionId} tool=${e.tool} projected=${projected} threshold=${threshold}`)
          return { deny: `[auto-handoff] Not run: the context is past the handoff threshold (${k(projected)} ≥ ${k(threshold)}). This session is handing off to a fresh one, which will redo this call. Make no more tool calls.` }
        }
      } catch (err) {
        await log($, `tool.call gate error ${String(err)}`)
      }
    }
    const r = await next(e)
    if (!e.agentId && typeof r.text === 'string') unmeasured += Math.ceil(r.text.length / CHARS_PER_TOKEN)
    return r
  })

  // Before each main-loop request: if the last measured size plus what has landed since
  // crosses the threshold, end the turn here and hand off instead of sending a request
  // that may overflow the window.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && !inFlight && !pending && e.index > 0) {
      try {
        const tokens = (await $.session.usage()).context.tokens
        const sessionId = await $.session.id()
        const isSeedTurn = sessionId === seededSession && floor === undefined
        if (tokens !== undefined && !isSeedTurn) {
          const projected = tokens + unmeasured
          const threshold = await thresholdFor($, sessionId)
          const isGated = gated === sessionId
          if ((projected >= threshold || isGated) && await tryHandoff($, sessionId, projected, threshold, `turn.step measured=${tokens}${isGated ? ' gated' : ''}`)) {
            unmeasured = 0
            // A gated session can measure under the threshold here; "would carry" a number below it reads as a bug.
            const why = projected >= threshold
              ? `The next request would carry about ${Math.round(projected / 1000)}k tokens (threshold ${Math.round(threshold / 1000)}k).`
              : `A tool call was refused at the handoff threshold (${Math.round(threshold / 1000)}k).`
            yield { kind: 'text', index: 0, text: `[auto-handoff] ${why} Stopping this turn to hand off to a fresh session.` }
            yield { kind: 'stop', stopReason: 'end_turn', usage: null }
            return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
          }
        }
      } catch (err) {
        await log($, `turn.step error ${String(err)}`)
      }
    }
    const before = unmeasured
    const seeding = !e.agentId && seededSession !== undefined && floor === undefined
    const r = yield* next(e)
    // The response measured everything up to its request; its own output is new, and so is
    // any tool output that landed while it streamed (core runs tools before the stream ends).
    if (!e.agentId && r.usage) unmeasured = unmeasured - before + r.usage.output_tokens
    // The seed turn's first request is the fresh session's true starting size. Measuring at
    // the end of that turn instead let a busy first turn (47k to 129k of reads) set
    // the floor at 129k, with the pre-request check off the whole way.
    if (seeding && r.usage) {
      floor = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
      await log($, `floor session=${seededSession} tokens=${floor} (seed turn's first request)`)
      showHandedOff($, floor)
      await warnTightThreshold($, seededSession!)
    }
    return r
  })

  // The engine's own auto-compact runs ahead of the turn.step check (live tests 2026-10-03:
  // two compactions, no turn.step line). Catch it here and hand off in its place.
  on('session.compact', async ($, e, next) => {
    if (e.trigger !== 'auto' || e.agentId) return next(e)
    if (inFlight || pending) return { skip: 'auto-handoff in progress' }
    try {
      const sessionId = await $.session.id()
      const tokens = ((await $.session.usage()).context.tokens ?? 0) + unmeasured
      const threshold = await thresholdFor($, sessionId)
      await log($, `auto-compact session=${sessionId} projected=${tokens}`)
      if (await tryHandoff($, sessionId, tokens, threshold, 'session.compact')) {
        unmeasured = 0
        return { skip: 'auto-handoff: handing off to a fresh session instead of compacting' }
      }
    } catch (err) {
      await log($, `session.compact error ${String(err)}`)
    }
    return next(e)
  })

  // The seed row in the transcript: the brief path and the viewer URL drawn as links, so a
  // click opens them. The stored message stays as submitted; only the drawing changes. A
  // Markdown element linkifies http:, https: and file: (the Link element refuses the
  // Tailscale IP), and the panel draws its brief link the same way.
  // Yields the band to a survey, and passes when there is nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!shown || e.props.hasSurvey) return next(e)
    return panelTree($.ui.resolve(e), shown, frame, () => hidePanel($))
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'plugin' } } }, async ($, e, next) => {
    const origin = e.props.origin
    if (origin.kind !== 'plugin' || origin.name !== $.plugin.name || !e.props.text.startsWith(SEED_PREFIX)) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={linkify(e.props.text)} />
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin && USER_ORIGINS.has(e.origin.kind)) {
      unattended = 0
      if (pausedSession) hidePanel($) // the pause panel's "send a message to resume" is done
      pausedSession = undefined
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.transcript_path) transcriptPath = e.transcript_path
    if (e.source === 'startup') {
      await writeMissingTemplates($)
      await keepServing($)
    }
    // A /clear of the person's own leaves no handoff to report; the panel from the last one goes too.
    if (e.source === 'clear' && !pending && !inFlight && shown) hidePanel($)
    if (e.source !== 'clear' || !pending) return r
    const p = pending
    pending = undefined
    try {
      const newSession = await $.session.id()
      seededSession = newSession
      floor = undefined
      unmeasured = 0
      await $.store.set(`fired:${p.oldSession}`, `seeded:${newSession}`)
      await log($, `seeding new=${newSession} from=${p.oldSession}`)
      handedFrom = { session: p.oldSession, tokens: p.tokens, link: p.link, problem: p.problem }
      steps($, [briefStep(p.problem), { mark: 'done', text: 'cleared' }, { mark: 'spin', text: 'starting the fresh session' }])
      const own = await storedLineage($, p.oldSession)
      const prior = own ? own.depth : 1
      lineage = { from: p.oldSession, chain: p.chain, depth: prior !== undefined ? prior + 1 : undefined }
      await $.store.set(`lineage:${newSession}`, lineage)
      // The old brief learns where it went, and its chain's pages link forward.
      try {
        const old = parseBrief(await $.fs.read(p.briefPath) as string)
        // viewer: the page link, read by the status line script for the session it handed off to.
        await $.fs.write(p.briefPath, withHeader({ ...old.header, to: newSession, ...(p.link ? { viewer: p.link } : {}) }, old.body))
        const briefDir = p.briefPath.replace(/\/[^/]+$/, '')
        await viewer($, briefDir, `${briefDir}/pages`, p.oldSession)
      } catch (err) {
        await log($, `viewer forward link failed ${String(err)}`)
      }
      // One line on screen; the model reads the brief from disk. A full brief as the
      // seed showed up as a wall of text the person never wrote.
      const text = `${SEED_PREFIX} ${short(p.oldSession)}. The previous session hit its context limit and was cleared. Read the brief at ${p.briefPath} before doing anything else${p.link ? ` (readable copy: ${p.link})` : ''} and follow its Instructions section. Open your first reply with the line "↪ Handoff from session ${short(p.oldSession)}".`
      $.prompt.submit({ text }).catch((err: unknown) => {
        handedFrom = undefined
        failed($, 'the seed prompt was rejected', `paste the brief path to carry on: ${p.briefPath}`)
        return log($, `seed rejected ${String(err)}`)
      })
    } catch (err) {
      await log($, `seed error ${String(err)}`)
    }
    return r
  })
}
