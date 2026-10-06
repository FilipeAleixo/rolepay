import Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { RawCriteriaProposalSchema, RawMessageProposalSchema } from '../../domain/proposal/raw.js'
import { err, ok } from '../../domain/result.js'
import type { CriteriaProposalRequest, MessageProposalRequest, ProposerFailure, ProposerUsage, Proposed, RunProposer } from '../../ports/runProposer.js'
import { outputSchema } from './jsonSchema.js'
import { costMicroUsd } from './pricing.js'
import { MESSAGE_SYSTEM, criteriaSystem, criteriaUserContent, messageUserContent } from './prompts.js'

export const DEFAULT_AI_MODEL = 'claude-opus-5-5'

/**
 * Room for the model's thinking plus a 50-line answer. Opus 5.5 always thinks (it cannot be
 * turned off); a low effort keeps that short, and this limit leaves room after it.
 */
const MAX_OUTPUT_TOKENS = 16_000
/** Server-side fallback when the model's safety classifiers decline: Anthropic picks the model by category. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

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
    return this.ask(criteriaSystem(request), criteriaUserContent(request), RawCriteriaProposalSchema)
  }

  private async ask<S extends z.ZodType>(system: string, content: string, schema: S): Promise<Proposed<z.infer<S>>> {
    const started = this.now()
    let response: Anthropic.Beta.BetaMessage
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: outputSchema(schema) } },
        system,
        messages: [{ role: 'user', content }],
      })
    } catch (e) {
      return err(apiFailure(e))
    }
    const usage: ProposerUsage = {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs: Math.round(this.now() - started),
      costMicroUsd: costMicroUsd(response.model, response.usage.input_tokens, response.usage.output_tokens),
    }
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

/** SDK errors to results. Anything that is not an API error is a bug and is thrown. */
function apiFailure(e: unknown): ProposerFailure {
  const failure = (reason: ProposerFailure['reason'], detail: string): ProposerFailure => ({ code: 'could_not_propose', reason, detail, usage: null })
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return failure('auth', `HTTP ${e.status}: check ANTHROPIC_API_KEY`)
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) {
    return failure('rejected', `HTTP ${e.status}: the request was refused (check PAYRUN_AI_MODEL)`)
  }
  if (e instanceof Anthropic.APIConnectionError) return failure('unavailable', e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout' : 'connection error')
  if (e instanceof Anthropic.APIError) return failure('unavailable', `HTTP ${e.status ?? 'unknown'}`)
  throw e
}
