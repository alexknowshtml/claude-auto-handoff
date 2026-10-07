// Project history: OptMem's fixed-budget memory, fed by handoffs. Every handoff appends one entry
// to its project's log: a short digest of the session it ends. Pairs of entries compress into one
// summary, pairs of those into one, and so on, a binary tree over the log. A brief shows the log
// through that tree in a fixed number of lines, recent entries whole and older ones merged, so a
// session ten handoffs deep still sees the project's whole arc. Engine-free: register.tsx does
// the reading, writing and model calls.

import { HISTORY_CHARS } from './config.ts'

export type Entry = { at: string; session: string; transcript?: string; text: string }
/** [lo, hi): an aligned power-of-two range of entries. */
export type Block = readonly [number, number]

export const HISTORY_HEADING = '## Project History'

export const blockId = ([lo, hi]: Block) => `${lo}-${hi - 1}`

/** Tile [0,T) with aligned power-of-two blocks; a block stays whole iff its size is at most
 * alpha times its age. Bigger alpha, coarser blocks, fewer lines. */
function tile(T: number, alpha: number): Block[] {
  let root = 1
  while (root < T) root *= 2
  const out: Block[] = []
  const stack: Block[] = [[0, root]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (lo >= T) continue
    const size = hi - lo
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = (lo + hi) / 2
      stack.push([mid, hi], [lo, mid])
    } else out.push([lo, hi])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** The blocks a brief shows: at most `budget`, finest near the present. When every entry fits,
 * each is its own line and nothing is compressed. */
export function cover(T: number, budget: number): Block[] {
  if (T <= 0) return []
  if (T <= budget) return Array.from({ length: T }, (_, i) => [i, i + 1] as const)
  let lo = 0
  let hi = T
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (tile(T, mid).length > budget) lo = mid
    else hi = mid
  }
  const out = tile(T, hi)
  // Block sizes jump in powers of two, so alpha alone can undershoot the budget. Spend what is
  // left on the present, where detail is worth most.
  while (out.length < budget) {
    let i = out.length - 1
    while (i >= 0 && out[i]![1] - out[i]![0] === 1) i--
    if (i < 0) break
    const [a, b] = out[i]!
    const mid = (a + b) / 2
    out.splice(i, 1, [a, mid], [mid, b])
  }
  return out
}

/** Blocks whose entries all exist and that have no summary yet, smallest first, so a block's
 * halves are always built before it. */
export function pending(T: number, has: (b: Block) => boolean): Block[] {
  const out: Block[] = []
  for (let size = 2; size <= T; size *= 2)
    for (let lo = 0; lo + size <= T; lo += size) if (!has([lo, lo + size])) out.push([lo, lo + size])
  return out
}

/** The log: one JSON entry per line. A line that does not parse (a torn write) is skipped. */
export function parseLog(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as Partial<Entry>
      if (typeof e.text === 'string' && typeof e.at === 'string' && typeof e.session === 'string') out.push({ at: e.at, session: e.session, transcript: typeof e.transcript === 'string' ? e.transcript : undefined, text: e.text })
    } catch {}
  }
  return out
}

/** The tree: block id to summary. Anything malformed reads as no summaries; the next run rebuilds them. */
export function parseTree(text: string | undefined): Record<string, string> {
  try {
    const v = JSON.parse(text ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter(([, s]) => typeof s === 'string' && s.trim())) as Record<string, string>
  } catch {
    return {}
  }
}

/** One line of model output made fit for the log: newlines folded, cut to the limit. */
export function oneParagraph(text: string, max = HISTORY_CHARS): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const day = (iso: string) => iso.slice(0, 10)

/** The history as a brief shows it: one line per block of the cover, a block's summary where the
 * tree has one and its halves where it does not yet. A missing summary can push past the budget;
 * past twice the budget the oldest lines go, and the count says so. */
export function renderHistory(entries: readonly Entry[], tree: Record<string, string>, budget: number): { lines: string[]; omitted: number } {
  const lines: string[] = []
  const show = (b: Block) => {
    const [lo, hi] = b
    if (hi - lo === 1) {
      const e = entries[lo]!
      lines.push(`#${lo} ${day(e.at)} ${e.session.slice(0, 8)} · ${e.text}`)
      return
    }
    const s = tree[blockId(b)]
    if (s) {
      lines.push(`#${blockId(b)} ${day(entries[lo]!.at)}..${day(entries[hi - 1]!.at)} · ${s}`)
      return
    }
    const mid = (lo + hi) / 2
    show([lo, mid])
    show([mid, hi])
  }
  for (const b of cover(entries.length, budget)) show(b)
  const cap = budget * 2
  const omitted = Math.max(0, lines.length - cap)
  return { lines: lines.slice(omitted), omitted }
}

/** The section a brief carries, or '' for a project with no history yet. */
export function historySection(entries: readonly Entry[], tree: Record<string, string>, budget: number, logPath: string): string {
  if (!entries.length) return ''
  const { lines, omitted } = renderHistory(entries, tree, budget)
  const note = omitted ? `\n(${omitted} older lines not shown while their summaries are pending.)` : ''
  return `${HISTORY_HEADING}
Earlier sessions in this project, oldest first: recent ones whole, older ones merged. \`#a-b\` names entries in the log at \`${logPath}\`; grep it for the full entries, each of which names its session's transcript.

${lines.join('\n')}${note}`
}

/** What the model is asked for one log entry: the digest of a brief. */
export function digestPrompt(brief: string, max = HISTORY_CHARS): string {
  return `Below is the handoff brief of one coding session. Write that session's entry in the project's long-term history: one paragraph of at most ${max} characters. Keep what has lasting effect: what was done, decisions and why, dead ends, what is still open. Drop process detail and anything only this session needed. Invent nothing. Output only the paragraph.

${brief}`
}

/** What the model is asked for one summary: two consecutive parts merged into one. */
export function compressPrompt(halves: readonly [string, string], max = HISTORY_CHARS): string {
  return `Merge these two consecutive parts of a project's history, older first, into one paragraph of at most ${max} characters. Keep what has lasting effect: outcomes, decisions and why, dead ends, threads still open. Drop what does not. Invent nothing. Output only the paragraph.

${halves[0]}

${halves[1]}`
}

/** A half of a block as its parent's compression reads it: the entry itself, or its summary. */
export function halfText(entries: readonly Entry[], tree: Record<string, string>, b: Block): string | undefined {
  return b[1] - b[0] === 1 ? entries[b[0]]?.text : tree[blockId(b)]
}

/** A project's folder name: the repository root (or the cwd) with every non-alphanumeric as '-',
 * as Claude Code names its project folders. */
export const projectKey = (root: string) => root.replace(/[^a-zA-Z0-9]/g, '-')

/** The repository root from `git rev-parse --path-format=absolute --git-common-dir`, so every
 * worktree of one repository shares one history. Undefined when git gave nothing usable. */
export function repoRoot(gitCommonDir: string): string | undefined {
  const dir = gitCommonDir.trim().split('\n')[0]?.trim()
  if (!dir || !dir.startsWith('/')) return undefined
  return dir.endsWith('/.git') ? dir.slice(0, -5) : dir
}
