import type { SessionMessage } from 'claude-code'
import { renderTemplate, sectionHeadings } from './templates.ts'

// Brief building.
// Files, commits, issues and the last real request come from the transcript in code;
// Haiku only writes the judgment sections. Its reply is checked, and the facts alone
// stand in when it fails.

const MAX_MESSAGES = 120
const MAX_MSG_CHARS = 2_000
const MAX_TRANSCRIPT_CHARS = 150_000

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

/** The transcript as Haiku reads it. Harness signals are labelled so they are not taken for the user. */
export function renderTranscript(messages: readonly SessionMessage[]): string {
  const lines = messages.slice(-MAX_MESSAGES).map(m => {
    const role = m.role === 'user' && m.text.trim() && !userText(m) ? 'system signal (not the user)' : m.role
    const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + ' [truncated]' : m.text
    const tools = m.toolUses.map(t => `  [tool ${t.tool}${t.isError ? ' ERROR' : ''}] ${JSON.stringify(t.input).slice(0, 300)}`)
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

export function briefPrompt(messages: readonly SessionMessage[], facts: Facts, template: string): string {
  // Data first, instructions last.
  return `## Extracted Facts\n${factsBlock(facts)}\n\n## Conversation\n${renderTranscript(messages)}\n\n---\n\n${template.trim()}`
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
}

export function assembleBrief(ctx: BriefContext, facts: Facts, haiku: string | undefined): string {
  const header = `${renderTemplate(ctx.instructions, { priority: haiku ? hasUnansweredLastRequest(haiku) : false })}

## Session Handoff Brief

- **Previous Session:** ${ctx.sessionId}
- **Transcript:** \`${ctx.transcript}\`

## How to Use This Brief
${haiku ? 'Haiku wrote the judgment sections from conversation text with tool output abbreviated. The facts sections came from tool calls in code.' : 'Haiku did not return a usable brief, so this holds only facts extracted in code. Read the transcript for the rest.'} Treat every line as a starting point, not a fact. Before acting on anything here, spawn a subagent to verify: run git status, gh pr view, or Read the file directly. If a fact is missing, grep the transcript before asking the user.`
  // A valid Haiku brief already quotes the last request in its own section.
  return [header, haiku?.trim(), factsBlock(facts, !haiku)].filter(Boolean).join('\n\n')
}
