import { z } from 'zod'
import { VIRTUAL_MAGIC } from '../constants/tempo.js'
import type { Community } from './community.js'
import type { Hex } from './hex.js'
import { type Address, AddressSchema, DiscordIdSchema, TxHashSchema } from './ids.js'
import type { Micros } from './money.js'

/**
 * Funding with attribution, on Tempo's virtual addresses (TIP-1022). The treasury registers once
 * as a virtual-address master and gets a 4-byte masterId. Rolepay then derives one deposit address
 * per funding source off chain: [masterId][10 magic bytes][6-byte userTag]. A TIP-20 transfer to a
 * deposit address is credited to the treasury itself by the protocol (no sweep, no balance at the
 * deposit address), and its events still name the deposit address, which is how a deposit is
 * attributed to its source. A deposit address can only ever add money to the treasury.
 */

const lower = <T extends string>(s: T) => s.toLowerCase() as T

/** The 4-byte masterId the registry gave the treasury. */
export const MasterIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, 'expected a 4-byte masterId')
  .transform((s) => lower(s) as Hex)

/** The 6-byte tag that tells one deposit address of a master from another. */
export const UserTagSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{12}$/, 'expected a 6-byte user tag')
  .transform((s) => lower(s) as Hex)

export const FUNDING_LIMITS = {
  maxNameLength: 80,
  /** Sources per community. User tags have room for 2^48; this keeps the watcher's filter small. */
  maxSources: 200,
} as const

/** A funding source's name: what people call the money's origin ("Judges pool"). User text: never logged or audited. */
export const SourceNameSchema = z
  .string()
  .trim()
  .min(1, 'give the source a name')
  .max(FUNDING_LIMITS.maxNameLength)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'no line breaks or control characters')

export const FundingSourceIdSchema = z.string().regex(/^[A-Za-z0-9_]{1,40}$/, 'expected a funding source ID')

const MAX_USER_TAG = 2 ** 48 - 1

/** The deposit address of a master's userTag: [masterId][VIRTUAL_MAGIC][userTag], lowercase. */
export function depositAddress(masterId: string, userTag: string): Address {
  return lower(`0x${masterId.slice(2)}${VIRTUAL_MAGIC}${userTag.slice(2)}`) as Address
}

/** The nth funding source's user tag (n from 1): n as 6 bytes, big-endian. */
export function userTagFor(n: number): Hex {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_USER_TAG) throw new RangeError(`user tag ${n} is outside 1 to 2^48 - 1`)
  return `0x${n.toString(16).padStart(12, '0')}` as Hex
}

/** The masterId and userTag of a virtual address (TIP-1022 layout), or null for any other address. */
export function parseVirtualAddress(address: string): { masterId: Hex; userTag: Hex } | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  const a = lower(address)
  if (a.slice(10, 30) !== VIRTUAL_MAGIC) return null
  return { masterId: a.slice(0, 10) as Hex, userTag: `0x${a.slice(30)}` as Hex }
}

/** Who may create funding sources: a member holding the approver role. With none set, nobody. */
export function canManageFunding(community: Pick<Community, 'approverRoleId'>, actorRoleIds: readonly string[]): boolean {
  return community.approverRoleId !== null && actorRoleIds.includes(community.approverRoleId)
}

/**
 * The treasury's registration as a virtual-address master, recorded once Rolepay has read it from
 * the chain (the registry maps `masterId` to the treasury). `scannedTo` is the deposit watcher's
 * cursor: every block up to it has been read.
 */
export const DepositMasterSchema = z.object({
  communityId: DiscordIdSchema,
  masterId: MasterIdSchema,
  /** The treasury: the address the registry maps masterId to. Registrations are permanent (TIP-1022). */
  masterAddress: AddressSchema,
  /** The registration transaction, when the page that sent it named it and the chain confirmed it. */
  txHash: TxHashSchema.nullable(),
  registeredBlock: z.bigint().nonnegative(),
  registeredAt: z.date(),
  scannedTo: z.bigint().nonnegative(),
})
export type DepositMaster = z.infer<typeof DepositMasterSchema>

/** A named funding source and its deposit address (derived from the master and its user tag). */
export const FundingSourceSchema = z.object({
  id: FundingSourceIdSchema,
  communityId: DiscordIdSchema,
  name: SourceNameSchema,
  userTag: UserTagSchema,
  depositAddress: AddressSchema,
  createdBy: DiscordIdSchema,
  createdAt: z.date(),
})
export type FundingSource = z.infer<typeof FundingSourceSchema>

/** Any 20-byte address, the zero address included (a mint's sender). */
const AnyAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => lower(s) as Address)

/**
 * One deposit, attributed to its source. Content-free: the source, the amount and token, who sent
 * it (public chain data; anyone can send to a deposit address), and where it is on chain. Unique
 * by transaction and log index (the first hop's), which is what makes the watcher idempotent.
 */
export const DepositSchema = z.object({
  communityId: DiscordIdSchema,
  sourceId: FundingSourceIdSchema,
  token: AddressSchema,
  amount: z.bigint().positive(),
  from: AnyAddressSchema,
  txHash: TxHashSchema,
  logIndex: z.number().int().nonnegative(),
  blockNumber: z.bigint().nonnegative(),
  blockTime: z.date(),
})
export type Deposit = z.infer<typeof DepositSchema>

/** One TIP-20 `Transfer` event, as the chain adapter reads it. */
export type TransferLog = {
  token: string
  from: string
  to: string
  amount: bigint
  txHash: string
  logIndex: number
  blockNumber: bigint
  blockTime: Date
}

/**
 * Deposits from TIP-20 Transfer events, the way TIP-1022 says to attribute them: a transfer to a
 * deposit address emits `Transfer(sender, depositAddress, amount)` and then, in the same
 * transaction, `Transfer(depositAddress, treasury, amount)` (a `TransferWithMemo` may sit between
 * them). Each such pair is ONE deposit, attributed to the deposit address's source; counting both
 * events would count it twice. A pair whose sender is the treasury itself is self-forwarding (no
 * money came in) and is not a deposit. A first hop with no forward to the treasury after it is
 * left out (`unpaired`): the protocol never credits a deposit address itself after T3.
 */
export function attributeDeposits(input: {
  communityId: string
  treasury: string
  sources: readonly FundingSource[]
  transfers: readonly TransferLog[]
}): { deposits: Deposit[]; selfTransfers: number; unpaired: number } {
  const treasury = lower(input.treasury)
  const byAddress = new Map<string, FundingSource>(input.sources.map((s) => [lower(s.depositAddress), s]))
  const logs = input.transfers
    .map((t) => ({ ...t, token: lower(t.token), from: lower(t.from), to: lower(t.to), txHash: lower(t.txHash) }))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1) || a.txHash.localeCompare(b.txHash) || a.logIndex - b.logIndex)
  const used = new Set<string>()
  const key = (t: { txHash: string; logIndex: number }) => `${t.txHash}:${t.logIndex}`
  const deposits: Deposit[] = []
  let selfTransfers = 0
  let unpaired = 0
  for (const first of logs) {
    const source = byAddress.get(first.to)
    if (!source || used.has(key(first))) continue
    const second = logs.find(
      (t) =>
        t.txHash === first.txHash &&
        t.logIndex > first.logIndex &&
        !used.has(key(t)) &&
        t.from === first.to &&
        t.to === treasury &&
        t.token === first.token &&
        t.amount === first.amount,
    )
    if (!second) {
      unpaired++
      continue
    }
    used.add(key(first))
    used.add(key(second))
    if (first.from === treasury) {
      selfTransfers++
      continue
    }
    deposits.push(
      DepositSchema.parse({
        communityId: input.communityId,
        sourceId: source.id,
        token: first.token,
        amount: first.amount,
        from: first.from,
        txHash: first.txHash,
        logIndex: first.logIndex,
        blockNumber: first.blockNumber,
        blockTime: first.blockTime,
      }),
    )
  }
  return { deposits, selfTransfers, unpaired }
}

export type FundingSummary = {
  /** Every token together: they are all USD stablecoins with 6 decimals. */
  total: Micros
  /** Per token, largest first. */
  byToken: { token: Address; amount: Micros }[]
  /** How many sources the deposits came from. */
  sources: number
  deposits: number
}

/** What a set of deposits brought in: in all, per token, and from how many sources. */
export function fundingSummary(deposits: readonly Deposit[]): FundingSummary {
  const byToken = new Map<Address, Micros>()
  for (const d of deposits) byToken.set(d.token, (byToken.get(d.token) ?? 0n) + d.amount)
  return {
    total: deposits.reduce((sum, d) => sum + d.amount, 0n),
    byToken: [...byToken].map(([token, amount]) => ({ token, amount })).sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1)),
    sources: new Set(deposits.map((d) => d.sourceId)).size,
    deposits: deposits.length,
  }
}
