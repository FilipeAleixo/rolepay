import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { fundingRepositoryContract } from '../../../test/support/fundingRepositoryContract.js'
import { keyValueContract } from '../../../test/support/keyValueContract.js'
import { policyRepositoryContract } from '../../../test/support/policyRepositoryContract.js'
import { proposalRepositoryContract } from '../../../test/support/proposalRepositoryContract.js'
import { repositoryContracts } from '../../../test/support/repositoryContracts.js'
import * as f from '../../../test/support/fixtures.js'
import { type Database, openSqliteDatabase } from './index.js'
import { MIGRATION_NAMES, migrateTo } from './migrations.js'
import { SqlitePolicyKeyRepository } from './policyKeyRepository.js'
import { SqliteAuditLog, SqlitePolicyRepository } from './policyRepositories.js'
import { SqliteFundingRepository } from './fundingRepository.js'
import { SqliteCommunityRepository, SqliteRunRepository } from './repositories.js'

// Real SQLite on a temp file (not :memory:), so file-level behaviour is exercised too.
const dir = mkdtempSync(join(tmpdir(), 'rolepay-sqlite-'))
let n = 0
const opened: { close(): Promise<void> }[] = []
afterAll(async () => {
  for (const db of opened) await db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function fresh(options: Parameters<typeof openSqliteDatabase>[1] = {}) {
  const db = await openSqliteDatabase(join(dir, `t${++n}.db`), options)
  opened.push(db)
  return db
}

repositoryContracts('sqlite', async () => (await fresh()).repositories)
keyValueContract('sqlite', async (clock) => (await fresh({ clock })).kv)
proposalRepositoryContract('sqlite', async (clock) => (await fresh({ clock })).repositories.proposals)
policyRepositoryContract('sqlite', async () => (await fresh()).repositories)
fundingRepositoryContract('sqlite', async () => (await fresh()).repositories)

/**
 * Rows as a release before 0009 wrote them (its columns only), so a migration test starts from the
 * database that release left, not from what today's repositories would write.
 */
async function insertAsBefore0009(db: Kysely<Database>, data: { payee?: boolean } = {}) {
  const c = f.community()
  await db
    .insertInto('communities')
    .values({
      id: c.id,
      name: c.name,
      network: c.network,
      treasury_address: c.treasuryAddress,
      payout_token: c.payoutToken,
      fee_mode: c.feeMode,
      fee_token: c.feeToken,
      approver_role_id: c.approverRoleId,
      require_separate_approver: 0,
      ai_proposals: 0,
      proposer_role_id: null,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt.toISOString(),
    } as never)
    .execute()
  const r = f.run()
  await db
    .insertInto('runs')
    .values({
      id: r.id,
      community_id: r.communityId,
      token: r.token,
      note: r.note,
      status: r.status,
      total: r.total.toString(),
      created_by: r.createdBy,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      submitted_at: null,
      approved_by: null,
      approved_at: null,
      cancelled_by: null,
      cancelled_at: null,
      attempts: '[]',
      paid_tx_hash: null,
      paid_block: null,
      paid_at: null,
      failure: null,
      version: r.version,
    })
    .execute()
  await db
    .insertInto('run_lines')
    .values(r.lines.map((l) => ({ run_id: r.id, line: l.line, payee_discord_id: l.payeeDiscordId, address: l.address, amount: l.amount.toString(), memo: l.memo })) as never)
    .execute()
  if (data.payee) {
    const p = f.payee()
    await db
      .insertInto('payees')
      .values({ community_id: p.communityId, discord_user_id: p.discordUserId, address: p.address, registered_at: p.registeredAt.toISOString(), updated_at: p.updatedAt.toISOString() } as never)
      .execute()
  }
}

/** A community as a release before 0013 wrote it (no treasury channel columns). */
async function insertCommunityAsBefore0013(db: Kysely<Database>, c: ReturnType<typeof f.community>) {
  await db
    .insertInto('communities')
    .values({
      id: c.id,
      name: c.name,
      network: c.network,
      treasury_address: c.treasuryAddress,
      payout_token: c.payoutToken,
      fee_mode: c.feeMode,
      fee_token: c.feeToken,
      approver_role_id: c.approverRoleId,
      require_separate_approver: c.requireSeparateApprover ? 1 : 0,
      ai_proposals: c.aiProposals ? 1 : 0,
      proposer_role_id: c.proposerRoleId,
      preferred_tokens: c.preferredTokens ? 1 : 0,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt.toISOString(),
    } as never)
    .execute()
}

describe('sqlite: migrations and persistence', () => {
  it('migrates idempotently and keeps data across reopen', async () => {
    const path = join(dir, 'reopen.db')
    const a = await openSqliteDatabase(path)
    await a.repositories.communities.insert(f.community())
    await a.repositories.runs.insert(f.run())
    await a.close()
    const b = await openSqliteDatabase(path)
    opened.push(b)
    expect(await b.repositories.communities.get(f.GUILD)).toEqual(f.community())
    expect(await b.repositories.runs.get('run_fixture01')).toEqual(f.run())
  })

  it('0007 adds ai_usage to a database the earlier migrations made, with rows in it, and keeps them', async () => {
    const path = join(dir, 'before-ai-usage.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0006_policies')
    await insertAsBefore0009(before)
    await new SqlitePolicyRepository(before).insert(f.policy(), f.policyVersion())
    const event = await new SqliteAuditLog(before).append(f.auditEvent())
    const tables = () => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables()).not.toContain('ai_usage')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    expect(await after.repositories.communities.get(f.GUILD)).toEqual(f.community())
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    expect(await after.repositories.policies.get('pol_fixture01')).toEqual(f.policy())
    expect(await after.repositories.audit.query({ guildId: f.GUILD, types: [], actor: null, policyId: null, runId: null, since: null, until: null, before: null, limit: 10 })).toEqual([event])
    const row = await after.repositories.aiUsage.append(f.aiUsage())
    expect(await after.repositories.aiUsage.list(f.GUILD)).toEqual([row])
    await after.close()
    // Opening again runs nothing twice.
    const again = await openSqliteDatabase(path)
    opened.push(again)
    expect(await again.repositories.aiUsage.list(f.GUILD)).toEqual([row])
  })

  it('0008 adds policy_keys to a database 0007 left, with a community, its bot key, a policy and AI spend in it, and keeps them', async () => {
    const path = join(dir, 'before-policy-keys.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0007_ai_usage')
    await insertAsBefore0009(before)
    const bot = f.botKey({ status: 'active', authorizedAt: f.at(1) })
    // bot_keys has had the same columns since before 0007, so today's repository writes it as that release did.
    await new SqliteCommunityRepository(before).saveBotKey(bot)
    await new SqlitePolicyRepository(before).insert(f.policy(), f.policyVersion())
    const tables = () => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables()).toContain('ai_usage')
    expect(tables()).not.toContain('policy_keys')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    expect(await after.repositories.communities.listBotKeys(f.GUILD)).toEqual([bot])
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    expect(await after.repositories.policies.get('pol_fixture01')).toEqual(f.policy())
    const own = f.policyKey({ status: 'active', authorizedAt: f.at(2) })
    await after.repositories.policyKeys.save(own)
    expect(await after.repositories.policyKeys.listByPolicy('pol_fixture01')).toEqual([own])
    // The policy key is not a bot key: nothing that lists, retires or rotates bot keys sees it.
    expect(await after.repositories.communities.listBotKeys(f.GUILD)).toEqual([bot])
    await after.close()
    const again = await openSqliteDatabase(path)
    opened.push(again)
    expect(await again.repositories.policyKeys.get(own.address)).toEqual(own)
  })

  it('a policy stored before schedules had a minute (no minute in its schedule JSON) reads as on the hour, its versions too', async () => {
    const path = join(dir, 'before-minutes.db')
    const db = await openSqliteDatabase(path)
    await db.repositories.communities.insert(f.community())
    await db.repositories.policies.insert(f.policy(), f.policyVersion())
    await db.close()
    // The schedule JSON exactly as a release before minutes wrote it.
    const sqlite = new BetterSqlite3(path)
    const old = '{"kind":"weekly","weekday":"monday","hour":18,"timezone":"Europe/Lisbon"}'
    sqlite.prepare('UPDATE policies SET schedule = ?').run(old)
    sqlite.prepare('UPDATE policy_versions SET schedule = ?').run(old)
    expect((sqlite.prepare('SELECT schedule FROM policies').get() as { schedule: string }).schedule).not.toContain('minute')
    sqlite.close()

    const after = await openSqliteDatabase(path)
    opened.push(after)
    const p = await after.repositories.policies.get('pol_fixture01')
    expect(p).toEqual(f.policy())
    expect(p?.schedule).toEqual({ kind: 'weekly', weekday: 'monday', hour: 18, minute: 0, timezone: 'Europe/Lisbon' })
    expect((await after.repositories.policies.listVersions('pol_fixture01')).map((v) => v.schedule)).toEqual([p?.schedule])
  })

  it('a policy key belongs to a policy of a community: one for an unknown policy is refused', async () => {
    const db = await fresh()
    await db.repositories.communities.insert(f.community())
    await expect(db.repositories.policyKeys.save(f.policyKey({ policyId: 'pol_missing' }))).rejects.toThrow()
  })

  it('0009 adds preferred stablecoins to a database 0008 left, with communities, payees, runs, a policy and its own key in it: all as before, off by default', async () => {
    const path = join(dir, 'before-preferred-tokens.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0008_policy_keys')
    await insertAsBefore0009(before, { payee: true })
    await new SqlitePolicyRepository(before).insert(f.policy(), f.policyVersion())
    const own = f.policyKey({ status: 'active', authorizedAt: f.at(2) })
    await new SqlitePolicyKeyRepository(before).save(own)
    const tables = () => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables()).toContain('policy_keys')
    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(columns('payees')).not.toContain('preferred_token')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    opened.push(after)
    // Off for the existing community, no preference for the existing payee, existing lines paid in the run's token.
    expect(await after.repositories.communities.get(f.GUILD)).toEqual(f.community())
    expect((await after.repositories.communities.get(f.GUILD))?.preferredTokens).toBe(false)
    expect(await after.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(f.payee())
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    // The policy and its own key, which 0008 stored, are untouched.
    expect(await after.repositories.policies.get('pol_fixture01')).toEqual(f.policy())
    expect(await after.repositories.policyKeys.get(own.address)).toEqual(own)
    // The new columns take new data.
    const BETA = '0x20c0000000000000000000000000000000000002'
    await after.repositories.payees.upsert(f.payee({ preferredToken: BETA }))
    await after.repositories.communities.update(f.community({ preferredTokens: true }))
    expect((await after.repositories.payees.get(f.GUILD, f.ALICE))?.preferredToken).toBe(BETA)
    expect((await after.repositories.communities.get(f.GUILD))?.preferredTokens).toBe(true)
  })

  it('0010 adds the funding tables to a database 0009 left, with a community, a payee who prefers a stablecoin, a run, a policy and its own key in it, and keeps them', async () => {
    // The migration right before it is 0009: the database the last release left.
    expect(MIGRATION_NAMES[MIGRATION_NAMES.indexOf('0010_funding') - 1]).toBe('0009_preferred_tokens')
    const path = join(dir, 'before-0010.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0009_preferred_tokens')
    // 0010 adds tables only, so today's repositories write these rows exactly as the 0009 release did,
    // except the community and the payee, whose tables later releases widened (0013, 0012): they are
    // written with 0009's columns.
    const BETA = '0x20c0000000000000000000000000000000000002'
    const community = f.community({ preferredTokens: true })
    const payee = f.payee({ preferredToken: BETA })
    const own = f.policyKey({ status: 'active', authorizedAt: f.at(2) })
    await insertCommunityAsBefore0013(before, community)
    await before
      .insertInto('payees')
      .values({ community_id: payee.communityId, discord_user_id: payee.discordUserId, address: payee.address, preferred_token: BETA, registered_at: payee.registeredAt.toISOString(), updated_at: payee.updatedAt.toISOString() } as never)
      .execute()
    await new SqliteRunRepository(before).insert(f.run())
    await new SqlitePolicyRepository(before).insert(f.policy(), f.policyVersion())
    await new SqlitePolicyKeyRepository(before).save(own)
    const tables = () => (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name)
    expect(tables()).toContain('policy_keys')
    expect(tables()).not.toContain('funding_sources')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    expect(await after.repositories.communities.get(f.GUILD)).toEqual(community)
    expect(await after.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(payee)
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    expect(await after.repositories.policies.get('pol_fixture01')).toEqual(f.policy())
    expect(await after.repositories.policyKeys.get(own.address)).toEqual(own)
    expect(await after.repositories.funding.insertMaster(f.depositMaster())).toBe(true)
    expect(await after.repositories.funding.insertSource(f.fundingSource())).toBe('inserted')
    expect(await after.repositories.funding.insertDeposit(f.deposit())).toBe(true)
    await after.close()
    // Opening again runs nothing twice and keeps the rows.
    const again = await openSqliteDatabase(path)
    opened.push(again)
    expect(await again.repositories.funding.getMaster(f.GUILD)).toEqual(f.depositMaster())
    expect(await again.repositories.funding.listDeposits(f.GUILD)).toEqual([f.deposit()])
    expect(await again.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(payee)
  })

  it("0011 keeps the payee's Discord username on claim links, applied to a database 0010 left with a community, a payee, a spent and a live link, a run and a funding source in it", async () => {
    expect(MIGRATION_NAMES[MIGRATION_NAMES.indexOf('0011_link_usernames') - 1]).toBe('0010_funding')
    const path = join(dir, 'before-0011.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0010_funding')
    await insertAsBefore0009(before, { payee: true })
    // The link rows as the 0010 release wrote them (its columns only).
    const linkRow = (hash: string, consumed: Date | null) => ({
      token_hash: hash,
      community_id: f.GUILD,
      discord_user_id: f.ALICE,
      created_at: f.T0.toISOString(),
      expires_at: f.at(1800).toISOString(),
      consumed_at: consumed?.toISOString() ?? null,
    })
    await before.insertInto('link_tokens').values([linkRow('fp_spent', f.at(5)), linkRow('fp_live', null)] as never).execute()
    await new SqliteFundingRepository(before).insertSource(f.fundingSource())
    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(columns('link_tokens')).not.toContain('discord_username')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    opened.push(after)
    // The old links read as they were, with no username (the claim page falls back to the Discord ID).
    expect(await after.repositories.payees.getLinkToken('fp_spent')).toEqual(f.linkToken({ tokenHash: 'fp_spent', consumedAt: f.at(5) }))
    expect(await after.repositories.payees.getLinkToken('fp_live')).toEqual(f.linkToken({ tokenHash: 'fp_live' }))
    expect(await after.repositories.payees.consumeLinkToken('fp_live', f.at(6))).toBe(true)
    expect(await after.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(f.payee())
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    expect(await after.repositories.funding.getSource(f.fundingSource().id)).toEqual(f.fundingSource())
    // New links keep it.
    await after.repositories.payees.insertLinkToken(f.linkToken({ tokenHash: 'fp_new', discordUsername: 'alice' }))
    expect((await after.repositories.payees.getLinkToken('fp_new'))?.discordUsername).toBe('alice')
  })

  it("0012 records each payee's kind of address (passkey or their own wallet) and a link's wallet nonce, applied to a database 0010 left (the last release) with communities, payees, live links, a run, a policy and its own key, and a funding source", async () => {
    expect(MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf('0010_funding'), MIGRATION_NAMES.indexOf('0012_address_kinds') + 1)).toEqual(['0010_funding', '0011_link_usernames', '0012_address_kinds'])
    const path = join(dir, 'before-0012.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0010_funding')
    // Rows with 0010's columns only: a community, two payees (one who prefers a stablecoin), a run,
    // a live and a spent link, a policy with its own key, a funding source.
    await insertAsBefore0009(before, { payee: true })
    const BETA = '0x20c0000000000000000000000000000000000002'
    await before
      .insertInto('payees')
      .values({ community_id: f.GUILD, discord_user_id: f.BOB, address: f.ADDR.bob, preferred_token: BETA, registered_at: f.T0.toISOString(), updated_at: f.T0.toISOString() } as never)
      .execute()
    const linkRow = (hash: string, consumed: Date | null) => ({ token_hash: hash, community_id: f.GUILD, discord_user_id: f.ALICE, created_at: f.T0.toISOString(), expires_at: f.at(1800).toISOString(), consumed_at: consumed?.toISOString() ?? null })
    await before.insertInto('link_tokens').values([linkRow('fp_live', null), linkRow('fp_spent', f.at(5))] as never).execute()
    await new SqlitePolicyRepository(before).insert(f.policy(), f.policyVersion())
    const own = f.policyKey({ status: 'active', authorizedAt: f.at(2) })
    await new SqlitePolicyKeyRepository(before).save(own)
    await new SqliteFundingRepository(before).insertSource(f.fundingSource())
    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(columns('payees')).not.toContain('address_kind')
    expect(columns('link_tokens')).not.toContain('wallet_nonce')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    opened.push(after)
    // Everyone registered before is a passkey account; their stablecoin and dates are kept.
    expect(await after.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(f.payee())
    expect(await after.repositories.payees.get(f.GUILD, f.BOB)).toEqual(f.payee({ discordUserId: f.BOB, address: f.ADDR.bob, preferredToken: BETA }))
    expect((await after.repositories.payees.list(f.GUILD)).map((p) => p.addressKind)).toEqual(['passkey', 'passkey'])
    // The links read as before, with no nonce; the live one can take one, the spent one cannot.
    expect(await after.repositories.payees.getLinkToken('fp_live')).toEqual(f.linkToken({ tokenHash: 'fp_live' }))
    expect(await after.repositories.payees.setLinkNonce('fp_live', 'n1', f.at(10))).toBe(true)
    expect(await after.repositories.payees.setLinkNonce('fp_spent', 'n1', f.at(10))).toBe(false)
    expect(await after.repositories.payees.takeLinkNonce('fp_live', 'n1')).toBe(true)
    // The rest is untouched.
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    expect(await after.repositories.policies.get('pol_fixture01')).toEqual(f.policy())
    expect(await after.repositories.policyKeys.get(own.address)).toEqual(own)
    expect(await after.repositories.funding.getSource(f.fundingSource().id)).toEqual(f.fundingSource())
    // A re-claim with a wallet switches the kind in place.
    await after.repositories.payees.upsert(f.payee({ address: f.ADDR.carol, addressKind: 'external', updatedAt: f.at(20) }))
    await after.close()
    const again = await openSqliteDatabase(path)
    opened.push(again)
    expect(await again.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(f.payee({ address: f.ADDR.carol, addressKind: 'external', updatedAt: f.at(20) }))
  })

  it('0013 adds the treasury channel to a database 0012 left (the last release), with communities, payees, a run, a policy and its own key, and a funding source: none set, nobody chose, everything else as before', async () => {
    expect(MIGRATION_NAMES.at(-1)).toBe('0013_treasury_channel')
    expect(MIGRATION_NAMES[MIGRATION_NAMES.indexOf('0013_treasury_channel') - 1]).toBe('0012_address_kinds')
    const path = join(dir, 'before-0013.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0012_address_kinds')
    // Two communities with 0012's columns: one with every setting on, one plain.
    const busy = f.community({ approverRoleId: '400000000000000001', requireSeparateApprover: true, aiProposals: true, proposerRoleId: '400000000000000003', preferredTokens: true })
    const plain = f.community({ id: f.OTHER_GUILD, name: null })
    await insertCommunityAsBefore0013(before, busy)
    await insertCommunityAsBefore0013(before, plain)
    // The other tables have not changed since 0012, so today's repositories write them as that release did.
    const payee = f.payee({ addressKind: 'external' })
    await new SqliteRunRepository(before).insert(f.run())
    await before
      .insertInto('payees')
      .values({ community_id: payee.communityId, discord_user_id: payee.discordUserId, address: payee.address, preferred_token: null, address_kind: 'external', registered_at: payee.registeredAt.toISOString(), updated_at: payee.updatedAt.toISOString() } as never)
      .execute()
    await new SqlitePolicyRepository(before).insert(f.policy(), f.policyVersion())
    const own = f.policyKey({ status: 'active', authorizedAt: f.at(2) })
    await new SqlitePolicyKeyRepository(before).save(own)
    await new SqliteFundingRepository(before).insertSource(f.fundingSource())
    const columns = (table: string) => (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(columns('communities')).not.toContain('treasury_channel_id')
    await before.destroy()

    const after = await openSqliteDatabase(path)
    opened.push(after)
    // No treasury channel, and nobody chose one: Rolepay may look for #treasury. Every other setting is kept.
    expect(await after.repositories.communities.get(f.GUILD)).toEqual(busy)
    expect(await after.repositories.communities.get(f.OTHER_GUILD)).toEqual(plain)
    expect(await after.repositories.communities.get(f.GUILD)).toMatchObject({ treasuryChannelId: null, treasuryChannelSource: 'unset' })
    expect(await after.repositories.payees.get(f.GUILD, f.ALICE)).toEqual(payee)
    expect(await after.repositories.runs.get('run_fixture01')).toEqual(f.run())
    expect(await after.repositories.policies.get('pol_fixture01')).toEqual(f.policy())
    expect(await after.repositories.policyKeys.get(own.address)).toEqual(own)
    expect(await after.repositories.funding.getSource(f.fundingSource().id)).toEqual(f.fundingSource())
    // The new columns take the setting, and keep it across a reopen.
    expect(await after.repositories.communities.setTreasuryChannel(f.GUILD, { channelId: '700000000000000005', source: 'found', at: f.at(9) }, { channelId: null, source: 'unset' })).toBe(true)
    await after.close()
    const again = await openSqliteDatabase(path)
    opened.push(again)
    expect(await again.repositories.communities.get(f.GUILD)).toEqual({ ...busy, treasuryChannelId: '700000000000000005', treasuryChannelSource: 'found', updatedAt: f.at(9) })
    expect(await again.repositories.communities.get(f.OTHER_GUILD)).toEqual(plain)
  })

  it('keeps key-value records across reopen', async () => {
    const path = join(dir, 'reopen-kv.db')
    const a = await openSqliteDatabase(path)
    await a.kv.set('credential:abc', { publicKey: '0x04ab' })
    await a.close()
    const b = await openSqliteDatabase(path)
    opened.push(b)
    expect(await b.kv.get('credential:abc')).toEqual({ publicKey: '0x04ab' })
  })

  it('enforces foreign keys: a run for an unknown community is refused', async () => {
    const db = await fresh()
    await expect(db.repositories.runs.insert(f.run({ communityId: f.OTHER_GUILD }))).rejects.toThrow()
  })

  it('stores money as exact decimal text (no float, Postgres NUMERIC-compatible)', async () => {
    const db = await fresh()
    await db.repositories.communities.insert(f.community())
    const big = f.run()
    const huge = { ...big, lines: big.lines.map((l, i) => (i === 0 ? { ...l, amount: 123_456_789_012_345_678_901n } : l)) }
    await db.repositories.runs.insert({ ...huge, total: huge.lines.reduce((s, l) => s + l.amount, 0n) })
    expect((await db.repositories.runs.get(big.id))?.lines[0]?.amount).toBe(123_456_789_012_345_678_901n)
  })
})
