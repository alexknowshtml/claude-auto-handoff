// Settings from /config and the constants built on them. Engine-free: the host follows $ only
// into functions declared in register.tsx, so anything taking $ stays there.

export const BRIEF_DIR = '.claude/state/auto-handoff'
// The two numbers are userConfig fields (plugin.json), set in /config. Defaults match the manifest.
// threshold: 150k, from 13,574 requests across 272 sessions on this machine (2026-10-04). Every
// request re-reads its whole context from cache, so a lower line costs less per unit of work until
// the fixed cost of a handoff (fresh prefix writes, the brief, re-reads) takes over. Measured: 1.8k
// tokens of growth per request, a seeded session productive from ~74k after ~29k of fresh writes,
// ~1.3k tokens of re-reads after a handoff, and no latency growth with context. Lowest token cost
// at 125k, lowest cost plus wall time at 140k; 300k costs about 35% more per unit of work. With
// SOFT_MARGIN the model hands off between 130k and 150k, around that optimum.
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
// machine's Tailscale IP, or 127.0.0.1 without Tailscale. Blank, the default: no server, and the
// link is the local file.
// historyLines: how many lines of project history a brief carries (history.ts).
// briefWriter: "fork", the default, has the session's own model write the brief over its cached
// transcript, so it sees the whole session; "haiku" has Haiku write it from the last 120 messages.
// A fork that fails falls back to Haiku.
export type BriefWriter = 'fork' | 'haiku'
export type Config = { threshold: number; maxUnattended: number; briefTemplate: string; instructionsTemplate: string; ignoreFiles?: RegExp; viewer: string; historyLines: number; briefWriter: BriefWriter }
export const DEFAULTS: Config = { threshold: 150_000, maxUnattended: 2, briefTemplate: '~/.claude/auto-handoff/brief.md', instructionsTemplate: '~/.claude/auto-handoff/instructions.md', viewer: '', historyLines: 24, briefWriter: 'fork' }
export const MIN_HEADROOM = 40_000
// The soft line sits this far below the threshold. Past it, the next tool result tells the model
// to finish its step and call the handoff tool with the brief as its argument: the brief is then
// written inside a request the session was making anyway. 20k is about 11 requests at the measured
// mean growth, 6 at the 90th percentile.
export const SOFT_MARGIN = 20_000
// The threshold never sits closer than this to the context window: the turn in flight needs the
// room. A 300k threshold becomes 160k on a 200k window; on a 1M window it stays 300k.
export const WINDOW_RESERVE = 40_000
// The longest one history entry or summary may be, in characters (about 150 tokens).
export const HISTORY_CHARS = 600
// Each template's default, a file in the mod's templates/ folder.
export const TEMPLATES = [['briefTemplate', 'brief.md'], ['instructionsTemplate', 'instructions.md']] as const
export type TemplateKey = typeof TEMPLATES[number][0]
// Used only when the shipped default is unreadable too, so the fresh session still knows what to do.
export const LAST_RESORT_INSTRUCTIONS = '## Instructions\n\nThis turn was triggered by the system, not by a user. Read this brief and continue the work it describes.'

export const k = (n: number) => `${Math.round(n / 1000)}k`
export const short = (sessionId: string) => sessionId.slice(0, 8)
export const expand = (path: string, home: string) => path.replace(/^~(?=\/|$)/, home)

// A non-positive or non-numeric value falls back to the default rather than handing off at 0.
const num = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
const str = (v: unknown, fallback: string) => typeof v === 'string' && v.trim() ? v.trim() : fallback
// A bad pattern is dropped, not fatal: a typo in /config should not stop handoffs.
function pattern(v: unknown): RegExp | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  try { return new RegExp(v) } catch { return undefined }
}

/** The /config values, each checked, with the manifest's defaults for anything missing or bad. */
export function parseConfig(options: Record<string, unknown>): Config {
  return {
  threshold: num(options.threshold, DEFAULTS.threshold),
  maxUnattended: num(options.maxConsecutiveHandoffs, DEFAULTS.maxUnattended),
  briefTemplate: str(options.briefTemplate, DEFAULTS.briefTemplate),
  instructionsTemplate: str(options.instructionsTemplate, DEFAULTS.instructionsTemplate),
  ignoreFiles: pattern(options.ignoreFiles),
  viewer: typeof options.viewer === 'string' ? options.viewer.trim() : DEFAULTS.viewer,
  historyLines: Math.floor(num(options.historyLines, DEFAULTS.historyLines)),
  briefWriter: str(options.briefWriter, '').toLowerCase() === 'haiku' ? 'haiku' : DEFAULTS.briefWriter,
  }
}

// The seed prompt's first characters; the render hook knows the seed row by them.
export const SEED_PREFIX = '[auto-handoff] ↪ Handoff from session'

/** A token count as typed after /handoff: "60k", "60000", "1.5m". Undefined when it is not one. */
export function parseTokens(arg: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(arg.trim())
  if (!m) return undefined
  const n = Number(m[1]) * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2] ? 1_000 : 1)
  return Number.isFinite(n) && n >= 1_000 ? Math.round(n) : undefined
}
// The seed text with its brief path and viewer URL as markdown links. The path becomes a
// file: link labelled by its file name; the URL links to itself. Exported for the test.
export function linkify(text: string): string {
  return text
    .replace(/(?<=\bat )(\/\S+\.md)(?=[\s)]|$)/, (p) => `[${p.slice(p.lastIndexOf('/') + 1)}](file://${p})`)
    .replace(/(https?:\/\/[^\s)]+)/, (u) => `[${u}](${u})`)
}
