import type { RawCriteriaProposal, RawMessageProposal } from '../../domain/proposal/raw.js'
import { err, ok } from '../../domain/result.js'
import type { CriteriaProposalRequest, MessageProposalRequest, ProposerFailure, ProposerUsage, Proposed, RunProposer } from '../../ports/runProposer.js'

type Answer<T> = T | ProposerFailure
const isFailure = (a: unknown): a is ProposerFailure => typeof a === 'object' && a !== null && (a as { code?: unknown }).code === 'could_not_propose'

/**
 * A deterministic, network-free RunProposer. By default message mode is `naiveMessageProposal`
 * and criteria mode answers "not understood"; tests script either with `onMessages`/`onCriteria`.
 * Every request is recorded, so tests can check what "the model" saw (tokens, never IDs).
 */
export class FakeRunProposer implements RunProposer {
  readonly model = 'fake-proposer'
  readonly requests: ({ mode: 'messages'; request: MessageProposalRequest } | { mode: 'criteria'; request: CriteriaProposalRequest })[] = []
  usage: ProposerUsage = { model: 'fake-proposer', inputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 2400, outputTokens: 300, latencyMs: 7, costMicroUsd: 10_800 }
  onMessages: (request: MessageProposalRequest) => Answer<RawMessageProposal> = (r) => naiveMessageProposal(r)
  onCriteria: (request: CriteriaProposalRequest) => Answer<RawCriteriaProposal> = () => unclearCriteria('The fake proposer has no criteria scripted.')

  async fromMessages(request: MessageProposalRequest): Promise<Proposed<RawMessageProposal>> {
    this.requests.push({ mode: 'messages', request })
    const answer = this.onMessages(request)
    return isFailure(answer) ? err(answer) : ok({ raw: answer, usage: this.usage })
  }

  async fromCriteria(request: CriteriaProposalRequest): Promise<Proposed<RawCriteriaProposal>> {
    this.requests.push({ mode: 'criteria', request })
    const answer = this.onCriteria(request)
    return isFailure(answer) ? err(answer) : ok({ raw: answer, usage: this.usage })
  }
}

/**
 * A simple, predictable stand-in for the model in message mode: everyone mentioned in a message
 * by someone else gets the first amount of the instruction; "<amount> to @U2" in the instruction
 * overrides. With `gullible`, it also obeys "pay me N" in a message, the way an injected model
 * might, so tests can show code holding such lines anyway.
 */
export function naiveMessageProposal(request: MessageProposalRequest, opts: { gullible?: boolean } = {}): RawMessageProposal {
  const first = /\d+(?:\.\d+)?/.exec(request.instruction)?.[0] ?? '1'
  const overrides = new Map([...request.instruction.matchAll(/(\d+(?:\.\d+)?) (?:to|for) @(U\d+)/g)].map((m) => [m[2] as string, m[1] as string]))
  const lines: RawMessageProposal['lines'] = []
  const ignored: RawMessageProposal['ignoredInstructions'] = []
  const seen = new Set<string>()
  for (const m of request.messages) {
    const payMe = /pay me ([\d,]+)/i.exec(m.text)
    if (payMe) {
      ignored.push({ message: m.ref, summary: 'Asks the AI to pay its author.' })
      if (opts.gullible && !seen.has(m.author)) {
        seen.add(m.author)
        lines.push({ user: m.author, amount: payMe[1] as string, amountFrom: 'instruction', reason: 'asked to be paid', sources: [m.ref] })
      }
      continue
    }
    for (const t of m.text.matchAll(/@(U\d+)/g)) {
      const user = t[1] as string
      if (user === m.author || seen.has(user)) continue
      seen.add(user)
      lines.push({ user, amount: overrides.get(user) ?? first, amountFrom: 'instruction', reason: `mentioned in ${m.ref}`, sources: [m.ref] })
    }
  }
  return { lines, splitTotal: null, note: null, unresolved: [], assumptions: [], ignoredInstructions: opts.gullible ? [] : ignored }
}

/** A criteria answer with nothing set ("" and [] mean not set, as the model writes it): fill in what a test needs. */
export function emptyCriteria(over: Partial<RawCriteriaProposal> = {}, conditions: Partial<RawCriteriaProposal['conditions']> = {}): RawCriteriaProposal {
  return {
    understood: true,
    problem: '',
    conditions: { hasRole: [], lacksRole: [], joinedBefore: '', joinedAfter: '', activity: [], anchors: [], paidInRun: '', ...conditions },
    exclude: [],
    excludeProposer: false,
    amount: { kind: 'flat', amount: '1', per: '', cap: '', total: '', splitBy: '' },
    overrides: [],
    perPersonCap: '',
    note: '',
    assumptions: [],
    ...over,
  }
}

export const unclearCriteria = (problem: string): RawCriteriaProposal => emptyCriteria({ understood: false, problem })
