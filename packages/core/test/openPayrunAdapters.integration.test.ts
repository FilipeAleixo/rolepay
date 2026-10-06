// The production wiring from config: SQLite file + AES vault + Tempo chain (no network used here).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AnthropicRunProposer, TempoPayoutChain, openPayrunAdapters } from '../src/adapters/index.js'
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
    expect(deps.proposer).toBeNull()
    expect(payrun.proposals.isConfigured()).toBe(false)
    await close()
  })

  it('with ANTHROPIC_API_KEY, proposals use Anthropic with the configured model (no request is made here)', async () => {
    const config = parseConfig({ PAYRUN_MASTER_KEY: 'c'.repeat(64), PAYRUN_DB_PATH: join(dir, 'ai.db'), ANTHROPIC_API_KEY: 'sk-ant-test', PAYRUN_AI_MODEL: 'claude-opus-5-5' })
    const { deps, close } = await openPayrunAdapters(config)
    expect(deps.proposer).toBeInstanceOf(AnthropicRunProposer)
    expect(deps.proposer?.model).toBe('claude-opus-5-5')
    expect(createPayrun(deps).proposals.isConfigured()).toBe(true)
    await close()
  })
})
