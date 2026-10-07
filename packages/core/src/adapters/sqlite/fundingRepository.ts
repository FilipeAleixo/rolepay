import type { Kysely, Selectable } from 'kysely'
import { type Deposit, type DepositMaster, DepositMasterSchema, DepositSchema, type FundingSource, FundingSourceSchema } from '../../domain/funding.js'
import { formatAmount, parseAmount } from '../../domain/money.js'
import type { FundingRepository } from '../../ports/repositories.js'
import type { Database, DepositMastersTable, DepositsTable, FundingSourcesTable } from './schema.js'

/** "5.5" -> 5_500_000n; undefined for anything else, which the schema then refuses. */
const micros = (text: string) => {
  const r = parseAmount(text)
  return r.ok ? r.value : undefined
}

const toMaster = (r: Selectable<DepositMastersTable>): DepositMaster =>
  DepositMasterSchema.parse({
    communityId: r.community_id,
    masterId: r.master_id,
    masterAddress: r.master_address,
    txHash: r.tx_hash,
    registeredBlock: BigInt(r.registered_block),
    registeredAt: new Date(r.registered_at),
    scannedTo: BigInt(r.scanned_to),
  })

const toSource = (r: Selectable<FundingSourcesTable>): FundingSource =>
  FundingSourceSchema.parse({
    id: r.id,
    communityId: r.community_id,
    name: r.name,
    userTag: r.user_tag,
    depositAddress: r.deposit_address,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at),
  })

const toDeposit = (r: Selectable<DepositsTable>): Deposit =>
  DepositSchema.parse({
    communityId: r.community_id,
    sourceId: r.source_id,
    token: r.token,
    amount: micros(r.amount),
    from: r.sender,
    txHash: r.tx_hash,
    logIndex: r.log_index,
    blockNumber: BigInt(r.block_number),
    blockTime: new Date(r.block_time),
  })

/** Masters, funding sources and deposits; every read is re-validated by the domain schemas. */
export class SqliteFundingRepository implements FundingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async getMaster(communityId: string) {
    const r = await this.db.selectFrom('deposit_masters').selectAll().where('community_id', '=', communityId).executeTakeFirst()
    return r ? toMaster(r) : null
  }

  async insertMaster(m: DepositMaster) {
    const r = await this.db
      .insertInto('deposit_masters')
      .values({
        community_id: m.communityId,
        master_id: m.masterId,
        master_address: m.masterAddress,
        tx_hash: m.txHash,
        registered_block: m.registeredBlock,
        registered_at: m.registeredAt.toISOString(),
        scanned_to: m.scannedTo,
      })
      .onConflict((oc) => oc.column('community_id').doNothing())
      .executeTakeFirst()
    return Number(r.numInsertedOrUpdatedRows ?? 0n) === 1
  }

  async listMasters() {
    return (await this.db.selectFrom('deposit_masters').selectAll().execute()).map(toMaster)
  }

  async advanceScan(communityId: string, scannedTo: bigint) {
    await this.db.updateTable('deposit_masters').set({ scanned_to: scannedTo }).where('community_id', '=', communityId).where('scanned_to', '<', scannedTo).execute()
  }

  async insertSource(s: FundingSource) {
    const r = await this.db
      .insertInto('funding_sources')
      .values({
        id: s.id,
        community_id: s.communityId,
        name: s.name,
        user_tag: s.userTag,
        deposit_address: s.depositAddress,
        created_by: s.createdBy,
        created_at: s.createdAt.toISOString(),
      })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst()
    return Number(r.numInsertedOrUpdatedRows ?? 0n) === 1 ? ('inserted' as const) : ('tag_taken' as const)
  }

  async getSource(id: string) {
    const r = await this.db.selectFrom('funding_sources').selectAll().where('id', '=', id).executeTakeFirst()
    return r ? toSource(r) : null
  }

  async listSources(communityId: string) {
    return (await this.db.selectFrom('funding_sources').selectAll().where('community_id', '=', communityId).orderBy('user_tag', 'asc').execute()).map(toSource)
  }

  async insertDeposit(d: Deposit) {
    const r = await this.db
      .insertInto('deposits')
      .values({
        tx_hash: d.txHash,
        log_index: d.logIndex,
        community_id: d.communityId,
        source_id: d.sourceId,
        token: d.token,
        amount: formatAmount(d.amount),
        sender: d.from,
        block_number: d.blockNumber,
        block_time: d.blockTime.toISOString(),
      })
      .onConflict((oc) => oc.columns(['tx_hash', 'log_index']).doNothing())
      .executeTakeFirst()
    return Number(r.numInsertedOrUpdatedRows ?? 0n) === 1
  }

  async listDeposits(communityId: string, opts: { sourceId?: string; since?: Date; limit?: number } = {}) {
    let q = this.db.selectFrom('deposits').selectAll().where('community_id', '=', communityId)
    if (opts.sourceId) q = q.where('source_id', '=', opts.sourceId)
    if (opts.since) q = q.where('block_time', '>=', opts.since.toISOString())
    q = q.orderBy('block_number', 'desc').orderBy('log_index', 'desc')
    if (opts.limit !== undefined) q = q.limit(opts.limit)
    return (await q.execute()).map(toDeposit)
  }
}
