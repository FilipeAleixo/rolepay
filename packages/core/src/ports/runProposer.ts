import type { RawCriteriaProposal, RawMessageProposal } from '../domain/proposal/raw.js'
import type { ChannelKind, PseudonymizedMessage } from '../domain/proposal/sources.js'
import type { Result } from '../domain/result.js'

/** What one model call cost. Logged per proposal; never any text. */
export type ProposerUsage = {
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  /** Estimated from the model's list price, in micro-dollars. null for a model Rolepay has no price for. */
  costMicroUsd: number | null
}

/**
 * The model could not produce a usable proposal. `detail` is for operators' logs only and never
 * carries message text (an HTTP status, a schema path, a stop reason). `daily_cap`: the server's
 * cap on model calls per UTC day was reached and the model was not called (ROLEPAY_AI_DAILY_CAP).
 */
export type ProposerFailure = {
  code: 'could_not_propose'
  reason: 'refused' | 'malformed' | 'unavailable' | 'rejected' | 'auth' | 'daily_cap'
  detail: string
  usage: ProposerUsage | null
}

/**
 * Message mode. The instruction is trusted (only the approver or proposer role can propose); the
 * messages are untrusted data written by anyone in the channel. Every Discord ID is a token.
 */
export type MessageProposalRequest = {
  instruction: string
  messages: PseudonymizedMessage[]
  /** The payout token's symbol, for example "AlphaUSD". */
  token: string
  /** What the bot key has left, as a decimal string, or null when there is no active key. */
  remaining: string | null
  maxLines: number
}

/**
 * Criteria mode. The model sees only the instruction, the vocabulary of filters (in the output
 * schema), and the server's role and channel names by token. Never the member list.
 */
export type CriteriaProposalRequest = {
  instruction: string
  /** Today, YYYY-MM-DD (UTC), so "this month" and "last 7 days" become dates. */
  today: string
  maxLookbackDays: number
  roles: { ref: string; name: string }[]
  channels: { ref: string; name: string; kind: ChannelKind }[]
  token: string
  remaining: string | null
}

export type Proposed<T> = Result<{ raw: T; usage: ProposerUsage }, ProposerFailure>

/**
 * Turns an instruction into a raw proposal (tokens and the amounts as written). Code checks
 * everything it returns; it never approves, signs or pays. The production adapter is Anthropic's
 * API (`@rolepay/core/adapters`); tests use a deterministic fake.
 */
export interface RunProposer {
  readonly model: string
  fromMessages(request: MessageProposalRequest): Promise<Proposed<RawMessageProposal>>
  fromCriteria(request: CriteriaProposalRequest): Promise<Proposed<RawCriteriaProposal>>
}
