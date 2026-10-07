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
    await new SqliteCommunityRepository(before).insert(f.community())
    await new SqliteRunRepository(before).insert(f.run())
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
    const communities = new SqliteCommunityRepository(before)
    await communities.insert(f.community())
    const bot = f.botKey({ status: 'active', authorizedAt: f.at(1) })
    await communities.saveBotKey(bot)
    await new SqliteRunRepository(before).insert(f.run())
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

  it('a policy key belongs to a policy of a community: one for an unknown policy is refused', async () => {
    const db = await fresh()
    await db.repositories.communities.insert(f.community())
    await expect(db.repositories.policyKeys.save(f.policyKey({ policyId: 'pol_missing' }))).rejects.toThrow()
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
