import { beforeEach, describe, expect, it } from 'vitest'
import { FakePayoutChain } from '../adapters/memory/fakeChain.js'
import { MemoryCommunityRepository } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
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
    svc = new CommunityService({ communities, chain, vault, clock, network: 'moderato', ids: new SequentialIds(), setupLinkTtlSeconds: 1800 })
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

    it('stores the approver (Treasurer) role, which the Discord layer checks before asserting approval', async () => {
      const r = await register({ approverRoleId: '400000000000000001' })
      expect(r.ok && r.value.approverRoleId).toBe('400000000000000001')
      const changed = await svc.setApproverRole({ guildId: GUILD, approverRoleId: '400000000000000002', actorRoleIds: ['400000000000000001'] })
      expect(changed).toMatchObject({ ok: true, value: { approverRoleId: '400000000000000002' } })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { approverRoleId: '400000000000000002' } })
      expect(await svc.setApproverRole({ guildId: GUILD, approverRoleId: 'nope', actorRoleIds: ['400000000000000002'] })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
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

  describe('setup links (the treasurer page)', () => {
    const TREASURER = '300000000000000001'
    const ROLE = '400000000000000001'
    const PASSKEY_TREASURY = '0x7777777777777777777777777777777777777777'
    const settings = (over: Record<string, unknown> = {}) => ({ name: 'Mods guild', payoutToken: TOKEN, feeMode: 'sponsor' as const, approverRoleId: ROLE, ...over })
    const issue = (over: Record<string, unknown> = {}) => svc.issueSetupLink({ guildId: GUILD, discordUserId: TREASURER, settings: settings(over) })

    it('issues a short-lived token and stores only its fingerprint', async () => {
      const r = await issue()
      if (!r.ok) throw new Error(JSON.stringify(r.error))
      expect(r.value.expiresAt).toEqual(new Date(clock.now().getTime() + 1800_000))
      expect(await communities.getSetupLink(r.value.token)).toBeNull()
      expect(await communities.getSetupLink(`fp:${r.value.token}`)).toMatchObject({ communityId: GUILD, discordUserId: TREASURER })
    })

    it('refuses settings a community could never be registered with', async () => {
      expect(await issue({ feeMode: 'fee_budget' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await issue({ feeMode: 'fee_budget', feeToken: TOKEN })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await svc.issueSetupLink({ guildId: 'nope', discordUserId: TREASURER, settings: settings() })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    })

    it('describes a link: the guild, who it is for, and the community once registered', async () => {
      const r = await issue()
      if (!r.ok) throw new Error()
      expect(await svc.describeSetupLink({ token: r.value.token })).toMatchObject({
        ok: true,
        value: { guildId: GUILD, discordUserId: TREASURER, community: null, settings: { name: 'Mods guild', approverRoleId: ROLE } },
      })
      await register()
      expect(await svc.describeSetupLink({ token: r.value.token })).toMatchObject({ ok: true, value: { community: { treasuryAddress: TREASURY } } })
    })

    it('an unknown or expired link does nothing', async () => {
      expect(await svc.describeSetupLink({ token: 'nope' })).toEqual({ ok: false, error: { code: 'link_not_found' } })
      expect(await svc.bindTreasury({ token: 'nope', treasuryAddress: PASSKEY_TREASURY })).toEqual({ ok: false, error: { code: 'link_not_found' } })
      const r = await issue()
      if (!r.ok) throw new Error()
      clock.advance(1800)
      expect(await svc.describeSetupLink({ token: r.value.token })).toEqual({ ok: false, error: { code: 'link_expired' } })
      expect(await svc.bindTreasury({ token: r.value.token, treasuryAddress: PASSKEY_TREASURY })).toEqual({ ok: false, error: { code: 'link_expired' } })
      expect((await svc.get(GUILD)).ok).toBe(false)
    })

    it('binding the treasury registers the community with the link settings', async () => {
      const r = await issue({ feeMode: 'fee_budget', feeToken: FEE_TOKEN })
      if (!r.ok) throw new Error()
      const bound = await svc.bindTreasury({ token: r.value.token, treasuryAddress: PASSKEY_TREASURY.toUpperCase().replace('0X', '0x') })
      expect(bound).toMatchObject({
        ok: true,
        value: { id: GUILD, name: 'Mods guild', treasuryAddress: PASSKEY_TREASURY, payoutToken: TOKEN, feeMode: 'fee_budget', feeToken: FEE_TOKEN, approverRoleId: ROLE },
      })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { treasuryAddress: PASSKEY_TREASURY } })
    })

    it('binds once: the same treasury again is fine, a different one is refused', async () => {
      const r = await issue()
      if (!r.ok) throw new Error()
      await svc.bindTreasury({ token: r.value.token, treasuryAddress: PASSKEY_TREASURY })
      expect((await svc.bindTreasury({ token: r.value.token, treasuryAddress: PASSKEY_TREASURY })).ok).toBe(true)
      expect(await svc.bindTreasury({ token: r.value.token, treasuryAddress: TREASURY })).toEqual({
        ok: false,
        error: { code: 'treasury_mismatch', treasuryAddress: PASSKEY_TREASURY },
      })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { treasuryAddress: PASSKEY_TREASURY } })
    })

    it('a community already registered (the dev path) keeps its treasury', async () => {
      await register()
      const r = await issue()
      if (!r.ok) throw new Error()
      expect(await svc.bindTreasury({ token: r.value.token, treasuryAddress: PASSKEY_TREASURY })).toEqual({
        ok: false,
        error: { code: 'treasury_mismatch', treasuryAddress: TREASURY },
      })
      expect(await svc.bindTreasury({ token: r.value.token, treasuryAddress: TREASURY })).toMatchObject({ ok: true })
    })

    it('refuses a malformed treasury address', async () => {
      const r = await issue()
      if (!r.ok) throw new Error()
      expect(await svc.bindTreasury({ token: r.value.token, treasuryAddress: '0x12' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    })
  })

  describe('who may change the approval rules (H1: Manage Server alone must not make itself the approver)', () => {
    const ROLE = '400000000000000001'
    const NEW_ROLE = '400000000000000002'

    it('changing the approver role needs the CURRENT approver role; holding only the new one is not enough', async () => {
      await register({ approverRoleId: ROLE })
      expect(await svc.setApproverRole({ guildId: GUILD, approverRoleId: NEW_ROLE, actorRoleIds: [] })).toEqual({ ok: false, error: { code: 'not_permitted' } })
      expect(await svc.setApproverRole({ guildId: GUILD, approverRoleId: NEW_ROLE, actorRoleIds: [NEW_ROLE] })).toEqual({ ok: false, error: { code: 'not_permitted' } })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { approverRoleId: ROLE } })
      expect(await svc.setApproverRole({ guildId: GUILD, approverRoleId: NEW_ROLE, actorRoleIds: [ROLE] })).toMatchObject({ ok: true, value: { approverRoleId: NEW_ROLE } })
    })

    it('with no approver role yet, the first one is set by someone who holds it (the first-setup rule)', async () => {
      await register()
      expect(await svc.setApproverRole({ guildId: GUILD, approverRoleId: ROLE, actorRoleIds: [] })).toEqual({ ok: false, error: { code: 'not_permitted' } })
      expect(await svc.setApproverRole({ guildId: GUILD, approverRoleId: ROLE, actorRoleIds: [ROLE] })).toMatchObject({ ok: true, value: { approverRoleId: ROLE } })
    })

    it('switching the fee mode follows the same rule', async () => {
      await register({ approverRoleId: ROLE })
      expect(await svc.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: FEE_TOKEN, actorRoleIds: [] })).toEqual({ ok: false, error: { code: 'not_permitted' } })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'sponsor' } })
      expect(await svc.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: FEE_TOKEN, actorRoleIds: [ROLE] })).toMatchObject({ ok: true })
    })

    it('requireSeparateApprover is off by default, changes under the same rule, and travels with a first setup link', async () => {
      const r = await register({ approverRoleId: ROLE })
      expect(r.ok && r.value.requireSeparateApprover).toBe(false)
      expect(await svc.setRequireSeparateApprover({ guildId: GUILD, value: true, actorRoleIds: [] })).toEqual({ ok: false, error: { code: 'not_permitted' } })
      expect(await svc.setRequireSeparateApprover({ guildId: GUILD, value: true, actorRoleIds: [ROLE] })).toMatchObject({ ok: true, value: { requireSeparateApprover: true } })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { requireSeparateApprover: true } })

      const OTHER = '1094309218049937419'
      const link = await svc.issueSetupLink({
        guildId: OTHER,
        discordUserId: '300000000000000001',
        settings: { name: null, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: ROLE, requireSeparateApprover: true },
      })
      if (!link.ok) throw new Error(link.error.code)
      expect(await svc.bindTreasury({ token: link.value.token, treasuryAddress: TREASURY })).toMatchObject({ ok: true, value: { requireSeparateApprover: true } })
    })
  })

  describe('settings after registration', () => {
    it('stores the community name', async () => {
      await register({ name: null })
      expect(await svc.setName({ guildId: GUILD, name: 'Renamed guild' })).toMatchObject({ ok: true, value: { name: 'Renamed guild' } })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { name: 'Renamed guild' } })
      expect(await svc.setName({ guildId: GUILD, name: 'x'.repeat(101) })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await svc.setName({ guildId: '1094309218049937419', name: 'n' })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    })

    it('switches fee mode, and says when the bot key has no fee budget for it', async () => {
      await register()
      await svc.provisionBotKey(policy())
      await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      const toBudget = await svc.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: FEE_TOKEN, actorRoleIds: [] })
      expect(toBudget).toMatchObject({ ok: true, value: { community: { feeMode: 'fee_budget', feeToken: FEE_TOKEN }, keyNeedsFeeBudget: true } })
      expect(await svc.setFeeMode({ guildId: GUILD, feeMode: 'sponsor', feeToken: null, actorRoleIds: [] })).toMatchObject({
        ok: true,
        value: { community: { feeMode: 'sponsor', feeToken: null }, keyNeedsFeeBudget: false },
      })
    })

    it('a key provisioned in fee_budget mode carries the budget, so no new key is needed', async () => {
      await register({ feeMode: 'fee_budget', feeToken: FEE_TOKEN })
      await svc.provisionBotKey(policy({ feeBudget: 1_000_000n }))
      await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      await svc.setFeeMode({ guildId: GUILD, feeMode: 'sponsor', feeToken: null, actorRoleIds: [] })
      expect(await svc.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: FEE_TOKEN, actorRoleIds: [] })).toMatchObject({ ok: true, value: { keyNeedsFeeBudget: false } })
    })

    it('refuses fee_budget without a fee token, or with the payout token', async () => {
      await register()
      expect(await svc.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: null, actorRoleIds: [] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await svc.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: TOKEN, actorRoleIds: [] })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
      expect(await svc.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'sponsor' } })
    })
  })

  describe('revocation by the treasury from elsewhere (the setup page)', () => {
    it('confirmRevocation marks the active key revoked once the chain shows it', async () => {
      await register()
      await svc.provisionBotKey(policy())
      const auth = await svc.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })
      if (!auth.ok) throw new Error()
      expect(await svc.confirmRevocation({ guildId: GUILD })).toEqual({ ok: false, error: { code: 'key_not_revoked_on_chain' } })
      await chain.revokeKey({ root: chain.rootSigner(TREASURY), accessKey: auth.value.key.address })
      expect(await svc.confirmRevocation({ guildId: GUILD })).toMatchObject({ ok: true, value: { status: 'revoked', revokedAt: clock.now() } })
      expect(await svc.confirmRevocation({ guildId: GUILD })).toEqual({ ok: false, error: { code: 'no_active_key' } })
      expect(await svc.confirmRevocation({ guildId: '1094309218049937419' })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    })
  })
})
