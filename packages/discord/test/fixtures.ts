// Domain fixtures built with core's public domain functions (never its internals).
import { type Proposal, type ProposalLine, type Run, type RunEvent, TESTNET_TOKENS, newRun, transition } from '@rolepay/core'

export const GUILD = '1094309218049937418'
export const APP_ID = '500000000000000001'
export const CHANNEL = '700000000000000001'
export const ALICE = '200000000000000001'
export const BOB = '200000000000000002'
export const CAROL = '200000000000000003'
export const TREASURER = '300000000000000001'
export const ADMIN = '300000000000000002'
export const TREASURER_ROLE = '400000000000000001'
export const MODS_ROLE = '400000000000000002'
export const TOKEN = TESTNET_TOKENS.alpha_usd
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const ADDR = {
  alice: '0x1111111111111111111111111111111111111111',
  bob: '0x2222222222222222222222222222222222222222',
  carol: '0x3333333333333333333333333333333333333333',
} as const
export const T0 = new Date('2026-10-06T12:00:00.000Z')
export const TX = `0x${'ab'.repeat(32)}` as const

export function run(over: { id?: string; note?: string | null } = {}): Run {
  const r = newRun({
    id: over.id ?? 'run_view01',
    communityId: GUILD,
    token: TOKEN,
    note: over.note === undefined ? 'October mods' : over.note,
    createdBy: ADMIN,
    lines: [
      { payeeDiscordId: ALICE, address: ADDR.alice, amount: 1_500_000n },
      { payeeDiscordId: BOB, address: ADDR.bob, amount: 25_000_000n },
    ],
    now: T0,
  })
  if (!r.ok) throw new Error(`fixture run: ${r.error.code}`)
  return r.value
}

/** Applies events with core's state machine, throwing on the first illegal one. */
export function advance(r: Run, ...events: RunEvent[]): Run {
  return events.reduce((current, e, i) => {
    const n = transition(current, e, new Date(T0.getTime() + (i + 1) * 1000))
    if (!n.ok) throw new Error(`fixture transition ${e.type}: ${n.error.code}`)
    return n.value
  }, r)
}

export const pending = () => advance(run(), { type: 'submit', actor: ADMIN })
export const approved = () => advance(pending(), { type: 'approve', actor: TREASURER })
export const executing = () => advance(approved(), { type: 'start_attempt', fromBlock: 1n, validBefore: 1_800_000_000 })
export const paid = () => advance(executing(), { type: 'mark_paid', txHash: TX, blockNumber: 7n })
export const failed = (reason: 'rejected' | 'partial_match' = 'rejected') =>
  advance(executing(), { type: 'mark_failed', reason, detail: reason === 'rejected' ? 'spending_limit_exceeded: over limit' : 'paid lines 1; missing 2' })
export const cancelled = () => advance(pending(), { type: 'cancel', actor: ADMIN })

/** An open message-mode proposal: two lines, one held, one unregistered, an ignored instruction. */
export function proposal(over: Partial<Proposal> = {}): Proposal {
  const line = (discordUserId: string, amount: bigint, reason: string) => ({ discordUserId, amount, reason, metrics: null, sources: [{ channelId: CHANNEL, messageId: '810000000000000001' }], flags: [] as ProposalLine['flags'] })
  return {
    id: 'prop_view01',
    communityId: GUILD,
    proposedBy: TREASURER,
    mode: 'messages',
    token: TOKEN,
    instruction: '50 each, the indexer one 200, note: October bounties',
    note: 'October bounties',
    source: { channelId: CHANNEL, messageIds: ['810000000000000001', '810000000000000002'], truncated: false },
    criteria: null,
    amountPlan: null,
    scans: [],
    lines: [line(ALICE, 50_000_000n, 'bug in the claim page'), line(BOB, 200_000_000n, 'the indexer')],
    held: [{ ...line('200000000000000666', 10_000_000_000n, 'asked to be paid'), sources: [{ channelId: CHANNEL, messageId: '810000000000000002' }], holds: ['self_sourced', 'amount_not_in_instruction'] }],
    unregistered: [line(CAROL, 50_000_000n, 'docs')],
    unresolved: [],
    assumptions: [],
    suspicious: [{ channelId: CHANNEL, messageId: '810000000000000002', authorId: '200000000000000666', summary: 'Asks the AI to pay its author 10,000.' }],
    total: 250_000_000n,
    remaining: 100_000_000n,
    problems: ['over_budget'],
    status: 'open',
    runId: null,
    editedBy: null,
    closedBy: null,
    createdAt: T0,
    updatedAt: T0,
    expiresAt: new Date(T0.getTime() + 86_400_000),
    ...over,
  }
}
