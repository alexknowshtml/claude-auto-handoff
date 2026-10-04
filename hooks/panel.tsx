// The band above the prompt is the mod's whole UI: a header line and the steps under it, with
// a braille spinner on whatever is still running. A toast cannot animate or carry a link, so the
// panel replaced them. This file draws; register.tsx holds the panel and its timers, since the
// host never follows $ across an import.

export type Mark = 'spin' | 'done' | 'warn' | 'fail'
export type Line = { mark: Mark; text: string }
// sticky: stays until dismissed (a failure, the pause, a warning); otherwise a panel with nothing
// spinning collapses on its own.
export type Panel = { header: Line; steps: Line[]; link?: string; sticky?: boolean }

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const GLYPH: Record<Exclude<Mark, 'spin'>, string> = { done: '✓', warn: '⚠', fail: '✗' }
const COLOR: Record<Mark, string> = { spin: 'yellow', done: 'green', warn: 'yellow', fail: 'red' }

export const isSpinning = (p: Panel) => p.header.mark === 'spin' || p.steps.some((l) => l.mark === 'spin')

// The plain text of the panel, one line per row, for logs and tests.
export const panelText = (p: Panel, frame = 0) =>
  [p.header, ...p.steps].map((l, i) => `${i ? '  ' : ''}${glyph(l.mark, frame)} ${l.text}`).join('\n')

const glyph = (m: Mark, frame: number) => m === 'spin' ? SPINNER[frame % SPINNER.length] : GLYPH[m]

// The elements come from $.ui.resolve in the render hook.
type Elements = { Box: any; Text: any; Markdown: any; Button: any }

export function panelTree({ Box, Text, Markdown, Button }: Elements, p: Panel, frame: number, onDismiss: () => void) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLOR[p.header.mark]}>{glyph(p.header.mark, frame)} </Text>
        <Text bold>{p.header.text}</Text>
      </Box>
      {p.steps.map((l, i) => (
        <Box key={`step-${i}`}>
          <Text>  </Text>
          <Text color={COLOR[l.mark]}>{glyph(l.mark, frame)} </Text>
          <Text dimColor={l.mark === 'done'}>{l.text}</Text>
        </Box>
      ))}
      {p.link ? <Markdown text={`  [open brief](${p.link})`} /> : null}
      {p.sticky ? <Button key="dismiss" label="Dismiss" onPress={onDismiss} /> : null}
    </Box>
  )
}
