import { describe, expect, it } from 'vitest'
import { costMicroUsd } from './pricing.js'

const none = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 }

describe('costMicroUsd: list prices, cache writes and reads included', () => {
  // Sonnet 5.5 (platform pricing page, 2026-10-07): $2 input, $2.50 5-minute cache write,
  // $4 1-hour cache write, $0.20 cache read, $10 output, per million tokens.
  it.each([
    ['input', { inputTokens: 1_000_000 }, 2_000_000],
    ['5-minute cache write', { cacheWrite5mTokens: 1_000_000 }, 2_500_000],
    ['1-hour cache write', { cacheWrite1hTokens: 1_000_000 }, 4_000_000],
    ['cache read', { cacheReadTokens: 1_000_000 }, 200_000],
    ['output', { outputTokens: 1_000_000 }, 10_000_000],
  ])('Sonnet 5.5, a million tokens of %s', (_kind, tokens, micros) => {
    expect(costMicroUsd('claude-sonnet-5-5', { ...none, ...tokens })).toBe(micros)
  })

  it('Opus 5.5 reads its cache at 0.05x its input price', () => {
    expect(costMicroUsd('claude-opus-5-5', { ...none, inputTokens: 1_000_000, cacheWrite1hTokens: 1_000_000, cacheReadTokens: 1_000_000 })).toBe(4_000_000 + 8_000_000 + 200_000)
  })

  it('a cold proposal (prefix written to the 1-hour cache) and a warm one (prefix read), whole micro-dollars', () => {
    expect(costMicroUsd('claude-sonnet-5-5', { ...none, inputTokens: 300, cacheWrite1hTokens: 3000, outputTokens: 500 })).toBe(600 + 12_000 + 5_000)
    expect(costMicroUsd('claude-sonnet-5-5', { ...none, inputTokens: 300, cacheReadTokens: 3000, outputTokens: 500 })).toBe(600 + 600 + 5_000)
    // 7 cache-read tokens are 1.4 micro-dollars: rounded, never a fraction (the log turns it into a bigint).
    expect(Number.isInteger(costMicroUsd('claude-sonnet-5-5', { ...none, cacheReadTokens: 7 }))).toBe(true)
  })

  it('a model with no price logs no cost', () => {
    expect(costMicroUsd('claude-unknown-1', { ...none, inputTokens: 10 })).toBeNull()
  })
})
