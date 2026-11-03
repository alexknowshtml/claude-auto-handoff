import { describe, expect, test } from 'claude-code/testing'
import { modelThreshold, parseConfig, parseModelThresholds } from '../hooks/config.ts'

describe('modelThresholds', () => {
  test('parses name=tokens pairs, k suffix and loose spacing; drops bad entries', () => {
    expect(parseModelThresholds('haiku=100000, sonnet = 300k; bad, opus=0, =5')).toEqual([['sonnet', 300000], ['haiku', 100000]])
    expect(parseModelThresholds('')).toEqual([])
    expect(parseModelThresholds(undefined)).toEqual([])
  })

  test('matches by substring, case-insensitive, longest key first', () => {
    const cfg = parseConfig({ threshold: 400000, modelThresholds: 'haiku=100000, haiku-4-5=150000' })
    expect(modelThreshold(cfg, 'claude-haiku-5-5')).toEqual(['haiku', 100000])
    expect(modelThreshold(cfg, 'us.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual(['haiku-4-5', 150000])
    expect(modelThreshold(cfg, 'Haiku')).toEqual(['haiku', 100000])
    expect(modelThreshold(cfg, 'claude-opus-5-5[1m]')).toBeUndefined()
    expect(modelThreshold(cfg, undefined)).toBeUndefined()
  })

  test('no option keeps the plain threshold for every model', () => {
    const cfg = parseConfig({ threshold: 400000 })
    expect(cfg.modelThresholds).toEqual([])
    expect(modelThreshold(cfg, 'claude-haiku-5-5')).toBeUndefined()
  })
})
