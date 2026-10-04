import type { EngineInterface, Register } from 'claude-code'
import { assembleBrief, briefPrompt, extractFacts, isValidBrief } from './brief.ts'
import { parseBrief, renderAndWrite, viewerLink, withHeader } from './viewer.ts'
import { startServer } from './server.ts'

// At the token threshold, Haiku writes a handoff brief, the mod runs /clear, then seeds the
// fresh session with a pointer to the brief. Interactive terminal sessions only: where a
// wrapper pipes the session and owns the context limit (DISABLE_AUTO_COMPACT), the mod only logs.

const BRIEF_DIR = '.claude/state/auto-handoff'
// The two numbers are userConfig fields (plugin.json), set in /config. Defaults match the manifest.
// threshold: matches HANDOFF_ARM_TOKENS in context-warning.ts.
// GROWTH and maxUnattended are loop guards. A seeded session must grow GROWTH of the threshold past
// its first-turn size before it can hand off again, and at most maxUnattended handoffs may run before
// the user types a prompt. GROWTH is fixed: seeded sessions start near 45k, so at the default
// threshold it never moves the line; it only matters when the threshold is set below a fresh
// session's size. A fraction rather than a token count so a low threshold is not pushed far out. The 2026-10-03 live run (threshold 20k, seeded sessions start at ~31k) chained six times
// without them. Progress, not time: a 15-minute chain cap could block a real session that fills fast.
// The rest shape the brief: two template files and a pattern for files
// that never count as edits.
type Config = { threshold: number; maxUnattended: number; briefTemplate: string; instructionsTemplate: string; ignoreFiles?: RegExp }
const DEFAULTS: Config = { threshold: 160_000, maxUnattended: 2, briefTemplate: '~/.claude/auto-handoff/brief.md', instructionsTemplate: '~/.claude/auto-handoff/instructions.md' }
const GROWTH = 0.25
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
// Toasts are the whole UI: one when the threshold trips, one once the fresh session is
// measured. The host shows them under the plugin's name, so the text carries no prefix.
// No band or status entry: the host draws a status entry as "⚠ auto-handoff:", which reads as an error.
const TOAST_MS = 30_000

type Pending = { oldSession: string; briefPath: string; tokens: number }

const k = (n: number) => `${Math.round(n / 1000)}k`
const short = (sessionId: string) => sessionId.slice(0, 8)

// Module variables survive /clear; $.state does not.
let pending: Pending | undefined
let inFlight = false
let seededSession: string | undefined
let floor: number | undefined
let unattended = 0 // handoffs since the user last typed a prompt
let pausedSession: string | undefined
// The handoff the fresh session came from, until its first request is measured and toasted.
let handedFrom: { session: string; tokens: number } | undefined
// Tokens added since the last response measured the context: tool results and the
// response's own output. turn.complete alone missed a turn whose reads jumped from 63k
// straight past the window, because the request that would have measured it failed.
let unmeasured = 0
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

async function handoff($: EngineInterface, sessionId: string, tokens: number) {
  try {
    const messages = await $.session.messages()
    const facts = extractFacts(messages, cfg.ignoreFiles)
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
    const home = await $.env.get('HOME')
    const cwd = await $.session.cwd()
    const brief = assembleBrief({
      sessionId,
      // Claude Code keeps transcripts under the cwd with every non-alphanumeric character as '-'.
      transcript: transcriptPath ?? `~/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`,
      instructions: await template($, 'instructionsTemplate') || LAST_RESORT_INSTRUCTIONS,
    }, facts, problem ? undefined : text)
    const briefPath = `${home}/${BRIEF_DIR}/${sessionId}.md`
    const pagesDir = `${home}/${BRIEF_DIR}/pages`
    try {
      await $.fs.list(pagesDir)
    } catch {
      await $.fs.write(`${pagesDir}/.gitkeep`, '')
    }

    // Add viewer infrastructure to the brief
    let finalBrief = brief
    try {
      const { header, body } = parseBrief(brief)
      header.chain = header.chain || sessionId
      const serve = await startServer($, pagesDir)
      header.viewer = viewerLink('', serve, pagesDir, sessionId)
      finalBrief = withHeader(header, body)
    } catch (err) {
      await log($, `viewer setup error ${String(err)}`)
    }

    await $.fs.write(briefPath, finalBrief)

    // Render the viewer page
    try {
      await renderAndWrite($, briefPath, pagesDir)
      await log($, `viewer written ${pagesDir}/${sessionId}.html`)
    } catch (err) {
      await log($, `viewer write error ${String(err)}`)
    }

    pending = { oldSession: sessionId, briefPath, tokens }
    await $.store.set(`fired:${sessionId}`, problem ? `clearing-facts-only:${problem}` : 'clearing')
    await log($, `brief written ${briefPath} (${brief.length} chars); queueing /clear`)
    $.command.run({ command: 'clear' }).catch(async (err: unknown) => {
      pending = undefined
      $.ui.toast(`handoff failed: /clear was rejected. See ${BRIEF_DIR}/auto-handoff.log`, { timeoutMs: TOAST_MS })
      await log($, `clear rejected ${String(err)}`)
    })
  } catch (err) {
    pending = undefined
    $.ui.toast(`handoff failed: no brief written. See ${BRIEF_DIR}/auto-handoff.log`, { timeoutMs: TOAST_MS })
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
      $.ui.toast(`paused after ${unattended} handoffs in a row: send a message to resume`, { timeoutMs: TOAST_MS })
    }
    return false
  }
  unattended++

  inFlight = true
  await $.store.set(`fired:${sessionId}`, 'briefing')
  await log($, `threshold session=${sessionId} tokens=${tokens} threshold=${threshold} via=${via}`)
  $.ui.toast(`context ${k(tokens)} is past ${k(threshold)}: writing a brief, then /clear`, { timeoutMs: TOAST_MS })
  // Not awaited: the brief can take a while and /clear only runs once the session is idle.
  handoff($, sessionId, tokens).finally(() => { inFlight = false })
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

// The fresh session's first measurement: the one toast that says the handoff worked.
function toastHandedOff($: EngineInterface, sessionId: string, fresh: number) {
  if (!handedFrom) return
  $.ui.toast(`↪ handed off · ${short(handedFrom.session)} → ${short(sessionId)} · ${k(handedFrom.tokens)} → ${k(fresh)}`, { timeoutMs: TOAST_MS })
  handedFrom = undefined
}

async function thresholdFor($: EngineInterface, sessionId: string): Promise<number> {
  // The env var wins so a test run needs no /config change.
  const base = Number(await $.env.get('AUTO_HANDOFF_TOKENS')) || cfg.threshold
  return sessionId === seededSession ? Math.max(base, (floor ?? 0) + Math.round(base * GROWTH)) : base
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
  }
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId || inFlight || pending) return r // subagent turns fire turn.complete too
      const tokens = (await $.session.usage()).context.tokens
      if (tokens === undefined) return r
      const sessionId = await $.session.id()
      if (sessionId === seededSession && floor === undefined) {
        // Fallback only: turn.step sets the floor from the seed turn's first response. Reached
        // when that response carried no usage.
        floor = tokens
        await log($, `floor set at turn end session=${sessionId} tokens=${tokens} (first response carried no usage)`)
        toastHandedOff($, sessionId, tokens)
        return r
      }
      const threshold = await thresholdFor($, sessionId)
      if (tokens < threshold) return r
      await tryHandoff($, sessionId, tokens, threshold, 'turn.complete')
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
          if (projected >= threshold && await tryHandoff($, sessionId, projected, threshold, `turn.step measured=${tokens}`)) {
            unmeasured = 0
            yield { kind: 'text', index: 0, text: `[auto-handoff] The next request would carry about ${Math.round(projected / 1000)}k tokens (threshold ${Math.round(threshold / 1000)}k). Stopping this turn to hand off to a fresh session.` }
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
      toastHandedOff($, seededSession!, floor)
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

  on('prompt.submit', async ($, e, next) => {
    if (e.origin && USER_ORIGINS.has(e.origin.kind)) {
      unattended = 0
      pausedSession = undefined
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.transcript_path) transcriptPath = e.transcript_path
    if (e.source === 'startup') await writeMissingTemplates($)
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
      handedFrom = { session: p.oldSession, tokens: p.tokens }
      // One line on screen; the model reads the brief from disk. A full brief as the
      // seed showed up as a wall of text the person never wrote.
      const text = `[auto-handoff] ↪ Handoff from session ${short(p.oldSession)}. The previous session hit its context limit and was cleared. Read the brief at ${p.briefPath} before doing anything else and follow its Instructions section. Open your first reply with the line "↪ Handoff from session ${short(p.oldSession)}".`
      $.prompt.submit({ text }).catch((err: unknown) => log($, `seed rejected ${String(err)}`))
    } catch (err) {
      await log($, `seed error ${String(err)}`)
    }
    return r
  })
}
