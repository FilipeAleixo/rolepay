// The production wiring from config: SQLite file + AES vault + Tempo chain (no network used here).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DailyCappedProposer, TempoFundingChain, TempoPayoutChain, openRolepayAdapters } from '../src/adapters/index.js'
import { createRolepay, parseConfig } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'rolepay-wiring-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('openRolepayAdapters', () => {
  it('opens production adapters from config and composes working services', async () => {
    const config = parseConfig({ ROLEPAY_MASTER_KEY: 'c'.repeat(64), ROLEPAY_DB_PATH: join(dir, 'p.db') })
    const { deps, kv, close } = await openRolepayAdapters(config)
    expect(deps.chain).toBeInstanceOf(TempoPayoutChain)
    expect(deps.fundingChain).toBeInstanceOf(TempoFundingChain)
    expect(deps.network).toBe('moderato')
    expect(deps.swapMaxSlippageBps).toBe(100)
    const rolepay = createRolepay(deps)
    const r = await rolepay.communities.register({
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
    expect(rolepay.proposals.isConfigured()).toBe(false)
    // Deposit addresses can be set up, and nothing is read until a community does.
    expect(rolepay.funding.isConfigured()).toBe(true)
    expect(await rolepay.funding.scan()).toEqual({ deposits: [], errors: [] })
    await close()
  })

  it('with ANTHROPIC_API_KEY, proposals use Anthropic with the configured model, under the daily cap (no request is made here)', async () => {
    const config = parseConfig({ ROLEPAY_MASTER_KEY: 'c'.repeat(64), ROLEPAY_DB_PATH: join(dir, 'ai.db'), ANTHROPIC_API_KEY: 'sk-ant-test', ROLEPAY_AI_MODEL: 'claude-opus-5-5', ROLEPAY_AI_DAILY_CAP: '1' })
    const { deps, kv, close } = await openRolepayAdapters(config)
    expect(deps.proposer).toBeInstanceOf(DailyCappedProposer)
    expect(deps.proposer?.model).toBe('claude-opus-5-5')
    expect(createRolepay(deps).proposals.isConfigured()).toBe(true)
    // Today's one slot is already taken (in the same SQLite file): the next call never reaches Anthropic.
    await kv.create(`ai-daily-cap:${new Date().toISOString().slice(0, 10)}:0`, true)
    const answer = await deps.proposer?.fromMessages({ instruction: '50 each', messages: [], token: 'AlphaUSD', remaining: null, maxLines: 50 })
    expect(answer).toMatchObject({ ok: false, error: { code: 'could_not_propose', reason: 'daily_cap' } })
    await close()
  })
})
