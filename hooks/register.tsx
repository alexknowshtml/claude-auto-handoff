import type { EngineInterface, Register, SessionMessage, Timer } from 'claude-code'
import { assembleBrief, briefPrompt, extractFacts, factsBlock, forkPrompt, isValidBrief, markUnverifiedFigures, replySection, softNote } from './brief.ts'
import type { Facts } from './brief.ts'
import { chainOf, parseBrief, renderPage, sections, viewerLink, withHeader } from './viewer.ts'
import type { Entry } from './viewer.ts'
import { SERVER_JS, parseAddress } from './server.ts'
import { isSpinning, panelTree } from './panel.tsx'
import type { Line, Panel } from './panel.tsx'
import { BRIEF_DIR, DEFAULTS, LAST_RESORT_INSTRUCTIONS, MIN_HEADROOM, SEED_PREFIX, TEMPLATES, WINDOW_RESERVE, BACKSTOP_OVER, expand, k, linkify, parseConfig, parseTokens, short, SOFT_MARGIN } from './config.ts'
import type { Config, ResetMode, TemplateKey } from './config.ts'
import { HISTORY_HEADING, blockId, compressPrompt, digestPrompt, halfText, historySection, oneParagraph, parseLog, parseTree, pending as pendingBlocks, projectKey, repoRoot } from './history.ts'
import type { Entry as HistoryEntry } from './history.ts'

// At the token threshold, Haiku writes a handoff brief, the mod runs /clear (or compacts, with
// resetMode "compact"), then seeds the fresh session with a pointer to the brief. Interactive terminal sessions only: where a
// wrapper pipes the session and owns the context limit (DISABLE_AUTO_COMPACT), the mod only logs.

let cfg: Config = DEFAULTS
// Origins the engine stamps on a prompt the person sent; the seed arrives as { kind: 'plugin' }.
const USER_ORIGINS = new Set(['composer', 'bridge'])
// Rough chars-per-token for tool output, used to project the next request's size.
const CHARS_PER_TOKEN = 4
// The panel above the prompt (panel.tsx) is the whole UI. No status entry: the host draws one
// as "⚠ auto-handoff:", which reads as an error.
const LOG = `~/${BRIEF_DIR}/auto-handoff.log`

// problem: why the brief is facts only, when Haiku's summary was unusable.
type Pending = { oldSession: string; briefPath: string; tokens: number; chain: string; link: string; problem?: string; mode: ResetMode }



// Module variables survive /clear; $.state does not.
let pending: Pending | undefined
let inFlight = false
// What the model showed the user from its handoff call on: the text of the response that made the
// call, and of every response after it. The brief was written at the call; this is carried across
// the clear. Kept from the stream, since a long transcript is over $.fs.read's size limit.
// Set only for a call that started a handoff; the tool can run before or after the step that
// called it returns, so the calling step's text waits in callText.
let toolReply: { withCall: string; after: string[] } | undefined
let callText = ''
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
// The session told it is near its handoff line: told once.
let nudged: string | undefined
// From the latest SessionStart; /clear starts a new transcript file.
let transcriptPath: string | undefined

// The id the mod keys a session's state by (fired, lineage, the brief's file name). A compact
// handoff keeps the engine's session id, so each one starts a new segment: <id>_<n> after the nth.
// n lives in the store: a hot reload resets module variables.
async function segmentId($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  const n = await $.store.get(`segment:${id}`)
  return typeof n === 'number' && n > 0 ? `${id}_${n}` : id
}

async function log($: EngineInterface, line: string) {
  try {
    const home = await $.env.get('HOME')
    await $.process.run(['sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', 'sh', `${new Date().toISOString()} ${line}`, `${home}/${BRIEF_DIR}/auto-handoff.log`])
  } catch {}
}


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

let lastServeTry = 0
// Starts the server detached (setsid, else nohup), so the pages stay served after this session
// exits: a brief's link is opened later, often from a phone, long after the handoff. When a
// server already holds the port, the new child exits at once, so a launch is safe to repeat.
// Its output goes to the mod's log.
async function launchServer($: EngineInterface, pagesDir: string, addr: { host: string; port: string }) {
  try {
    const home = await $.env.get('HOME')
    await $.process.run(['sh', '-c', 'mkdir -p "$1"; if command -v setsid >/dev/null 2>&1; then d=setsid; else d=nohup; fi; $d node -e "$2" "$1" "$3" "$4" >>"$5" 2>&1 </dev/null &',
      'sh', pagesDir, SERVER_JS, addr.host, addr.port, `${home}/${BRIEF_DIR}/auto-handoff.log`])
  } catch (err) {
    await log($, `viewer server failed ${String(err)}`)
  }
}

// Brings the server back if it died (a reboot, a crash). Called on startup and after each turn,
// at most once in five minutes. Sessions with the kill switches set serve too: the switches stop
// handoffs, and serving old briefs is not one.
async function keepServing($: EngineInterface) {
  if (Date.now() - lastServeTry < 300_000) return
  lastServeTry = Date.now()
  const addr = await serveAddress($)
  const home = await $.env.get('HOME')
  if (addr && home) await launchServer($, `${home}/${BRIEF_DIR}/pages`, addr)
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
    if (addr) await launchServer($, pagesDir, addr)
    return viewerLink(addr, pagesDir, sessionId)
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

// ---------------------------------------------------------------- project history (history.ts)

type ProjectHistory = { dir: string; logPath: string; treePath: string; entries: HistoryEntry[]; tree: Record<string, string> }
const HISTORY_SYSTEM = 'You keep the long-term history of a software project: short, exact, durable.'
// Compressions one run may make. Each is one Haiku call; what is left waits for the next run.
const MAX_COMPRESSIONS = 16

// The history of the repository the session works in (every worktree shares it), else of its cwd.
async function projectHistory($: EngineInterface, home: string, cwd: string): Promise<ProjectHistory> {
  let root: string | undefined
  try {
    const { exitCode, stdout } = await $.process.run(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (exitCode === 0) root = repoRoot(stdout)
  } catch {}
  const dir = `${home}/${BRIEF_DIR}/history/${projectKey(root ?? cwd)}`
  const logPath = `${dir}/log.jsonl`
  const treePath = `${dir}/tree.json`
  return { dir, logPath, treePath, entries: parseLog(await readText($, logPath) ?? ''), tree: parseTree(await readText($, treePath)) }
}

// One compression run at a time in this process, so two handoffs close together never build
// the same block twice.
let compressing = false

// Builds the summaries the log now allows, smallest first, re-reading both files each round:
// another session of the same project may be writing them too.
async function compressPending($: EngineInterface, h: ProjectHistory) {
  if (compressing) return
  compressing = true
  try {
    for (let round = 0; round < MAX_COMPRESSIONS; round++) {
      const entries = parseLog(await readText($, h.logPath) ?? '')
      const tree = parseTree(await readText($, h.treePath))
      const halvesOf = (b: readonly [number, number]) => {
        const mid = (b[0] + b[1]) / 2
        const a = halfText(entries, tree, [b[0], mid])
        const z = halfText(entries, tree, [mid, b[1]])
        return a && z ? [a, z] as const : undefined
      }
      const next = pendingBlocks(entries.length, b => !!tree[blockId(b)]).find(b => halvesOf(b))
      if (!next) return
      const r = await $.model.complete({ model: 'haiku', system: HISTORY_SYSTEM, prompt: compressPrompt(halvesOf(next)!), maxTokens: 400, timeoutMs: 60_000 })
      if (!r.isAnswered || !r.text.trim()) {
        await log($, `history compression #${blockId(next)} failed (${r.isAnswered ? 'empty' : r.reason}); the next run retries it`)
        return
      }
      const latest = parseTree(await readText($, h.treePath))
      latest[blockId(next)] = oneParagraph(r.text)
      await $.fs.write(h.treePath, `${JSON.stringify(latest, null, 1)}\n`)
    }
  } catch (err) {
    await log($, `history compression error ${String(err)}`)
  } finally {
    compressing = false
  }
}

// Appends this session's entry to the project's log: Haiku's digest of the brief, else the
// facts. Then builds whatever summaries that makes possible. Runs after the brief is on disk,
// beside the /clear, so the handoff never waits for it.
async function recordHistory($: EngineInterface, h: ProjectHistory, entry: Omit<HistoryEntry, 'text'>, source: string, fallback: string) {
  try {
    const r = await $.model.complete({ model: 'haiku', system: HISTORY_SYSTEM, prompt: digestPrompt(source), maxTokens: 400, timeoutMs: 60_000 })
    const text = r.isAnswered && r.text.trim() ? oneParagraph(r.text) : oneParagraph(fallback)
    await $.process.run(['mkdir', '-p', h.dir])
    const current = await readText($, h.logPath) ?? ''
    await $.fs.write(h.logPath, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${JSON.stringify({ ...entry, text })}\n`)
    await log($, `history entry #${parseLog(current).length} written ${h.logPath}${r.isAnswered ? '' : ` (digest failed: ${r.reason}; facts used)`}`)
    await compressPending($, h)
  } catch (err) {
    await log($, `history error ${String(err)}`)
  }
}

// A session's history entry when Haiku's digest failed: what the code knows for certain.
const factsDigest = (f: Facts) => [
  f.lastUserMessage && `Last request: ${f.lastUserMessage}`,
  f.commits.length && `Commits: ${f.commits.join('; ')}`,
  f.filesModified.length && `Files changed: ${f.filesModified.join(', ')}`,
].filter(Boolean).join('. ') || 'Handed off with no digest.'

// The brief a seeded session started from, as the next brief's prompt reads it: its sections
// minus the ones written for the model, and minus its history, which the new brief carries anyway.
async function previousBrief($: EngineInterface, path: string): Promise<string | undefined> {
  const text = await readText($, path)
  if (!text) return undefined
  return sections(parseBrief(text).body).filter(s => !s.startsWith(HISTORY_HEADING)).join('\n\n') || undefined
}

// ---------------------------------------------------------------- the handoff

type Written = { text: string; problem?: string; writer: 'tool' | 'fork' | 'haiku' }

// Why a reply cannot be the brief: failed, empty or holding none of the template's sections.
function unusable(r: { isAnswered: true; text: string } | { isAnswered: false; reason: string }, briefTemplate: string): string | undefined {
  return !r.isAnswered ? r.reason : !r.text.trim() ? 'empty' : !isValidBrief(r.text, briefTemplate) ? 'no-sections' : undefined
}

// The fork asks the session's own model, whose transcript the API serves from cache, so the
// brief sees every turn rather than the last 120 rendered messages. A fork that fails hands the
// job to Haiku; a Haiku reply that fails leaves the facts alone.
async function writeBrief($: EngineInterface, sessionId: string, messages: readonly SessionMessage[], facts: Facts, briefTemplate: string, previous: string | undefined): Promise<Written> {
  if (cfg.briefWriter === 'fork') {
    const r = await $.model.fork({ prompt: forkPrompt(facts, briefTemplate, previous) })
      .catch((err: unknown) => ({ isAnswered: false as const, reason: `rejected: ${String(err)}` }))
    const problem = unusable(r, briefTemplate)
    if (!problem && r.isAnswered) return { text: r.text, writer: 'fork' }
    await log($, `fork brief unusable session=${sessionId} reason=${problem}; asking haiku`)
  }
  const r = await $.model.complete({
    model: 'haiku',
    system: 'You summarize coding sessions into precise handoff briefs.',
    prompt: briefPrompt(messages, facts, briefTemplate, previous),
    maxTokens: 4_000,
    timeoutMs: 60_000,
  })
  const problem = unusable(r, briefTemplate)
  if (problem) await log($, `haiku brief unusable session=${sessionId} reason=${problem}; using facts-only brief`)
  return { text: r.isAnswered ? r.text : '', problem, writer: 'haiku' }
}

// given: the brief the model passed to the handoff tool. Used when it holds the template's
// sections; otherwise the brief is written here as if none came.
async function handoff($: EngineInterface, sessionId: string, tokens: number, threshold: number, via: string, given?: string) {
  try {
    const own = sessionId === seededSession && lineage ? lineage : await storedLineage($, sessionId)
    const messages = await $.session.messages()
    const facts = extractFacts(messages, cfg.ignoreFiles)
    const { base, source } = await configured($)
    facts.handoffTokens = tokens
    facts.threshold = threshold
    facts.thresholdSource = threshold > base ? `${source} (${k(base)}), raised to leave ${k(MIN_HEADROOM)} above the starting size` : source
    facts.trigger = via.startsWith('tool') ? 'the handoff tool (the model asked)' : via.startsWith('command') ? '/handoff (the user asked)' : 'the context threshold'
    if (sessionId === seededSession && floor !== undefined) facts.seededSessionStartSize = floor
    facts.unattendedCount = unattended
    // A session with no lineage starts its chain. One seeded before depth existed stays unknown.
    const depth = own ? own.depth : 1
    if (depth !== undefined) facts.depth = depth
    const home = await $.env.get('HOME') ?? ''
    const cwd = await $.session.cwd()
    const briefDir = `${home}/${BRIEF_DIR}`
    const previous = own?.from ? await previousBrief($, `${briefDir}/${own.from}.md`) : undefined
    const history = await projectHistory($, home, cwd)
    const briefTemplate = await template($, 'briefTemplate')
    const fromTool = given !== undefined && isValidBrief(given, briefTemplate)
    if (given !== undefined && !fromTool) await log($, `tool brief unusable session=${sessionId} (no template sections); writing one instead`)
    const { text, problem, writer }: Written = fromTool ? { text: given, writer: 'tool' } : await writeBrief($, sessionId, messages, facts, briefTemplate, previous)
    const checked = markUnverifiedFigures(text, facts)
    if (!problem && checked.flagged.length) await log($, `brief figures not in Handoff Numbers session=${sessionId}: ${checked.flagged.join(', ')}`)
    // Claude Code keeps transcripts under the cwd with every non-alphanumeric character as '-'.
    const transcript = transcriptPath ?? `~/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${await $.session.id()}.jsonl`
    const brief = assembleBrief({
      sessionId,
      transcript,
      instructions: await template($, 'instructionsTemplate') || LAST_RESORT_INSTRUCTIONS,
      writer,
    }, facts, problem ? undefined : checked.text, historySection(history.entries, history.tree, cfg.historyLines, history.logPath))
    const briefPath = `${briefDir}/${sessionId}.md`
    const pagesDir = `${briefDir}/pages`
    const chain = own?.chain ?? sessionId
    const header = { from: own?.from, chain, depth: depth !== undefined ? String(depth) : undefined, tokens: String(tokens), at: new Date().toISOString(), cwd }
    await $.fs.write(briefPath, withHeader(header, brief))
    void recordHistory($, history, { at: header.at, session: sessionId, transcript }, problem ? factsBlock(facts) : checked.text, factsDigest(facts))
    const link = await viewer($, briefDir, pagesDir, sessionId)
    const mode = cfg.resetMode
    pending = { oldSession: sessionId, briefPath, tokens, chain, link, problem, mode }
    const doing = mode === 'compact' ? 'compacting' : 'clearing'
    steps($, [briefStep(problem), { mark: 'spin', text: doing }])
    await $.store.set(`fired:${sessionId}`, problem ? `${doing}-facts-only:${problem}` : doing)
    await log($, `brief written ${briefPath} (${brief.length} chars); queueing ${mode === 'compact' ? 'the compaction' : '/clear'}`)
    $.command.run(mode === 'compact' ? { command: 'compact', args: COMPACT_MARK } : { command: 'clear' }).catch(async (err: unknown) => {
      pending = undefined
      // fired stays 'clearing', so this session does not try again; it carries on as it is.
      failed($, `/${mode} was rejected`, `this session keeps going; the brief is at ${briefPath}`)
      await log($, `${mode} rejected ${String(err)}`)
    })
  } catch (err) {
    pending = undefined
    // fired stays 'briefing', which tryHandoff treats as an orphan: the next turn tries again.
    failed($, 'no brief written', 'this session keeps going and tries again after the next turn')
    await log($, `handoff error session=${sessionId} ${String(err)}; no clear`)
  }
}

// The /compact a compact handoff runs, known by its instructions: the mod's session.compact hook
// answers it with RESET_NOTE alone, so no summary is written and the model starts from the seed.
// Run as a command, like /clear: it waits for the session to go idle, and the engine raises the
// compaction itself, so this plugin's own hook sees it.
const COMPACT_MARK = '[auto-handoff] reset for a handoff'
const RESET_NOTE = '[auto-handoff] The conversation before this point was reset for a handoff; the brief follows.'

// Seeds the fresh session or segment `newSession` with a pointer to p's brief, from the
// SessionStart that follows /clear or /compact.
async function seed($: EngineInterface, p: Pending, newSession: string) {
  pending = undefined
  try {
    seededSession = newSession
    floor = undefined
    unmeasured = 0
    await $.store.set(`fired:${p.oldSession}`, `seeded:${newSession}`)
    await log($, `seeding new=${newSession} from=${p.oldSession} mode=${p.mode}`)
    handedFrom = { session: p.oldSession, tokens: p.tokens, link: p.link, problem: p.problem }
    steps($, [briefStep(p.problem), { mark: 'done', text: p.mode === 'compact' ? 'compacted' : 'cleared' }, { mark: 'spin', text: 'starting the fresh session' }])
    const own = await storedLineage($, p.oldSession)
    const prior = own ? own.depth : 1
    lineage = { from: p.oldSession, chain: p.chain, depth: prior !== undefined ? prior + 1 : undefined }
    await $.store.set(`lineage:${newSession}`, lineage)
    // The reply the old session ended on, after its handoff call: the brief was written before
    // it, and the clear can take it off the screen. undefined when the tool was not called.
    const reply = toolReply && (toolReply.after.length ? toolReply.after.join('\n\n') : toolReply.withCall)
    toolReply = undefined
    callText = ''
    // The old brief learns where it went, and its chain's pages link forward.
    try {
      const old = parseBrief(await $.fs.read(p.briefPath) as string)
      const body = reply === undefined ? old.body : `${old.body.trimEnd()}\n\n${replySection(reply)}`
      // viewer: the page link, read by the status line script for the session it handed off to.
      await $.fs.write(p.briefPath, withHeader({ ...old.header, to: newSession, ...(p.link ? { viewer: p.link } : {}) }, body))
      const briefDir = p.briefPath.replace(/\/[^/]+$/, '')
      await viewer($, briefDir, `${briefDir}/pages`, p.oldSession)
    } catch (err) {
      await log($, `viewer forward link failed ${String(err)}`)
    }
    // One line on screen; the model reads the brief from disk. A full brief as the
    // seed showed up as a wall of text the person never wrote.
    const text = `${SEED_PREFIX} ${short(p.oldSession)}. The previous session hit its context limit and was ${p.mode === 'compact' ? 'reset' : 'cleared'}. Read the brief at ${p.briefPath} before doing anything else${p.link ? ` (readable copy: ${p.link})` : ''} and follow its Instructions section. Open your first reply with the line "↪ Handoff from session ${short(p.oldSession)}".${reply ? `\n\nThe previous session's last reply:\n\n${reply}` : ''}`
    $.prompt.submit({ text }).catch((err: unknown) => {
      handedFrom = undefined
      failed($, 'the seed prompt was rejected', `paste the brief path to carry on: ${p.briefPath}`)
      return log($, `seed rejected ${String(err)}`)
    })
  } catch (err) {
    await log($, `seed error ${String(err)}`)
  }
}

// Shared by turn.complete and turn.step: the fired, kill-switch and loop-guard checks, then
// the handoff itself. Returns true when a handoff started.
async function tryHandoff($: EngineInterface, sessionId: string, tokens: number, threshold: number, via: string, given?: string): Promise<boolean> {
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
  handoff($, sessionId, tokens, threshold, via, given).finally(() => { inFlight = false })
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
// `/handoff 60k` sets one session's threshold. It is keyed by session id, so it lapses with the
// session: the fresh one after a handoff has a new id.
let override: { session: string; tokens: number } | undefined

// The threshold never sits within WINDOW_RESERVE of the window, so the 300k default still works
// on a 200k window.
async function configured($: EngineInterface): Promise<{ base: number; source: string }> {
  const env = Number(await $.env.get('AUTO_HANDOFF_TOKENS'))
  const own = override && override.session === await segmentId($) ? override.tokens : undefined
  const { base, source } = own ? { base: own, source: '/handoff in this session' }
    : env > 0 ? { base: env, source: 'AUTO_HANDOFF_TOKENS' }
    : { base: cfg.threshold, source: 'threshold in /config' }
  const window = (await $.session.usage()).context.window
  const cap = typeof window === 'number' && window > WINDOW_RESERVE * 2 ? window - WINDOW_RESERVE : undefined
  return cap !== undefined && base > cap ? { base: cap, source: `${source} (${k(base)}), capped at the ${k(window)} window less ${k(WINDOW_RESERVE)}` } : { base, source }
}

// A seeded session hands off no sooner than MIN_HEADROOM past its floor, whatever the threshold says.
async function thresholdFor($: EngineInterface, sessionId: string): Promise<number> {
  const { base } = await configured($)
  return sessionId === seededSession ? Math.max(base, (floor ?? 0) + MIN_HEADROOM) : base
}

// The threshold hands off when the turn ends, so a long turn can finish its answer. Mid-turn,
// only this backstop stops it: the window less WINDOW_RESERVE, no more than BACKSTOP_OVER past the
// threshold, or the threshold when the window is unknown.
async function backstopFor($: EngineInterface, sessionId: string): Promise<number> {
  const threshold = await thresholdFor($, sessionId)
  const window = (await $.session.usage()).context.window
  return typeof window === 'number' && window > WINDOW_RESERVE * 2 ? Math.max(threshold, Math.min(window - WINDOW_RESERVE, threshold + BACKSTOP_OVER)) : threshold
}

// Past the soft line the model is asked to hand off at its next boundary. Never below the point a
// seeded session's handoff tool would refuse.
async function softLine($: EngineInterface, sessionId: string): Promise<number> {
  const threshold = await thresholdFor($, sessionId)
  return sessionId === seededSession ? Math.max(threshold - SOFT_MARGIN, (floor ?? 0) + MIN_HEADROOM) : threshold - SOFT_MARGIN
}

// The note for this tool result, once per session, when the context has passed the soft line and
// a handoff could start. Undefined otherwise.
async function nudge($: EngineInterface, sessionId: string, projected: number): Promise<string | undefined> {
  if (nudged === sessionId || inFlight || pending || unattended >= cfg.maxUnattended) return undefined
  if (sessionId === seededSession && floor === undefined) return undefined
  if (projected < await softLine($, sessionId) || !await canHandOff($, sessionId)) return undefined
  const fired = await $.store.get(`fired:${sessionId}`)
  if (fired && fired !== 'briefing') return undefined
  nudged = sessionId
  const threshold = await thresholdFor($, sessionId)
  await log($, `soft line session=${sessionId} projected=${projected} threshold=${threshold}; asking for a handoff with a brief`)
  return softNote(handoffTool($), projected, threshold, await template($, 'briefTemplate'))
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


// ---------------------------------------------------------------- handing off on request

const HANDOFF_TOOL = 'handoff'
const handoffTool = ($: EngineInterface) => `mcp__${$.plugin.name}__${HANDOFF_TOOL}`
// A registered tool's result is checked against string | content blocks: an MCP-style
// { content, isError } object fails that check and reaches the model as an error.
const toolAnswer = (text: string) => ({ result: text })
const HANDOFF_TOOL_DESCRIPTION = 'Hand this session off to a fresh one: the context is cleared and work resumes from a brief, with the project\'s history. Pass `brief`, written for a fresh session that sees none of this conversation (state, decisions, dead ends, next step); without it a brief is written for you, at extra cost. Call it when told the session is near its handoff line, when the user asks, or when a phase of work has just finished (committed, tests green) and the context is past about 100k tokens. The session clears only once the turn has fully ended: finish the work in hand and give the user your full reply, which is carried to the fresh session.'
const HANDOFF_TOOL_SCHEMA = { type: 'object', properties: { brief: { type: 'string', description: 'The handoff brief, in the sections the handoff note lists.' } } }

// The model's own call, at a phase boundary: hand off now, whatever the threshold says. A seeded
// session must still do MIN_HEADROOM of work first, so a handoff cannot chain on itself.
async function handoffByTool($: EngineInterface, agentId?: string, brief?: string) {
  if (agentId) return toolAnswer('Not handed off: only the main session hands off.')
  if (inFlight || pending) return toolAnswer('A handoff is already queued; it runs once this turn ends. Carry on.')
  const sessionId = await segmentId($)
  const tokens = (await $.session.usage()).context.tokens ?? 0
  if (sessionId === seededSession && floor !== undefined && tokens < floor + MIN_HEADROOM)
    return toolAnswer(`Not handed off: this session started at ${k(floor)} from a handoff and is at ${k(tokens)}. Do more work first.`)
  const started = await tryHandoff($, sessionId, tokens, await thresholdFor($, sessionId), brief ? 'tool brief' : 'tool', brief)
  if (started) toolReply = { withCall: callText, after: [] }
  return toolAnswer(started
    ? 'Handoff queued: the session clears once this turn has fully ended. Finish the work in hand, then give the user your full reply to their last message; it is carried to the fresh session.'
    : 'Not handed off: auto-handoff is paused or turned off here, or this session already handed off. Carry on.')
}

// Summaries a crash or a closed session left unbuilt, built in the background at startup.
async function catchUpHistory($: EngineInterface) {
  try {
    if (await paneVar($)) return
    const h = await projectHistory($, await $.env.get('HOME') ?? '', await $.session.cwd())
    if (h.entries.length > 1) await compressPending($, h)
  } catch (err) {
    await log($, `history catch-up error ${String(err)}`)
  }
}

export const register: Register = (on, options) => {
  cfg = parseConfig(options)

  // The handoff tool and /handoff, listed from the first turn. Not where the mod is switched off.
  on('session.start', async ($, e, next) => {
    try {
      if (!await paneVar($)) {
        await $.tool.register({ name: HANDOFF_TOOL, description: HANDOFF_TOOL_DESCRIPTION, inputSchema: HANDOFF_TOOL_SCHEMA })
        await $.command.register({ name: 'handoff', description: 'Hand off to a fresh session now; /handoff 60k sets this session\'s threshold instead', argumentHint: '[threshold]' })
      }
    } catch (err) {
      await log($, `register error ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const sessionId = await segmentId($)
    if (e.args.trim()) {
      const n = parseTokens(e.args)
      if (!n) return { text: 'usage: /handoff hands off now; /handoff 60k sets this session\'s threshold' }
      override = { session: sessionId, tokens: n }
      await log($, `threshold override session=${sessionId} tokens=${n}`)
      return { text: `auto-handoff: this session hands off at ${k(n)}` }
    }
    const tokens = (await $.session.usage()).context.tokens ?? 0
    const started = await tryHandoff($, sessionId, tokens, await thresholdFor($, sessionId), 'command')
    return { text: started ? 'auto-handoff: handing off now' : 'auto-handoff: not handing off here (paused, turned off, or already handed off)' }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId) await keepServing($)
      if (e.agentId || inFlight || pending) return r // subagent turns fire turn.complete too
      const tokens = (await $.session.usage()).context.tokens
      if (tokens === undefined) return r
      const sessionId = await segmentId($)
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
    if (e.tool === handoffTool($)) {
      const brief = (e as { brief?: unknown }).brief
      return handoffByTool($, e.agentId, typeof brief === 'string' && brief.trim() ? brief : undefined)
    }
    if (!e.agentId) {
      try {
        const sessionId = await segmentId($)
        const tokens = (await $.session.usage()).context.tokens
        const projected = (tokens ?? 0) + unmeasured
        const backstop = await backstopFor($, sessionId)
        // A queued handoff waits for the turn to end; only the backstop stops its tools.
        if (tokens !== undefined && projected >= backstop && (inFlight || pending || await canHandOff($, sessionId))) {
          if (!inFlight && !pending) gated = sessionId
          await log($, `tool refused session=${sessionId} tool=${e.tool} projected=${projected} backstop=${backstop}`)
          return { deny: `[auto-handoff] Not run: the context is near its limit (${k(projected)} ≥ ${k(backstop)}). This session is handing off to a fresh one, which will redo this call. Make no more tool calls.` }
        }
      } catch (err) {
        await log($, `tool.call gate error ${String(err)}`)
      }
    }
    const r = await next(e)
    if (e.agentId || r.deny !== undefined) return r
    if (typeof r.text === 'string') unmeasured += Math.ceil(r.text.length / CHARS_PER_TOKEN)
    try {
      const tokens = (await $.session.usage()).context.tokens
      const note = tokens === undefined ? undefined : await nudge($, await segmentId($), tokens + unmeasured)
      if (note) return { ...r, context: [...(r.context ?? []), note] }
    } catch (err) {
      await log($, `soft line error ${String(err)}`)
    }
    return r
  })

  // Before each main-loop request: if the last measured size plus what has landed since
  // crosses the threshold, end the turn here and hand off instead of sending a request
  // that may overflow the window.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && e.index > 0) {
      try {
        const tokens = (await $.session.usage()).context.tokens
        const sessionId = await segmentId($)
        const isSeedTurn = sessionId === seededSession && floor === undefined
        // A handoff already queued (the model's handoff call, mostly) clears once the turn ends, so
        // the turn runs to its end: its tools and its reply. Only the backstop cuts it.
        if (inFlight || pending) {
          const backstop = await backstopFor($, sessionId)
          if (tokens !== undefined && tokens + unmeasured >= backstop) {
            yield { kind: 'text', index: 0, text: `[auto-handoff] The context is near its limit (${Math.round(backstop / 1000)}k). Stopping this turn to hand off to a fresh session.` }
            yield { kind: 'stop', stopReason: 'end_turn', usage: null }
            return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
          }
        } else if (tokens !== undefined && !isSeedTurn) {
          const projected = tokens + unmeasured
          const threshold = await thresholdFor($, sessionId)
          const backstop = await backstopFor($, sessionId)
          const isGated = gated === sessionId
          if ((projected >= backstop || isGated) && await tryHandoff($, sessionId, projected, threshold, `turn.step measured=${tokens}${isGated ? ' gated' : ''}`)) {
            unmeasured = 0
            // A gated session can measure under the backstop here; "would carry" a number below it reads as a bug.
            const why = projected >= backstop
              ? `The next request would carry about ${Math.round(projected / 1000)}k tokens (limit ${Math.round(backstop / 1000)}k).`
              : `A tool call was refused near the context limit (${Math.round(backstop / 1000)}k).`
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
    if (!e.agentId) {
      if (r.toolUses.some(u => u.name === handoffTool($))) {
        callText = r.answer.trim()
        if (toolReply && !toolReply.after.length) toolReply.withCall = callText
      } else if (toolReply && r.answer.trim()) toolReply.after.push(r.answer.trim())
    }
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
    // A compact handoff's own compaction: one line in the transcript's place, no summary.
    if (e.trigger === 'manual' && !e.agentId && e.instructions?.trim() === COMPACT_MARK && pending?.mode === 'compact')
      return { messages: [{ role: 'user', text: RESET_NOTE, toolUses: [] }] }
    if (e.trigger !== 'auto' || e.agentId) return next(e)
    if (inFlight || pending) return { skip: 'auto-handoff in progress' }
    try {
      const sessionId = await segmentId($)
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
      void catchUpHistory($)
    }
    // A /clear of the person's own leaves no handoff to report; the panel from the last one goes too.
    if (e.source === 'clear' && !pending && !inFlight && shown) hidePanel($)
    if (!pending || e.source !== pending.mode) return r
    if (pending.mode === 'compact') {
      // The same engine session goes on: the next segment of it is the fresh session.
      const id = await $.session.id()
      const n = await $.store.get(`segment:${id}`)
      await $.store.set(`segment:${id}`, (typeof n === 'number' ? n : 0) + 1)
    }
    await seed($, pending, await segmentId($))
    return r
  })
}
