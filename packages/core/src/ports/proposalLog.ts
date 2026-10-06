/**
 * One line per proposal attempt, for operators: counts, latency and cost. Never message text,
 * names, instructions or reasons (they are other people's words).
 */
export type ProposalLogEntry = {
  proposalId: string | null
  mode: 'messages' | 'criteria'
  /** `proposed`, or the error code that stopped it. */
  outcome: string
  /** Message mode: messages sent to the model. */
  sourceMessages: number
  /** Criteria mode: messages counted from channel history. */
  scannedMessages: number
  lines: number
  held: number
  unregistered: number
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** US dollars, as a decimal string (for example "0.0123"), estimated from the list price. */
  costUsd: string | null
  latencyMs: number | null
}

export type ProposalLog = (entry: ProposalLogEntry) => void
