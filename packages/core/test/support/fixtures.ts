// Test fixtures: valid domain objects with overridable fields.
import type { BotKey, Community, SetupLink } from '../../src/domain/community.js'
import type { LinkToken, Payee } from '../../src/domain/payee.js'
import { type Run, type RunEvent, newRun, transition } from '../../src/domain/run.js'

export const GUILD = '1094309218049937418'
export const OTHER_GUILD = '1094309218049937419'
export const ALICE = '200000000000000001'
export const BOB = '200000000000000002'
export const CAROL = '200000000000000003'
export const TREASURER = '300000000000000001'
export const TOKEN = '0x20c0000000000000000000000000000000000001'
export const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'
export const TREASURY = '0x9999999999999999999999999999999999999999'
export const ADDR = {
  alice: '0x1111111111111111111111111111111111111111',
  bob: '0x2222222222222222222222222222222222222222',
  carol: '0x3333333333333333333333333333333333333333',
} as const
export const T0 = new Date('2026-10-06T12:00:00.000Z')
export const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

export function community(over: Partial<Community> = {}): Community {
  return {
    id: GUILD,
    name: 'Test guild',
    network: 'moderato',
    treasuryAddress: TREASURY,
    payoutToken: TOKEN,
    feeMode: 'sponsor',
    feeToken: null,
    approverRoleId: null,
    requireSeparateApprover: false,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function botKey(over: Partial<BotKey> = {}): BotKey {
  return {
    address: '0x4444444444444444444444444444444444444444',
    communityId: GUILD,
    sealedSecret: 'sealed:v1:abc',
    status: 'pending_authorization',
    policy: {
      token: TOKEN,
      limit: 10_000_000n,
      periodSeconds: 2_592_000,
      expiresAt: 1_800_000_000,
      recipients: null,
      feeToken: null,
      feeBudget: null,
    },
    createdAt: T0,
    authorizedAt: null,
    revokedAt: null,
    ...over,
  }
}

export function setupLink(over: Partial<SetupLink> = {}): SetupLink {
  return {
    tokenHash: 'fp_setup_1',
    communityId: GUILD,
    discordUserId: TREASURER,
    settings: { name: 'Test guild', payoutToken: TOKEN, feeMode: 'sponsor', feeToken: null, approverRoleId: '400000000000000001', requireSeparateApprover: false },
    createdAt: T0,
    expiresAt: at(1800),
    ...over,
  }
}

export function payee(over: Partial<Payee> = {}): Payee {
  return { communityId: GUILD, discordUserId: ALICE, address: ADDR.alice, registeredAt: T0, updatedAt: T0, ...over }
}

export function linkToken(over: Partial<LinkToken> = {}): LinkToken {
  return {
    tokenHash: 'fp_1',
    communityId: GUILD,
    discordUserId: ALICE,
    createdAt: T0,
    expiresAt: at(1800),
    consumedAt: null,
    ...over,
  }
}

export function run(over: { id?: string; communityId?: string; createdAt?: Date } = {}): Run {
  const r = newRun({
    id: over.id ?? 'run_fixture01',
    communityId: over.communityId ?? GUILD,
    token: TOKEN,
    note: 'October mods',
    createdBy: ALICE,
    lines: [
      { payeeDiscordId: ALICE, address: ADDR.alice, amount: 1_500_000n },
      { payeeDiscordId: BOB, address: ADDR.bob, amount: 2_000_000n },
    ],
    now: over.createdAt ?? T0,
  })
  if (!r.ok) throw new Error(`fixture run: ${r.error.code}`)
  return r.value
}

/** Applies events, throwing on the first illegal one. */
export function advance(r: Run, ...events: RunEvent[]): Run {
  return events.reduce((current, e, i) => {
    const n = transition(current, e, at(i + 1))
    if (!n.ok) throw new Error(`fixture transition ${e.type}: ${n.error.code}`)
    return n.value
  }, r)
}
