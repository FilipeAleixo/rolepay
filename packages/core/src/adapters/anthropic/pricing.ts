/**
 * List prices in US cents per million tokens, for the cost line in the log only (an estimate: the
 * bill is Anthropic's). Cents keep every rate a whole number (a cache read is $0.20). Thinking
 * tokens are billed as output. A model missing here logs no cost. Source: the platform pricing
 * page (platform.claude.com/docs/en/about-claude/pricing), checked 2026-10-07: a 5-minute cache
 * write is 1.25x input, a 1-hour write 2x, a read 0.1x (0.05x on Opus 5.5).
 */
type Rates = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number }
const CENTS_PER_MTOK: Readonly<Record<string, Rates>> = {
  'claude-sonnet-5-5': { input: 200, cacheWrite5m: 250, cacheWrite1h: 400, cacheRead: 20, output: 1000 },
  'claude-opus-5-5': { input: 400, cacheWrite5m: 500, cacheWrite1h: 800, cacheRead: 20, output: 2000 },
  'claude-opus-5': { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
  'claude-opus-4-8': { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
}

/** One call's tokens. `inputTokens` is the uncached part only; the prompt is all three input counts together. */
export type BilledTokens = { inputTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; cacheReadTokens: number; outputTokens: number }

/**
 * $ per million tokens is micro-dollars per token, so a rate in cents per million tokens is in
 * hundredths of a micro-dollar per token. The sum is rounded to whole micro-dollars.
 */
export function costMicroUsd(model: string, t: BilledTokens): number | null {
  const r = CENTS_PER_MTOK[model]
  if (!r) return null
  const cents = r.input * t.inputTokens + r.cacheWrite5m * t.cacheWrite5mTokens + r.cacheWrite1h * t.cacheWrite1hTokens + r.cacheRead * t.cacheReadTokens + r.output * t.outputTokens
  return Math.round(cents / 100)
}
