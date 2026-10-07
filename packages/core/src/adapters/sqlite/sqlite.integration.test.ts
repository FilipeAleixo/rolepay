import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { keyValueContract } from '../../../test/support/keyValueContract.js'
import { policyRepositoryContract } from '../../../test/support/policyRepositoryContract.js'
import { proposalRepositoryContract } from '../../../test/support/proposalRepositoryContract.js'
import { repositoryContracts } from '../../../test/support/repositoryContracts.js'
import * as f from '../../../test/support/fixtures.js'
import { type Database, openSqliteDatabase } from './index.js'
import { migrateTo } from './migrations.js'
import { SqliteAuditLog, SqlitePolicyRepository } from './policyRepositories.js'

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

/**
 * Rows as a release before 0008 wrote them (its columns only), so a migration test starts from the
 * database that release left, not from what today's repositories would write.
 */
async function insertAsBefore0008(db: Kysely<Database>, data: { payee?: boolean } = {}) {
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
    await insertAsBefore0008(before)
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

  it('0008 adds preferred stablecoins to a database 0007 left, with communities, payees and runs in it: all as before, off by default', async () => {
    const path = join(dir, 'before-preferred-tokens.db')
    const sqlite = new BetterSqlite3(path)
    sqlite.pragma('foreign_keys = ON')
    const before = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await migrateTo(before as unknown as Kysely<unknown>, '0007_ai_usage')
    await insertAsBefore0008(before, { payee: true })
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
    // The new columns take new data.
    const BETA = '0x20c0000000000000000000000000000000000002'
    await after.repositories.payees.upsert(f.payee({ preferredToken: BETA }))
    await after.repositories.communities.update(f.community({ preferredTokens: true }))
    expect((await after.repositories.payees.get(f.GUILD, f.ALICE))?.preferredToken).toBe(BETA)
    expect((await after.repositories.communities.get(f.GUILD))?.preferredTokens).toBe(true)
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
