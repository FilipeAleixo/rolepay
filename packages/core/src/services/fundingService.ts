import { z } from 'zod'
import { KNOWN_TOKENS } from '../constants/tempo.js'
import type { Community } from '../domain/community.js'
import {
  type Deposit,
  type DepositMaster,
  FUNDING_LIMITS,
  type FundingSource,
  type FundingSummary,
  MasterIdSchema,
  SourceNameSchema,
  attributeDeposits,
  canManageFunding,
  depositAddress,
  fundingSummary,
  userTagFor,
} from '../domain/funding.js'
import type { Hex } from '../domain/hex.js'
import { type Address, DiscordIdSchema, TxHashSchema } from '../domain/ids.js'
import { formatAmount } from '../domain/money.js'
import { type Result, err, ok } from '../domain/result.js'
import type { Clock } from '../ports/clock.js'
import type { FundingChain, RegistrationCall } from '../ports/fundingChain.js'
import type { IdGenerator } from '../ports/idGenerator.js'
import type { CommunityRepository, FundingRepository } from '../ports/repositories.js'
import type { AuditTrail } from './auditTrail.js'
import { type InvalidInput, invalidInput } from './common.js'

type NotFound = { code: 'community_not_found' }
type NotConfigured = { code: 'not_configured' }
type AlreadySetUp = { code: 'already_set_up' }

/** A funding source and what its deposits have brought in so far. */
export type FundingSourceView = { source: FundingSource; received: FundingSummary }

export type FundingStatus = {
  /** Whether this server reads the chain for funding (a FundingChain is wired). */
  configured: boolean
  /** null until the treasury is registered as a virtual-address master: deposit addresses are off. */
  master: DepositMaster | null
  /** Oldest first. */
  sources: FundingSourceView[]
}

/** What came in since the first of this UTC month; `setUp` false when deposit addresses are off. */
export type FundingMonth = FundingSummary & { since: Date; setUp: boolean }

export type ScanReport = {
  /** Deposits this tick stored (each exactly once, whichever instance stored it). */
  deposits: Deposit[]
  /** A community whose range could not be read keeps its cursor and is read again next tick (null: the head). */
  errors: { communityId: string | null; error: string }[]
}

const SaltSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte salt')
const CreateSourceInput = z.object({ guildId: DiscordIdSchema, actor: DiscordIdSchema, actorRoleIds: z.array(DiscordIdSchema), name: SourceNameSchema })

/** Blocks read per community per tick (about 100 minutes of Tempo blocks); a server that was down catches up over several ticks. */
const DEFAULT_MAX_BLOCKS = 10_000n
/** Deposit addresses per chain call, so the topic filter stays small. */
const ADDRESSES_PER_READ = 100
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Funding with attribution, on Tempo's virtual addresses (TIP-1022). The treasury registers once
 * as a master (signed by its passkey in the browser; this service plans the call and then reads the
 * result from the chain), the approver role creates named funding sources, each with its own
 * deposit address derived off chain, and a watcher attributes every deposit to its source. Read
 * only on chain, and separate from the payment path: no key, no run, nothing signed here.
 */
export class FundingService {
  constructor(
    private readonly deps: {
      funding: FundingRepository
      communities: CommunityRepository
      chain: FundingChain | null
      ids: IdGenerator
      clock: Clock
      audit: AuditTrail
    },
  ) {}

  /** Whether this server can set up deposit addresses at all (it reads the chain for them). */
  isConfigured() {
    return this.deps.chain !== null
  }

  private async community(guildId: string): Promise<Community | null> {
    return DiscordIdSchema.safeParse(guildId).success ? this.deps.communities.get(guildId) : null
  }

  async status(input: { guildId: string }): Promise<Result<FundingStatus, NotFound>> {
    const community = await this.community(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const master = await this.deps.funding.getMaster(community.id)
    const [sources, deposits] = master ? await Promise.all([this.deps.funding.listSources(community.id), this.deps.funding.listDeposits(community.id)]) : [[], []]
    return ok({
      configured: this.isConfigured(),
      master,
      sources: sources.map((source) => ({ source, received: fundingSummary(deposits.filter((d) => d.sourceId === source.id)) })),
    })
  }

  /**
   * The registration the treasury's passkey will sign: `registerVirtualMaster(salt)` from the
   * treasury. The salt is mined by the page (a 32-bit proof of work); this checks it, and that the
   * masterId it yields is free, so the page never sends a transaction that would revert. The page
   * builds its own copy of the call and signs nothing if this one differs.
   */
  async planMaster(input: { guildId: string; salt: string }): Promise<
    Result<{ masterId: Hex; master: Address; call: RegistrationCall }, NotFound | NotConfigured | AlreadySetUp | InvalidInput | { code: 'invalid_salt' | 'master_id_taken' }>
  > {
    const community = await this.community(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const chain = this.deps.chain
    if (!chain) return err({ code: 'not_configured' })
    const salt = SaltSchema.safeParse(input.salt)
    if (!salt.success) return invalidInput(salt.error)
    if (await this.deps.funding.getMaster(community.id)) return err({ code: 'already_set_up' })
    const registration = chain.registration({ master: community.treasuryAddress, salt: salt.data as Hex })
    if (!registration?.proofOfWork) return err({ code: 'invalid_salt' })
    if (await chain.masterOf(registration.masterId)) return err({ code: 'master_id_taken' })
    return ok({ masterId: registration.masterId, master: community.treasuryAddress, call: registration.call })
  }

  /**
   * Records the treasury as a master once the chain shows it: the registry must map `masterId` to
   * the treasury (the page's word is never taken). The watcher starts at the registration's block
   * when `txHash` is that registration, else at the chain head (no deposit address exists before
   * this, so nothing earlier can be missed). The same masterId again is a no-op; another one once
   * set up is refused (one master per community).
   */
  async confirmMaster(input: { guildId: string; masterId: string; txHash: string | null }): Promise<
    Result<DepositMaster, NotFound | NotConfigured | AlreadySetUp | InvalidInput | { code: 'not_registered' }>
  > {
    const community = await this.community(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const chain = this.deps.chain
    if (!chain) return err({ code: 'not_configured' })
    const parsed = z.object({ masterId: MasterIdSchema, txHash: TxHashSchema.nullable() }).safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const { masterId, txHash } = parsed.data
    const existing = await this.deps.funding.getMaster(community.id)
    if (existing) return existing.masterId === masterId ? ok(existing) : err({ code: 'already_set_up' })
    if ((await chain.masterOf(masterId))?.toLowerCase() !== community.treasuryAddress) return err({ code: 'not_registered' })
    const tx = txHash ? await chain.findRegistration(txHash) : null
    const isThisOne = tx !== null && tx.masterId.toLowerCase() === masterId && tx.master.toLowerCase() === community.treasuryAddress
    const head = isThisOne ? null : await chain.head()
    const registeredBlock = isThisOne ? tx.blockNumber : (head as { number: bigint }).number
    const master: DepositMaster = {
      communityId: community.id,
      masterId,
      masterAddress: community.treasuryAddress,
      txHash: isThisOne ? txHash : null,
      registeredBlock,
      registeredAt: this.deps.clock.now(),
      scannedTo: isThisOne ? registeredBlock - 1n : registeredBlock,
    }
    if (!(await this.deps.funding.insertMaster(master))) {
      // Another request recorded one first: the same masterId is fine, another one is not.
      const winner = await this.deps.funding.getMaster(community.id)
      return winner?.masterId === masterId ? ok(winner) : err({ code: 'already_set_up' })
    }
    return ok(master)
  }

  /**
   * A named funding source with its own deposit address (the approver role, from the roles Discord
   * signed or the dashboard read fresh). Sources are numbered 1, 2, 3 as their user tags; two
   * instances creating at once each get their own. The name is user text: it is stored on the
   * source only, never in the audit stream or a log.
   */
  async createSource(input: { guildId: string; actor: string; actorRoleIds: readonly string[]; name: string }): Promise<
    Result<
      FundingSource,
      NotFound | InvalidInput | { code: 'not_permitted' | 'not_set_up' | 'too_many_sources' } | { code: 'name_taken'; source: FundingSource }
    >
  > {
    const community = await this.community(input.guildId)
    if (!community) return err({ code: 'community_not_found' })
    const parsed = CreateSourceInput.safeParse(input)
    if (!parsed.success) return invalidInput(parsed.error)
    const master = await this.deps.funding.getMaster(community.id)
    if (!master) return err({ code: 'not_set_up' })
    if (!canManageFunding(community, parsed.data.actorRoleIds)) return err({ code: 'not_permitted' })
    for (let attempt = 0; attempt < 5; attempt++) {
      const sources = await this.deps.funding.listSources(community.id)
      const named = sources.find((s) => sameName(s.name, parsed.data.name))
      if (named) return err({ code: 'name_taken', source: named })
      if (sources.length >= FUNDING_LIMITS.maxSources) return err({ code: 'too_many_sources' })
      const n = sources.reduce((max, s) => Math.max(max, Number.parseInt(s.userTag.slice(2), 16)), 0) + 1
      const userTag = userTagFor(n)
      const source: FundingSource = {
        id: this.deps.ids.fundingSourceId(),
        communityId: community.id,
        name: parsed.data.name,
        userTag,
        depositAddress: depositAddress(master.masterId, userTag),
        createdBy: parsed.data.actor,
        createdAt: this.deps.clock.now(),
      }
      if ((await this.deps.funding.insertSource(source)) === 'tag_taken') continue
      await this.deps.audit.record({
        communityId: community.id,
        type: 'funding_source.created',
        actor: parsed.data.actor,
        details: { sourceId: source.id, depositAddress: source.depositAddress },
      })
      return ok(source)
    }
    throw new Error('could not take a free user tag after 5 attempts')
  }

  /** Deposits, newest first: all of the community's, or one source's; at most 500. */
  deposits(input: { guildId: string; sourceId?: string; limit?: number }): Promise<Deposit[]> {
    return this.deps.funding.listDeposits(input.guildId, {
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      limit: Math.min(500, Math.max(1, input.limit ?? 100)),
    })
  }

  /** What came in this UTC calendar month: in all, per token, and from how many sources. */
  async month(input: { guildId: string }): Promise<FundingMonth> {
    const now = this.deps.clock.now()
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const master = await this.deps.funding.getMaster(input.guildId)
    const deposits = master ? await this.deps.funding.listDeposits(input.guildId, { since }) : []
    return { since, setUp: master !== null, ...fundingSummary(deposits) }
  }

  /**
   * The deposit watcher's tick (the server runs it on an interval). For each community with deposit
   * addresses: read the Transfer events of its known USD stablecoins after its cursor (at most
   * `maxBlocks`), pair them into deposits (`attributeDeposits`), store each one (insert-if-absent by
   * transaction and log index, so a restart, a rescan or a second instance stores nothing twice;
   * only the instance that stored it writes `deposit.received`), then move the cursor. A range
   * that could not be read keeps the cursor where it was. No master anywhere: no chain call at all.
   */
  async scan(opts: { maxBlocks?: bigint } = {}): Promise<ScanReport> {
    const chain = this.deps.chain
    if (!chain) return { deposits: [], errors: [] }
    const masters = await this.deps.funding.listMasters()
    if (masters.length === 0) return { deposits: [], errors: [] }
    const report: ScanReport = { deposits: [], errors: [] }
    let head: bigint
    try {
      head = (await chain.head()).number
    } catch (e) {
      return { deposits: [], errors: [{ communityId: null, error: message(e) }] }
    }
    const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS
    for (const master of masters) {
      const fromBlock = master.scannedTo + 1n
      if (fromBlock > head) continue
      const toBlock = head < fromBlock + maxBlocks - 1n ? head : fromBlock + maxBlocks - 1n
      try {
        const [community, sources] = await Promise.all([this.deps.communities.get(master.communityId), this.deps.funding.listSources(master.communityId)])
        if (community && sources.length > 0) {
          const tokens = [...new Set([community.payoutToken, ...KNOWN_TOKENS[community.network]].map((t) => t.toLowerCase() as Address))]
          const transfers = []
          for (let i = 0; i < sources.length; i += ADDRESSES_PER_READ) {
            const addresses = sources.slice(i, i + ADDRESSES_PER_READ).map((s) => s.depositAddress)
            transfers.push(...(await chain.forwardedTransfers({ tokens, addresses, master: master.masterAddress, fromBlock, toBlock })))
          }
          const { deposits } = attributeDeposits({ communityId: master.communityId, treasury: master.masterAddress, sources, transfers })
          for (const deposit of deposits) {
            if (!(await this.deps.funding.insertDeposit(deposit))) continue
            report.deposits.push(deposit)
            await this.deps.audit.bestEffort({
              communityId: deposit.communityId,
              type: 'deposit.received',
              actor: null,
              details: { sourceId: deposit.sourceId, amount: formatAmount(deposit.amount), token: deposit.token, txHash: deposit.txHash, logIndex: deposit.logIndex },
            })
          }
        }
        await this.deps.funding.advanceScan(master.communityId, toBlock)
      } catch (e) {
        report.errors.push({ communityId: master.communityId, error: message(e) })
      }
    }
    return report
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'unknown')
