import type { SessionMessage } from 'claude-code'
import { renderTemplate, sectionHeadings } from './templates.ts'

// Brief building.
// Files, commits, issues and the last real request come from the transcript in code;
// a model only writes the judgment sections: the session's own model through a fork, which
// reads the whole conversation from its cache, else Haiku from a rendered copy of its tail.
// The reply is checked, and the facts alone stand in when it fails.

const MAX_MESSAGES = 120
const MAX_MSG_CHARS = 2_000
// A tool's output as Haiku reads it: the head and the tail, so an error at the end survives.
const MAX_TOOL_CHARS = 800
const MAX_TRANSCRIPT_CHARS = 150_000
// The brief this session started from, read from disk: the seed turn's read of it has usually
// left the last MAX_MESSAGES by the time this session hands off.
const MAX_PREVIOUS_CHARS = 40_000

// Harness signals that arrive as user messages but are never the user's words.
const META_PREFIXES = ['Stop hook feedback', '[Automatic handoff]', '[auto-handoff]', '[Image', '<system-reminder>', '<command-name>', '<local-command']

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const GIT_COMMIT_OUTPUT = /^\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/m

export type Facts = {
  filesModified: string[]
  commits: string[]
  issues: string[]
  lastUserMessage?: string
  handoffTokens?: number
  threshold?: number
  /** Where the base threshold came from: the env override or the /config setting. */
  thresholdSource?: string
  seededSessionStartSize?: number
  /** Handoffs since the user last typed, this one included. */
  unattendedCount?: number
  /** Which handoff this is in its chain (1 for the first, 2 for the second, etc.). */
  depth?: number
  /** What started the handoff: the threshold, the handoff tool, or /handoff. */
  trigger?: string
}

/** The user's own words, or undefined for a harness signal or a tool-result-only message. */
export function userText(m: SessionMessage): string | undefined {
  if (m.role !== 'user') return undefined
  const raw = m.text.trim()
  if (!raw) return undefined
  return isMeta(raw) ? undefined : raw
}

function isMeta(text: string): boolean {
  return META_PREFIXES.some(p => text.startsWith(p))
}

function commitSubject(command: string): string | undefined {
  if (!/\bgit\b[^\n|;&]*\bcommit\b/.test(command)) return undefined
  const heredoc = command.match(/<<\s*'?(\w+)'?\n([\s\S]*?)\n\1/)
  if (heredoc) return heredoc[2]?.trim().split('\n')[0]
  return command.match(/-m\s+(["'])(.+?)\1/)?.[2]
}

/** ignoreFiles: paths that never count as edits (auto-synced state, caches); the ignoreFiles setting. */
export function extractFacts(messages: readonly SessionMessage[], ignoreFiles?: RegExp): Facts {
  const files = new Set<string>()
  const commits: string[] = []
  const issues = new Set<string>()
  let lastUserMessage: string | undefined
  for (const m of messages) {
    const said = userText(m)
    if (said) lastUserMessage = said
    for (const n of `${said ?? (m.role === 'assistant' ? m.text : '')}`.matchAll(/(?<![\w&/])#(\d{2,5})\b/g)) issues.add(`#${n[1]}`)
    for (const t of m.toolUses) {
      const path = t.input.file_path ?? t.input.notebook_path
      if (EDIT_TOOLS.has(t.tool) && typeof path === 'string' && !t.isError && !ignoreFiles?.test(path)) files.add(path)
      if (t.tool !== 'Bash' || typeof t.input.command !== 'string' || t.isError) continue
      // git's own "[main abc1234] subject" line is the proof a commit landed; the command is the fallback
      const out = t.text?.match(GIT_COMMIT_OUTPUT)
      const subject = out ? `${out[2]} (${out[1]})` : t.text === undefined ? commitSubject(t.input.command) : undefined
      if (subject && !commits.includes(subject)) commits.push(subject)
    }
  }
  return { filesModified: [...files].slice(-20), commits: commits.slice(-10), issues: [...issues].slice(-15), lastUserMessage }
}

/** Head and tail of a long text, cut marked. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.75)
  return `${text.slice(0, head)} […] ${text.slice(text.length - (max - head))}`
}

/** The transcript as Haiku reads it: each call with what it returned. Harness signals are
 * labelled so they are not taken for the user. */
export function renderTranscript(messages: readonly SessionMessage[]): string {
  const lines = messages.slice(-MAX_MESSAGES).map(m => {
    const role = m.role === 'user' && m.text.trim() && !userText(m) ? 'system signal (not the user)' : m.role
    const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + ' [truncated]' : m.text
    const tools = m.toolUses.map(t => {
      const call = `  [tool ${t.tool}${t.isError ? ' ERROR' : ''}] ${JSON.stringify(t.input).slice(0, 300)}`
      const out = t.text?.trim()
      return out ? `${call}\n  → ${clip(out, MAX_TOOL_CHARS)}` : call
    })
    return [`### ${role}`, text, ...tools].filter(Boolean).join('\n')
  })
  const joined = lines.join('\n\n')
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined
}

function list(items: string[], empty: string): string {
  return items.length ? items.map(i => `- ${i}`).join('\n') : empty
}

// The only token figures the brief may use. Haiku once wrote "burned its 200k budget" for a
// session at 93k because the prompt held no numbers at all.
function handoffNumbersBlock(f: Facts): string {
  const lines = []
  if (f.depth !== undefined) lines.push(`- **Handoff depth:** ${f.depth}`)
  if (f.trigger) lines.push(`- **Trigger:** ${f.trigger}`)
  if (f.handoffTokens !== undefined) lines.push(`- **Tokens at handoff:** ${f.handoffTokens} (${k(f.handoffTokens)})`)
  if (f.threshold !== undefined) lines.push(`- **Threshold:** ${f.threshold} (${k(f.threshold)})${f.thresholdSource ? `, from ${f.thresholdSource}` : ''}`)
  if (f.seededSessionStartSize !== undefined) lines.push(`- **This session's starting size (seeded from a handoff):** ${f.seededSessionStartSize} (${k(f.seededSessionStartSize)})`)
  if (f.unattendedCount !== undefined) lines.push(`- **Handoffs in a row with no user message:** ${f.unattendedCount}`)
  return lines.length ? `## Handoff Numbers\n${lines.join('\n')}\n` : ''
}

const k = (n: number) => `${Math.round(n / 1000)}k`

export function factsBlock(f: Facts, withLastMessage = true): string {
  const numbers = handoffNumbersBlock(f)
  const files = `## Files Modified (from Edit/Write calls)
${list(f.filesModified, 'None.')}

## Commits This Session
${list(f.commits, 'None.')}

## GitHub Issues Mentioned
${f.issues.length ? f.issues.join(', ') : 'None.'}`
  const all = [numbers, files].filter(Boolean).join('\n')
  return withLastMessage ? `${all}\n\n## Last Real User Message (verbatim)\n${f.lastUserMessage ?? 'None found.'}` : all
}

// Its headings drop a level, so they cannot be read as sections of the brief being written.
function previousBlock(previous: string | undefined, where: string): string {
  return previous?.trim()
    ? `## Previous Brief\nThe brief this session started from. Carry forward whatever in it is still relevant and was not settled in ${where}: the goal, decisions, dead ends, open questions.\n\n${clip(previous.trim(), MAX_PREVIOUS_CHARS).replace(/^(#{2,5}) /gm, '#$1 ')}\n\n`
    : ''
}

/** previous: the body of the brief this session started from, when it was seeded by a handoff. */
export function briefPrompt(messages: readonly SessionMessage[], facts: Facts, template: string, previous?: string): string {
  // Data first, instructions last.
  return `## Extracted Facts\n${factsBlock(facts)}\n\n${previousBlock(previous, 'the conversation below')}## Conversation\n${renderTranscript(messages)}\n\n---\n\n${template.trim()}`
}

/** The template from its first section on: its preamble is written for Haiku reading a rendered transcript. */
export function briefSections(template: string): string {
  const at = template.search(/^## /m)
  return (at >= 0 ? template.slice(at) : template).trim()
}

/** The fork's one message, after the session's own transcript: no rendered copy of it. */
export function forkPrompt(facts: Facts, template: string, previous?: string): string {
  return `[auto-handoff] This session is at its context limit and will be cleared. Write a handoff brief for a fresh session that will see none of this conversation. Reply with the brief's sections as text only: call no tools, and do not continue the work. Copy any token figure from Handoff Numbers below; never estimate one. Files and commits are added from the facts: leave them out.\n\n## Extracted Facts\n${factsBlock(facts)}\n\n${previousBlock(previous, 'this conversation')}---\n\n${briefSections(template)}`
}

/**
 * Read by the model after a tool result once the context passes the soft line: hand off at the
 * next boundary, the brief as the handoff tool's argument. Written inside a request the session
 * was making anyway, the brief costs its output tokens and nothing more.
 */
export function softNote(tool: string, tokens: number, threshold: number, template: string): string {
  return `[auto-handoff] Context is at about ${k(tokens)} tokens; this session hands off at ${k(threshold)}. Finish the work in hand in this turn (do not start new work). If the user is waiting for a reply, write it in full first: the handoff call is the last thing in your turn. Then call ${tool} with \`brief\`: a handoff brief for a fresh session that will see none of this conversation. Use these sections in this order, omitting empty ones. State no token counts and list no files or commits: code adds those. In "Last Request from the User", mark it Answered only if a reply the user can already see answers it. Make no tool calls after it.\n\n${briefSections(template)}`
}

/** The brief's closing section: what the user last saw, so the next session does not redo it. */
export function replySection(reply: string): string {
  return reply
    ? `## Final Reply Shown to the User\nThe previous session's last reply, verbatim. Where it answers the Last Request, that request is answered: do not answer it again.\n\n${reply}\n`
    : `## Final Reply Shown to the User\nThe previous session's final response called the handoff tool with no reply text. Go by the Last Request status above.\n`
}

/** A reply that holds none of the template's sections is a dialogue fragment, not a brief. */
export function isValidBrief(text: string, template: string): boolean {
  return sectionHeadings(template).some(h => text.includes(h))
}

// Whether the brief's last-request section
// says the request is not (fully) answered. A chain with no user message is not a real request.
export function hasUnansweredLastRequest(text: string): boolean {
  const heading = /##\s*Last Request from the User/i.exec(text)
  if (!heading) return false
  const rest = text.slice(heading.index + heading[0].length)
  const next = /^#{1,6}\s/m.exec(rest)
  const section = next ? rest.slice(0, next.index) : rest
  if (/No user message found|^\s*\[auto-handoff\]/i.test(section)) return false
  return /\bStatus[\s*_`]*:[\s*_`"]*(Not (?:yet |fully )?answered|Partially answered|Unanswered)/i.test(section)
}

export type BriefContext = {
  sessionId: string
  /** The session's transcript file. */
  transcript: string
  /** The instructions template, rendered at the top of the brief. */
  instructions: string
  /** Who wrote the judgment sections: the model in its handoff call, a fork of it, or Haiku. */
  writer?: 'tool' | 'fork' | 'haiku'
}

/** history: the Project History section (history.ts), or '' for none. */
export function assembleBrief(ctx: BriefContext, facts: Facts, haiku: string | undefined, history = ''): string {
  const header = `${renderTemplate(ctx.instructions, { priority: haiku ? hasUnansweredLastRequest(haiku) : false })}

## Session Handoff Brief

- **Previous Session:** ${ctx.sessionId}
- **Transcript:** \`${ctx.transcript}\`

## How to Use This Brief
${!haiku ? 'The brief writer did not return a usable brief, so this holds only facts extracted in code. Read the transcript for the rest.' : ctx.writer === 'tool' || ctx.writer === 'fork' ? "The session's own model wrote the judgment sections with the whole conversation in view, plus the brief this session started from. The facts sections came from tool calls in code." : 'Haiku wrote the judgment sections from the conversation, tool output abbreviated, and the brief this session started from. The facts sections came from tool calls in code.'} Treat every line as a starting point, not a fact. If a fact is missing, grep the transcript before asking the user.`
  // A valid Haiku brief already quotes the last request in its own section.
  return [header, haiku?.trim(), factsBlock(facts, !haiku), history].filter(Boolean).join('\n\n')
}

// A token figure: "93k", "93.1k", "93,105 tokens", "93105 tokens".
const TOKEN_FIGURE = /\b(\d{1,4}(?:\.\d+)?)k\b|\b(\d{1,3}(?:,\d{3})+|\d{4,7})(?= tokens\b)/gi

const figureValue = (k?: string, whole?: string) => k !== undefined ? Number(k) * 1000 : Number(whole!.replace(/,/g, ''))

/**
 * Marks every token figure in Haiku's text that the Handoff Numbers block does not hold, within
 * rounding to the nearest thousand. The template asks Haiku to copy those numbers; this makes it a
 * rule. Figures are marked, not removed, so the next session sees what was claimed and that it is
 * unchecked. With no numbers block, every figure is marked.
 */
export function markUnverifiedFigures(text: string, f: Facts): { text: string; flagged: string[] } {
  const block = handoffNumbersBlock(f)
  const allowed = [
    ...[...block.matchAll(/\b(\d{1,4}(?:\.\d+)?)k\b/g)].map(m => figureValue(m[1])),
    ...[...block.matchAll(/\b\d{4,7}\b/g)].map(m => Number(m[0])),
  ]
  const flagged: string[] = []
  const marked = text.replace(TOKEN_FIGURE, (match: string, k?: string, whole?: string) => {
    const value = figureValue(k, whole)
    if (allowed.some(a => Math.abs(a - value) < 1000)) return match
    flagged.push(match)
    return `${match} [unverified: not in Handoff Numbers]`
  })
  return { text: marked, flagged }
}
