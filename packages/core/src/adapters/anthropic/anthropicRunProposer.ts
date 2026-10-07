import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { RawCriteriaProposalSchema, RawMessageProposalSchema } from '../../domain/proposal/raw.js'
import { err, ok } from '../../domain/result.js'
import type { CriteriaProposalRequest, MessageProposalRequest, ProposerFailure, ProposerUsage, Proposed, RunProposer } from '../../ports/runProposer.js'
import { outputSchema } from './jsonSchema.js'
import { costMicroUsd } from './pricing.js'
import { CRITERIA_SYSTEM, MESSAGE_SYSTEM, criteriaUserContent, messageUserContent } from './prompts.js'

export const DEFAULT_AI_MODEL = 'claude-sonnet-5-5'

/**
 * Room for the model's thinking plus a 50-line answer. Sonnet 5.5 (and Opus 5.5) think by default
 * and cannot turn it off with `disabled` (a 400); a low effort keeps it short, and this limit
 * leaves room after it.
 */
const MAX_OUTPUT_TOKENS = 16_000
/**
 * The system prompt is the same on every request in a mode, so it is cached, together with the
 * output schema the API renders with it (measured on Sonnet 5.5: 1,844 tokens in message mode,
 * 3,689 in criteria mode; the minimum is 512). One hour, not five minutes: demo traffic is sparse,
 * and a person who reads a proposal and approves it with a passkey easily leaves more than five
 * minutes before the next one. A 1-hour write costs 2x input where a 5-minute one costs 1.25x
 * (about half a cent more for the criteria prefix), and a read 0.1x, so one proposal 5 to 60
 * minutes after another in the same mode pays the difference back. A write only happens after an
 * hour with no request in that mode, so at most about 24 a day per mode.
 */
const CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' } as const

export type AnthropicRunProposerOptions = {
  apiKey: string
  model?: string
  /** Tests pass a fake fetch (recorded responses), so the suite needs no network. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  maxRetries?: number
  timeoutMs?: number
  baseURL?: string
  now?: () => number
}

/**
 * RunProposer over Anthropic's API (the official SDK). One request per proposal: structured
 * output in the JSON schema derived from the domain's Zod schema, then validated with that Zod
 * schema. No `temperature` (the model rejects it), low effort, the default adaptive thinking.
 * The static system prompt is a cached prefix (`CACHE_CONTROL`); the per-request data comes
 * after it. No server-side fallback: the model that answers is the model the demo names.
 * Every failure (refusal, truncated or malformed output, an API error) is a `could_not_propose`
 * result whose `detail` names a status or a stop reason, never any text.
 */
export class AnthropicRunProposer implements RunProposer {
  readonly model: string
  private readonly client: Anthropic
  private readonly now: () => number

  constructor(opts: AnthropicRunProposerOptions) {
    this.model = opts.model ?? DEFAULT_AI_MODEL
    this.now = opts.now ?? (() => Date.now())
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs ?? 120_000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    })
  }

  fromMessages(request: MessageProposalRequest) {
    return this.ask(MESSAGE_SYSTEM, messageUserContent(request), RawMessageProposalSchema)
  }

  fromCriteria(request: CriteriaProposalRequest) {
    return this.ask(CRITERIA_SYSTEM, criteriaUserContent(request), RawCriteriaProposalSchema)
  }

  private async ask<S extends z.ZodType>(system: string, content: string, schema: S): Promise<Proposed<z.infer<S>>> {
    const started = this.now()
    let response: Anthropic.Message
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: outputSchema(schema) } },
        system: [{ type: 'text', text: system, cache_control: CACHE_CONTROL }],
        messages: [{ role: 'user', content }],
      })
    } catch (e) {
      return err(apiFailure(e))
    }
    const usage = usageOf(response, Math.round(this.now() - started))
    const fail = (reason: ProposerFailure['reason'], detail: string) => err<ProposerFailure>({ code: 'could_not_propose', reason, detail, usage })

    if (response.stop_reason === 'refusal') return fail('refused', `refusal${response.stop_details?.category ? ` (${response.stop_details.category})` : ''}`)
    if (response.stop_reason === 'max_tokens') return fail('malformed', 'max_tokens: the answer was cut off')
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    if (!text.trim()) return fail('malformed', `no text (stop_reason ${response.stop_reason})`)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return fail('malformed', 'the answer is not JSON')
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) return fail('malformed', `schema: ${[...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))].slice(0, 5).join(', ')}`)
    return ok({ raw: parsed.data, usage })
  }
}

/**
 * Tokens and the estimated cost. Cache writes are priced by TTL from the response's breakdown;
 * without one, as the 1-hour writes the request asks for.
 */
function usageOf(response: Anthropic.Message, latencyMs: number): ProposerUsage {
  const u = response.usage
  const written = u.cache_creation_input_tokens ?? 0
  const written5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const tokens = {
    inputTokens: u.input_tokens,
    cacheWrite5mTokens: written5m,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? written - written5m,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens,
  }
  return {
    model: response.model,
    inputTokens: u.input_tokens,
    cacheCreationInputTokens: written,
    cacheReadInputTokens: tokens.cacheReadTokens,
    outputTokens: u.output_tokens,
    latencyMs,
    costMicroUsd: costMicroUsd(response.model, tokens),
  }
}

/** SDK errors to results. Anything that is not an API error is a bug and is thrown. */
function apiFailure(e: unknown): ProposerFailure {
  const failure = (reason: ProposerFailure['reason'], detail: string): ProposerFailure => ({ code: 'could_not_propose', reason, detail, usage: null })
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return failure('auth', `HTTP ${e.status}: check ANTHROPIC_API_KEY`)
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
    return failure('rejected', `HTTP ${e.status}: the request was refused (check ROLEPAY_AI_MODEL)`)
  }
  if (e instanceof Anthropic.APIConnectionError) return failure('unavailable', e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout' : 'connection error')
  if (e instanceof Anthropic.APIError) return failure('unavailable', `HTTP ${e.status ?? 'unknown'}`)
  throw e
}
