/**
 * List prices in US dollars per million tokens, for the cost line in the log only (an estimate:
 * the bill is Anthropic's). Thinking tokens are billed as output. A model missing here logs no cost.
 */
const PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
}

/** $ per million tokens is micro-dollars per token, so the estimate is integer arithmetic. */
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model]
  return p ? p.input * inputTokens + p.output * outputTokens : null
}
