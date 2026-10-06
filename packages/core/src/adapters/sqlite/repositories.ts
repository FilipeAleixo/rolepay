import type { Kysely, Selectable } from 'kysely'
import { type BotKey, BotKeySchema, type Community, CommunitySchema, type SetupLink, SetupLinkSchema } from '../../domain/community.js'
import { type LinkToken, LinkTokenSchema, type Payee, PayeeSchema } from '../../domain/payee.js'
import { err, ok } from '../../domain/result.js'
import { type Run, RunSchema, type RunStatus } from '../../domain/run.js'
import type { CommunityRepository, PayeeRepository, RunRepository } from '../../ports/repositories.js'
import type { Database, RunLinesTable, RunsTable } from './schema.js'

// ---- codecs: domain <-> rows. Every read is re-validated by the domain schema. ----
const iso = (d: Date) => d.toISOString()
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null)
const date = (s: string) => new Date(s)
const dateOrNull = (s: string | null) => (s ? new Date(s) : null)
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

const isUniqueViolation = (e: unknown) => /UNIQUE|PRIMARY KEY|duplicate key/i.test(String((e as Error)?.message))

export class SqliteCommunityRepository implements CommunityRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(id: string) {
    const row = await this.db.selectFrom('communities').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? toCommunity(row) : null
  }

  async insert(c: Community) {
    try {
      await this.db.insertInto('communities').values(communityRow(c)).execute()
      return ok(undefined)
    } catch (e) {
      if (isUniqueViolation(e)) return err({ code: 'already_exists' as const })
      throw e
    }
  }

  async update(c: Community) {
    const { id, ...rest } = communityRow(c)
    await this.db.updateTable('communities').set(rest).where('id', '=', id).execute()
  }

  async saveBotKey(k: BotKey) {
    const row = {
      address: k.address,
      community_id: k.communityId,
      sealed_secret: k.sealedSecret,
      status: k.status,
      policy: json(k.policy),
      created_at: iso(k.createdAt),
      authorized_at: isoOrNull(k.authorizedAt),
      revoked_at: isoOrNull(k.revokedAt),
    }
    const { address: _a, ...update } = row
    await this.db.insertInto('bot_keys').values(row).onConflict((oc) => oc.column('address').doUpdateSet(update)).execute()
  }

  async getBotKey(address: string) {
    const row = await this.db.selectFrom('bot_keys').selectAll().where('address', '=', address).executeTakeFirst()
    return row ? toBotKey(row) : null
  }

  async listBotKeys(communityId: string) {
    const rows = await this.db
      .selectFrom('bot_keys')
      .selectAll()
      .where('community_id', '=', communityId)
      .orderBy('created_at', 'desc')
      .orderBy('address', 'desc')
      .execute()
    return rows.map(toBotKey)
  }

  async insertSetupLink(l: SetupLink) {
    await this.db
      .insertInto('setup_links')
      .values({
        token_hash: l.tokenHash,
        community_id: l.communityId,
        discord_user_id: l.discordUserId,
        settings: json(l.settings),
        created_at: iso(l.createdAt),
        expires_at: iso(l.expiresAt),
      })
      .execute()
  }

  async getSetupLink(tokenHash: string) {
    const row = await this.db.selectFrom('setup_links').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst()
    if (!row) return null
    return SetupLinkSchema.parse({
      tokenHash: row.token_hash,
      communityId: row.community_id,
      discordUserId: row.discord_user_id,
      settings: JSON.parse(row.settings),
      createdAt: date(row.created_at),
      expiresAt: date(row.expires_at),
    })
  }
}

function communityRow(c: Community) {
  return {
    id: c.id,
    name: c.name,
    network: c.network,
    treasury_address: c.treasuryAddress,
    payout_token: c.payoutToken,
    fee_mode: c.feeMode,
    fee_token: c.feeToken,
    approver_role_id: c.approverRoleId,
    require_separate_approver: c.requireSeparateApprover ? 1 : 0,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
  }
}

function toCommunity(r: Selectable<Database['communities']>): Community {
  return CommunitySchema.parse({
    id: r.id,
    name: r.name,
    network: r.network,
    treasuryAddress: r.treasury_address,
    payoutToken: r.payout_token,
    feeMode: r.fee_mode,
    feeToken: r.fee_token,
    approverRoleId: r.approver_role_id,
    requireSeparateApprover: r.require_separate_approver === 1,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  })
}

function toBotKey(r: Selectable<Database['bot_keys']>): BotKey {
  const p = JSON.parse(r.policy)
  return BotKeySchema.parse({
    address: r.address,
    communityId: r.community_id,
    sealedSecret: r.sealed_secret,
    status: r.status,
    policy: { ...p, limit: BigInt(p.limit), feeBudget: p.feeBudget === null ? null : BigInt(p.feeBudget) },
    createdAt: date(r.created_at),
    authorizedAt: dateOrNull(r.authorized_at),
    revokedAt: dateOrNull(r.revoked_at),
  })
}

export class SqlitePayeeRepository implements PayeeRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(communityId: string, discordUserId: string) {
    const row = await this.db
      .selectFrom('payees')
      .selectAll()
      .where('community_id', '=', communityId)
      .where('discord_user_id', '=', discordUserId)
      .executeTakeFirst()
    return row ? toPayee(row) : null
  }

  async upsert(p: Payee) {
    await this.db
      .insertInto('payees')
      .values({
        community_id: p.communityId,
        discord_user_id: p.discordUserId,
        address: p.address,
        registered_at: iso(p.registeredAt),
        updated_at: iso(p.updatedAt),
      })
      .onConflict((oc) =>
        oc
          .columns(['community_id', 'discord_user_id'])
          .doUpdateSet({ address: p.address, registered_at: iso(p.registeredAt), updated_at: iso(p.updatedAt) }),
      )
      .execute()
  }

  async list(communityId: string) {
    const rows = await this.db.selectFrom('payees').selectAll().where('community_id', '=', communityId).orderBy('discord_user_id').execute()
    return rows.map(toPayee)
  }

  async insertLinkToken(t: LinkToken) {
    await this.db
      .insertInto('link_tokens')
      .values({
        token_hash: t.tokenHash,
        community_id: t.communityId,
        discord_user_id: t.discordUserId,
        created_at: iso(t.createdAt),
        expires_at: iso(t.expiresAt),
        consumed_at: isoOrNull(t.consumedAt),
      })
      .execute()
  }

  async getLinkToken(tokenHash: string) {
    const r = await this.db.selectFrom('link_tokens').selectAll().where('token_hash', '=', tokenHash).executeTakeFirst()
    if (!r) return null
    return LinkTokenSchema.parse({
      tokenHash: r.token_hash,
      communityId: r.community_id,
      discordUserId: r.discord_user_id,
      createdAt: date(r.created_at),
      expiresAt: date(r.expires_at),
      consumedAt: dateOrNull(r.consumed_at),
    })
  }

  async consumeLinkToken(tokenHash: string, at: Date) {
    const res = await this.db
      .updateTable('link_tokens')
      .set({ consumed_at: iso(at) })
      .where('token_hash', '=', tokenHash)
      .where('consumed_at', 'is', null)
      .executeTakeFirst()
    return res.numUpdatedRows === 1n
  }
}

function toPayee(r: Selectable<Database['payees']>): Payee {
  return PayeeSchema.parse({
    communityId: r.community_id,
    discordUserId: r.discord_user_id,
    address: r.address,
    registeredAt: date(r.registered_at),
    updatedAt: date(r.updated_at),
  })
}

/** Lines are immutable once a run exists: `update` rewrites the run row only. */
export class SqliteRunRepository implements RunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(run: Run) {
    await this.db.transaction().execute(async (tx) => {
      await tx.insertInto('runs').values(runRow(run)).execute()
      await tx
        .insertInto('run_lines')
        .values(
          run.lines.map((l) => ({
            run_id: run.id,
            line: l.line,
            payee_discord_id: l.payeeDiscordId,
            address: l.address,
            amount: l.amount.toString(),
            memo: l.memo,
          })),
        )
        .execute()
    })
  }

  async get(id: string) {
    const row = await this.db.selectFrom('runs').selectAll().where('id', '=', id).executeTakeFirst()
    return row ? (await this.hydrate([row]))[0] ?? null : null
  }

  async listByCommunity(communityId: string, opts: { limit?: number } = {}) {
    let q = this.db.selectFrom('runs').selectAll().where('community_id', '=', communityId).orderBy('created_at', 'desc').orderBy('id', 'desc')
    if (opts.limit !== undefined) q = q.limit(opts.limit)
    return this.hydrate(await q.execute())
  }

  async listByStatus(status: RunStatus) {
    return this.hydrate(await this.db.selectFrom('runs').selectAll().where('status', '=', status).orderBy('created_at', 'desc').execute())
  }

  async update(next: Run) {
    const { id, ...rest } = runRow(next)
    const res = await this.db
      .updateTable('runs')
      .set(rest)
      .where('id', '=', id)
      .where('version', '=', next.version - 1)
      .executeTakeFirst()
    return res.numUpdatedRows === 1n ? ('updated' as const) : ('conflict' as const)
  }

  private async hydrate(rows: Selectable<RunsTable>[]): Promise<Run[]> {
    if (rows.length === 0) return []
    const lines = await this.db
      .selectFrom('run_lines')
      .selectAll()
      .where(
        'run_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('line')
      .execute()
    const byRun = new Map<string, Selectable<RunLinesTable>[]>()
    for (const l of lines) byRun.set(l.run_id, [...(byRun.get(l.run_id) ?? []), l])
    return rows.map((r) => toRun(r, byRun.get(r.id) ?? []))
  }
}

function runRow(r: Run): RunsTable {
  return {
    id: r.id,
    community_id: r.communityId,
    token: r.token,
    note: r.note,
    status: r.status,
    total: r.total.toString(),
    created_by: r.createdBy,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
    submitted_at: isoOrNull(r.submittedAt),
    approved_by: r.approvedBy,
    approved_at: isoOrNull(r.approvedAt),
    cancelled_by: r.cancelledBy,
    cancelled_at: isoOrNull(r.cancelledAt),
    attempts: json(r.attempts),
    paid_tx_hash: r.paidTxHash,
    paid_block: r.paidBlock === null ? null : r.paidBlock.toString(),
    paid_at: isoOrNull(r.paidAt),
    failure: r.failure ? json(r.failure) : null,
    version: r.version,
  }
}

function toRun(r: Selectable<RunsTable>, lines: Selectable<RunLinesTable>[]): Run {
  const attempts = (JSON.parse(r.attempts) as Record<string, unknown>[]).map((a) => ({
    ...a,
    startedAt: new Date(a.startedAt as string),
    fromBlock: BigInt(a.fromBlock as string),
  }))
  const failure = r.failure ? JSON.parse(r.failure) : null
  return RunSchema.parse({
    id: r.id,
    communityId: r.community_id,
    token: r.token,
    note: r.note,
    status: r.status,
    lines: lines.map((l) => ({
      line: l.line,
      payeeDiscordId: l.payee_discord_id,
      address: l.address,
      amount: BigInt(l.amount),
      memo: l.memo,
    })),
    total: BigInt(r.total),
    createdBy: r.created_by,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    submittedAt: dateOrNull(r.submitted_at),
    approvedBy: r.approved_by,
    approvedAt: dateOrNull(r.approved_at),
    cancelledBy: r.cancelled_by,
    cancelledAt: dateOrNull(r.cancelled_at),
    attempts,
    paidTxHash: r.paid_tx_hash,
    paidBlock: r.paid_block === null ? null : BigInt(r.paid_block),
    paidAt: dateOrNull(r.paid_at),
    failure: failure ? { ...failure, at: new Date(failure.at) } : null,
    version: r.version,
  })
}
