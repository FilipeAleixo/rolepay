// The production wiring from config: SQLite file + AES vault + Tempo chain (no network used here).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TempoPayoutChain, openPayrunAdapters } from '../src/adapters/index.js'
import { createPayrun, parseConfig } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'payrun-wiring-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('openPayrunAdapters', () => {
  it('opens production adapters from config and composes working services', async () => {
    const config = parseConfig({ PAYRUN_MASTER_KEY: 'c'.repeat(64), PAYRUN_DB_PATH: join(dir, 'p.db') })
    const { deps, kv, close } = await openPayrunAdapters(config)
    expect(deps.chain).toBeInstanceOf(TempoPayoutChain)
    expect(deps.network).toBe('moderato')
    const payrun = createPayrun(deps)
    const r = await payrun.communities.register({
      guildId: '1094309218049937418',
      name: 'wired',
      treasuryAddress: '0x9999999999999999999999999999999999999999',
      payoutToken: '0x20c0000000000000000000000000000000000001',
      feeMode: 'sponsor',
    })
    expect(r.ok).toBe(true)
    // The key-value store lives in the same database file.
    await kv.set('k', { v: 1 })
    expect(await kv.get('k')).toEqual({ v: 1 })
    await close()
  })
})
