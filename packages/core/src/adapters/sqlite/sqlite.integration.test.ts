import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { keyValueContract } from '../../../test/support/keyValueContract.js'
import { repositoryContracts } from '../../../test/support/repositoryContracts.js'
import * as f from '../../../test/support/fixtures.js'
import { openSqliteDatabase } from './index.js'

// Real SQLite on a temp file (not :memory:), so file-level behaviour is exercised too.
const dir = mkdtempSync(join(tmpdir(), 'payrun-sqlite-'))
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
