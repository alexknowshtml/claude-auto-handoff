// Settings from /config and the constants built on them. Engine-free: the host follows $ only
// into functions declared in register.tsx, so anything taking $ stays there.

export const BRIEF_DIR = '.claude/state/auto-handoff'
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
// modelThresholds: per-model overrides of threshold, "haiku=100000, sonnet=300000". Each key matches
// when the model's name contains it (case-insensitive), so "haiku" covers claude-haiku-5-5, a Bedrock
// id or the alias; the longest matching key wins, so "haiku-4-5" can sit beside "haiku".
export type Config = { threshold: number; modelThresholds: Array<[string, number]>; maxUnattended: number; briefTemplate: string; instructionsTemplate: string; ignoreFiles?: RegExp; viewer: string }
export const DEFAULTS: Config = { threshold: 160_000, modelThresholds: [], maxUnattended: 2, briefTemplate: '~/.claude/auto-handoff/brief.md', instructionsTemplate: '~/.claude/auto-handoff/instructions.md', viewer: 'tailscale:3846' }
export const MIN_HEADROOM = 40_000
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

// "haiku=100000, sonnet = 300k" -> [['haiku', 100000], ['sonnet', 300000]]; bad entries are dropped.
export function parseModelThresholds(v: unknown): Array<[string, number]> {
  if (typeof v !== 'string') return []
  const out: Array<[string, number]> = []
  for (const part of v.split(/[,;\n]/)) {
    const m = part.trim().match(/^([\w.\-]+)\s*[=:]\s*(\d+(?:\.\d+)?)\s*(k?)$/i)
    if (!m) continue
    const n = Number(m[2]) * (m[3] ? 1000 : 1)
    if (n > 0) out.push([m[1].toLowerCase(), Math.round(n)])
  }
  return out.sort((a, b) => b[0].length - a[0].length)
}

/** The model-specific threshold for a model name, or undefined when no key matches. */
export function modelThreshold(cfg: Config, model: string | undefined): [string, number] | undefined {
  if (!model) return undefined
  const name = model.toLowerCase()
  return cfg.modelThresholds.find(([key]) => name.includes(key))
}

/** The /config values, each checked, with the manifest's defaults for anything missing or bad. */
export function parseConfig(options: Record<string, unknown>): Config {
  return {
  threshold: num(options.threshold, DEFAULTS.threshold),
  modelThresholds: parseModelThresholds(options.modelThresholds),
  maxUnattended: num(options.maxConsecutiveHandoffs, DEFAULTS.maxUnattended),
  briefTemplate: str(options.briefTemplate, DEFAULTS.briefTemplate),
  instructionsTemplate: str(options.instructionsTemplate, DEFAULTS.instructionsTemplate),
  ignoreFiles: pattern(options.ignoreFiles),
  viewer: typeof options.viewer === 'string' ? options.viewer.trim() : DEFAULTS.viewer,
  }
}

// The seed prompt's first characters; the render hook knows the seed row by them.
export const SEED_PREFIX = '[auto-handoff] ↪ Handoff from session'
// The seed text with its brief path and viewer URL as markdown links. The path becomes a
// file: link labelled by its file name; the URL links to itself. Exported for the test.
export function linkify(text: string): string {
  return text
    .replace(/(?<=\bat )(\/\S+\.md)(?=[\s)]|$)/, (p) => `[${p.slice(p.lastIndexOf('/') + 1)}](file://${p})`)
    .replace(/(https?:\/\/[^\s)]+)/, (u) => `[${u}](${u})`)
}
