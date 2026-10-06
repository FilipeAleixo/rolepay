import { beforeEach, describe, expect, it } from 'vitest'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { MemoryCommunityRepository } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault } from '../adapters/memory/support.js'
import { TRANSFER_WITH_MEMO_SIGNATURE } from '../constants/tempo.js'
import { CommunityService } from './communityService.js'

const GUILD = '1094309218049937418'
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const FEE_TOKEN = '0x20c0000000000000000000000000000000000000'

describe('CommunityService', () => {
  let chain: FakePayoutChain
  let communities: MemoryCommunityRepository
  let vault: PlainKeyVault
  let clock: ManualClock
  let svc: CommunityService
  const nowS = () => Math.floor(clock.now().getTime() / 1000)

  beforeEach(() => {
    clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
    chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
    communities = new MemoryCommunityRepository()
    vault = new PlainKeyVault()
    svc = new CommunityService({ communities, chain, vault, clock, network: 'moderato' })
  })

  const register = (over: Record<string, unknown> = {}) =>
    svc.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', ...over })

  const policy = (over: Record<string, unknown> = {}) => ({
    guildId: GUILD,
    limit: 10_000_000n,
    periodSeconds: 2_592_000,
    expiresAt: nowS() + 30 * 86_400,
    ...over,
  })

  describe('register', () => {
    it('registers a guild as a community on the configured network', async () => {
      const r = await register()
      expect(r).toMatchObject({ ok: true, value: { id: GUILD, network: 'moderato', treasuryAddress: TREASURY, feeMode: 'sponsor' } })
      expect((await svc.get(GUILD)).ok).toBe(true)
    })

    it('normalises addresses to lowercase', async () => {
      const r = await register({ treasuryAddress: '0xABCDEF9999999999999999999999999999999999' })
      expect(r.ok && r.value.treasuryAddress).toBe('0xabcdef9999999999999999999999999999999999')
    })

    it('refuses a second registration of the same guild', async () => {
      await register()
      expect(await register()).toEqual({ ok: false, error: { code: 'already_registered' } })
    })

    it.each([
      { treasuryAddress: '0x123' },
      { guildId: 'not-a-snowflake' },
      { feeMode: 'fee_budget' }, // needs a fee token
      { feeMode: 'fee_budget', feeToken: TOKEN }, // fee token must differ from payout token
    ])('rejects invalid input %j', async (over) => {
      expect(await register(over)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    })

    it('says community_not_found for an unknown guild', async () => {
      expect(await svc.get(GUILD)).toEqual({ ok: false, error: { code: 'community_not_found' } })
    })
  })

  describe('bot key lifecycle', () => {
    beforeEach(async () => {
      await register()
    })

    it('provisions a fresh access key, seals its secret, and returns what the root must sign', async () => {
      const r = await svc.provisionBotKey(policy())
      if (!r.ok) throw new Error(r.error.code)
      expect(r.value.account).toBe(TREASURY)
      expect(r.value.authorization).toEqual({
        expiry: policy().expiresAt,
        limits: [{ token: TOKEN, limit: 10_000_000n, period: 2_592_000 }],
        scopes: [{ address: TOKEN, selector: TRANSFER_WITH_MEMO_SIGNATURE }],
      })
      const stored = await communities.getBotKey(r.value.keyAddress)
      expect(stored?.status).toBe('pending_authorization')
      expect(stored?.sealedSecret).not.toMatch(/^fake-secret-\d+$/) // never stored in the clear
      expect('sealedSecret' in r.value).toBe(false) // never handed out
    })

    it('carries the optional recipient allowlist into the scope', async () => {
      const r = await svc.provisionBotKey(policy({ recipients: ['0x1111111111111111111111111111111111111111'] }))
      expect(r.ok && r.value.authorization.scopes[0]?.recipients).toEqual(['0x1111111111111111111111111111111111111111'])
    })

    it('rejects a policy that has already expired or has no limit', async () => {
      expect(await svc.provisionBotKey(policy({ expiresAt: nowS() - 1 }))).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await svc.provisionBotKey(policy({ limit: 0n }))).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    })

    it('requires a fee budget in fee_budget mode and adds it as a second limit', async () => {
      const g = '1094309218049937420'
      await register({ guildId: g, feeMode: 'fee_budget', feeToken: FEE_TOKEN })
      expect(await svc.provisionBotKey(policy({ guildId: g }))).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      const r = await svc.provisionBotKey(policy({ guildId: g, feeBudget: 1_000_000n }))
      expect(r.ok && r.value.authorization.limits[1]).toEqual({ token: FEE_TOKEN, limit: 1_000_000n, period: 2_592_000 })
    })

    it('authorises with a root signer, then reports the key active with its full limit', async () => {
      const p = await svc.provisionBotKey(policy())
      if (!p.ok) throw new Error()
      const a = await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      expect(a).toMatchObject({ ok: true, value: { key: { address: p.value.keyAddress, status: 'active' } } })
      const s = await svc.keyStatus({ guildId: GUILD })
      expect(s).toMatchObject({ ok: true, value: { key: { status: 'active' }, state: { status: 'active', remaining: 10_000_000n } } })
    })

    it('confirm leaves the key pending while the chain does not show it authorised', async () => {
      await svc.provisionBotKey(policy())
      expect(await svc.confirmBotKey({ guildId: GUILD })).toEqual({ ok: false, error: { code: 'key_not_authorized_on_chain' } })
      expect(await svc.confirmBotKey({ guildId: '1094309218049937499' })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    })

    it('a newly confirmed key supersedes the previous active key (rotation)', async () => {
      const first = await svc.provisionBotKey(policy())
      await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      const second = await svc.provisionBotKey(policy())
      await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      if (!first.ok || !second.ok) throw new Error()
      expect((await communities.getBotKey(first.value.keyAddress))?.status).toBe('superseded')
      expect((await communities.getBotKey(second.value.keyAddress))?.status).toBe('active')
    })

    it('re-provisioning supersedes a key still waiting for authorisation', async () => {
      const first = await svc.provisionBotKey(policy())
      await svc.provisionBotKey(policy())
      if (!first.ok) throw new Error()
      expect((await communities.getBotKey(first.value.keyAddress))?.status).toBe('superseded')
    })

    it('revokes on chain with the root signer; status then reports it revoked', async () => {
      await svc.provisionBotKey(policy())
      await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      const r = await svc.revokeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      expect(r).toMatchObject({ ok: true, value: { key: { status: 'revoked' } } })
      expect(await svc.keyStatus({ guildId: GUILD })).toMatchObject({ ok: true, value: { key: { status: 'revoked' }, state: { status: 'revoked' } } })
    })

    it('keyStatus and authorize say no_bot_key before any key exists', async () => {
      expect(await svc.keyStatus({ guildId: GUILD })).toEqual({ ok: false, error: { code: 'no_bot_key' } })
      expect(await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })).toEqual({
        ok: false,
        error: { code: 'no_pending_key' },
      })
    })
  })
})
