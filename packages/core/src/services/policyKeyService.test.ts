import { describe, expect, it } from 'vitest'
import { GUILD, OTHER_GUILD, TOKEN, TREASURER, TREASURY, policyWorld, usd } from '../../test/support/policyWorld.js'
import { policyKeyContext } from '../domain/policy/policyKey.js'

const WEEK = 7 * 86_400

/** A world with an active help desk policy and a provisioned (pending) key of its own: 30 a week. */
async function withPendingKey(opts: { limit?: number } = {}) {
  const w = await policyWorld({ limit: 1000 })
  const policy = await w.active()
  const p = await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId: policy.id, limit: usd(opts.limit ?? 30), periodSeconds: WEEK, expiresAt: w.chain.time + 60 * 86_400 })
  if (!p.ok) throw new Error(JSON.stringify(p.error))
  return { ...w, policy, provisioned: p.value }
}

/** What the treasury page does with the passkey: sign the authorisation the server returned, on chain. */
async function signOnChain(w: Awaited<ReturnType<typeof withPendingKey>>, revoke: string[] = []) {
  for (const k of revoke) await w.chain.revokeKey({ root: w.chain.rootSigner(TREASURY), accessKey: k as `0x${string}` })
  const r = await w.chain.authorizeKey({ root: w.chain.rootSigner(TREASURY), accessKey: w.provisioned.keyAddress, authorization: w.provisioned.authorization })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
}

describe('PolicyKeyService: a policy gets its own key', () => {
  it("provision mints a fresh key for the policy, sealed for that policy alone, and returns the authorisation the passkey signs", async () => {
    const w = await withPendingKey()
    const { provisioned: p, policy } = w
    expect(p.account).toBe(TREASURY)
    expect(p.authorization).toEqual({
      expiry: w.chain.time + 60 * 86_400,
      limits: [{ token: TOKEN, limit: usd(30), period: WEEK }],
      scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }],
    })
    const [stored] = await w.repos.policyKeys.listByPolicy(policy.id)
    expect(stored).toMatchObject({ address: p.keyAddress, policyId: policy.id, communityId: GUILD, status: 'pending_authorization', authorizedAt: null })
    // Sealed under the policy key's context: the bot key's context does not open it.
    expect(stored?.sealedSecret).toContain(policyKeyContext(GUILD, policy.id, p.keyAddress))
    // Not a bot key: the bot key is untouched and the policy still pays from it until the passkey signs.
    expect((await w.repos.communities.listBotKeys(GUILD)).map((k) => k.status)).toEqual(['active'])
    expect(await w.rolepay.policyKeys.budget({ guildId: GUILD, policyId: policy.id })).toEqual({ key: 'bot', remaining: usd(1000) })
  })

  it('a second provision supersedes the waiting key of this policy only (its secret is destroyed)', async () => {
    const w = await withPendingKey()
    const other = await w.active({ name: 'Other' })
    const theirs = await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId: other.id, limit: usd(5), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 })
    const again = await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId: w.policy.id, limit: usd(40), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 })
    if (!again.ok || !theirs.ok) throw new Error('provision failed')
    const mine = await w.repos.policyKeys.listByPolicy(w.policy.id)
    expect(mine.map((k) => [k.address, k.status, k.sealedSecret === null])).toEqual([
      [again.value.keyAddress, 'pending_authorization', false],
      [w.provisioned.keyAddress, 'superseded', true],
    ])
    expect((await w.repos.policyKeys.listByPolicy(other.id)).map((k) => k.status)).toEqual(['pending_authorization'])
  })

  it('refuses an unknown policy, another community\'s policy, an archived policy, a past expiry and a fee budget missing in fee budget mode', async () => {
    const w = await policyWorld()
    const p = await w.active()
    const input = { guildId: GUILD, policyId: p.id, limit: usd(30), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 }
    expect(await w.rolepay.policyKeys.provision({ ...input, policyId: 'pol_nope' })).toEqual({ ok: false, error: { code: 'policy_not_found' } })
    expect(await w.rolepay.policyKeys.provision({ ...input, guildId: OTHER_GUILD })).toEqual({ ok: false, error: { code: 'community_not_found' } })
    expect(await w.rolepay.policyKeys.provision({ ...input, expiresAt: w.chain.time - 1 })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(await w.rolepay.policyKeys.provision({ ...input, limit: 0n })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    await w.rolepay.communities.setFeeMode({ guildId: GUILD, feeMode: 'fee_budget', feeToken: '0x20c0000000000000000000000000000000000000', actorRoleIds: ['400000000000000001'] })
    expect(await w.rolepay.policyKeys.provision(input)).toMatchObject({ ok: false, error: { code: 'invalid_input', issues: ['feeBudget: required in fee_budget mode'] } })
    const withFee = await w.rolepay.policyKeys.provision({ ...input, feeBudget: usd(1) })
    expect(withFee.ok && withFee.value.authorization.limits).toEqual([
      { token: TOKEN, limit: usd(30), period: WEEK },
      { token: '0x20c0000000000000000000000000000000000000', limit: usd(1), period: WEEK },
    ])
    await w.rolepay.policies.archive({ guildId: GUILD, actor: TREASURER, actorRoleIds: ['400000000000000001'], policyId: p.id })
    expect(await w.rolepay.policyKeys.provision({ ...input, feeBudget: usd(1) })).toEqual({ ok: false, error: { code: 'policy_archived' } })
  })

  it('confirm marks the key active only once the chain shows it, then the policy pays from it alone; the audit log says so', async () => {
    const w = await withPendingKey()
    const ref = { guildId: GUILD, policyId: w.policy.id, keyAddress: w.provisioned.keyAddress, actor: TREASURER }
    expect(await w.rolepay.policyKeys.confirm(ref)).toEqual({ ok: false, error: { code: 'key_not_authorized_on_chain' } })
    await signOnChain(w)
    const confirmed = await w.rolepay.policyKeys.confirm({ ...ref, keyAddress: ref.keyAddress.toUpperCase().replace('0X', '0x') })
    expect(confirmed).toMatchObject({ ok: true, value: { address: ref.keyAddress, status: 'active', policyId: w.policy.id } })
    expect(confirmed.ok && 'sealedSecret' in confirmed.value).toBe(false)
    expect(await w.rolepay.policyKeys.budget({ guildId: GUILD, policyId: w.policy.id })).toEqual({ key: 'policy', remaining: usd(30) })
    const status = await w.rolepay.policyKeys.status({ guildId: GUILD, policyId: w.policy.id })
    expect(status).toMatchObject({ ok: true, value: { signs: 'own', key: { address: ref.keyAddress, status: 'active' }, state: { status: 'active', remaining: usd(30) } } })
    // The bot key is untouched and still what every other run pays from.
    expect((await w.rolepay.communities.keyStatus({ guildId: GUILD })).ok).toBe(true)
    const audit = await w.rolepay.audit.list({ guildId: GUILD, types: ['policy_key.authorized'] })
    expect(audit.ok && audit.value.events).toMatchObject([
      { type: 'policy_key.authorized', actor: TREASURER, policyId: w.policy.id, details: { key: ref.keyAddress, limit: '30', periodSeconds: WEEK, replaced: 0 } },
    ])
    // Confirming again finds nothing waiting.
    expect(await w.rolepay.policyKeys.confirm(ref)).toEqual({ ok: false, error: { code: 'no_pending_key' } })
  })

  it("rotation: the new key is confirmed, this policy's old key is retired (revoked when the chain shows it) and its secret destroyed", async () => {
    const w = await withPendingKey()
    await signOnChain(w)
    await w.rolepay.policyKeys.confirm({ guildId: GUILD, policyId: w.policy.id, keyAddress: w.provisioned.keyAddress, actor: TREASURER })
    const old = w.provisioned.keyAddress
    const next = await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId: w.policy.id, limit: usd(50), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 })
    if (!next.ok) throw new Error('provision')
    // While the new key waits for the passkey, the old one still pays.
    expect(await w.rolepay.policyKeys.budget({ guildId: GUILD, policyId: w.policy.id })).toEqual({ key: 'policy', remaining: usd(30) })
    await signOnChain({ ...w, provisioned: next.value }, [old])
    expect(await w.rolepay.policyKeys.confirm({ guildId: GUILD, policyId: w.policy.id, keyAddress: next.value.keyAddress, actor: TREASURER })).toMatchObject({ ok: true })
    const keys = await w.repos.policyKeys.listByPolicy(w.policy.id)
    expect(keys.map((k) => [k.status, k.sealedSecret === null])).toEqual([
      ['active', false],
      ['revoked', true],
    ])
    const audit = await w.rolepay.audit.list({ guildId: GUILD, types: ['policy_key.authorized'] })
    expect(audit.ok && audit.value.events[0]?.details).toMatchObject({ limit: '50', replaced: 1 })
  })

  it('revoking: recorded only once the chain shows it, then the policy is stopped and never falls back to the bot key', async () => {
    const w = await withPendingKey()
    await signOnChain(w)
    const key = w.provisioned.keyAddress
    await w.rolepay.policyKeys.confirm({ guildId: GUILD, policyId: w.policy.id, keyAddress: key, actor: TREASURER })
    const ref = { guildId: GUILD, policyId: w.policy.id, keyAddress: key, actor: TREASURER }
    expect(await w.rolepay.policyKeys.confirmRevocation(ref)).toEqual({ ok: false, error: { code: 'key_not_revoked_on_chain' } })
    await w.chain.revokeKey({ root: w.chain.rootSigner(TREASURY), accessKey: key })
    expect(await w.rolepay.policyKeys.confirmRevocation(ref)).toMatchObject({ ok: true, value: { status: 'revoked' } })
    expect((await w.repos.policyKeys.get(key))?.sealedSecret).toBeNull()
    expect(await w.rolepay.policyKeys.budget({ guildId: GUILD, policyId: w.policy.id })).toEqual({ key: 'policy', remaining: null })
    expect(await w.rolepay.policyKeys.status({ guildId: GUILD, policyId: w.policy.id })).toMatchObject({ ok: true, value: { signs: 'retired', key: { status: 'revoked' } } })
    expect(await w.rolepay.policyKeys.confirmRevocation(ref)).toEqual({ ok: false, error: { code: 'key_not_found' } })
    const audit = await w.rolepay.audit.list({ guildId: GUILD, types: ['policy_key.revoked'] })
    expect(audit.ok && audit.value.events).toMatchObject([{ type: 'policy_key.revoked', actor: TREASURER, policyId: w.policy.id, details: { key } }])
    // Another policy's key or the bot key cannot be "revoked" through this policy.
    const bot = (await w.repos.communities.listBotKeys(GUILD))[0]?.address as string
    expect(await w.rolepay.policyKeys.confirmRevocation({ ...ref, keyAddress: bot })).toEqual({ ok: false, error: { code: 'key_not_found' } })
  })

  it('listKeys: every key of the policy not known to be revoked, with what the chain says (the page revokes the live ones)', async () => {
    const w = await withPendingKey()
    await signOnChain(w)
    const listed = await w.rolepay.policyKeys.listKeys({ guildId: GUILD, policyId: w.policy.id })
    expect(listed).toMatchObject({ ok: true, value: [{ key: { address: w.provisioned.keyAddress, status: 'pending_authorization' }, state: { status: 'active', remaining: usd(30) } }] })
    expect(await w.rolepay.policyKeys.listKeys({ guildId: GUILD, policyId: 'pol_nope' })).toEqual({ ok: false, error: { code: 'policy_not_found' } })
  })

  it('the bot key changing (replaced or revoked) never touches a policy key', async () => {
    const w = await withPendingKey()
    await signOnChain(w)
    await w.rolepay.policyKeys.confirm({ guildId: GUILD, policyId: w.policy.id, keyAddress: w.provisioned.keyAddress, actor: TREASURER })
    await w.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd(10), periodSeconds: null, expiresAt: w.chain.time + 86_400 })
    expect((await w.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: w.chain.rootSigner(TREASURY) })).ok).toBe(true)
    expect((await w.rolepay.communities.revokeBotKey({ guildId: GUILD, root: w.chain.rootSigner(TREASURY) })).ok).toBe(true)
    const [own] = await w.repos.policyKeys.listByPolicy(w.policy.id)
    expect(own).toMatchObject({ status: 'active' })
    expect(own?.sealedSecret).not.toBeNull()
    expect(await w.rolepay.policyKeys.budget({ guildId: GUILD, policyId: w.policy.id })).toEqual({ key: 'policy', remaining: usd(30) })
  })

  it('dev path: an in-process root authorises (revoking the old key in the same go) and revokes, like the page', async () => {
    const w = await withPendingKey()
    const root = w.chain.rootSigner(TREASURY)
    const first = await w.rolepay.policyKeys.authorize({ guildId: GUILD, policyId: w.policy.id, root })
    expect(first).toMatchObject({ ok: true, value: { key: { status: 'active' } } })
    await w.rolepay.policyKeys.provision({ guildId: GUILD, policyId: w.policy.id, limit: usd(20), periodSeconds: WEEK, expiresAt: w.chain.time + 86_400 })
    expect(await w.rolepay.policyKeys.authorize({ guildId: GUILD, policyId: w.policy.id, root })).toMatchObject({ ok: true, value: { key: { status: 'active', policy: { limit: usd(20) } } } })
    expect((await w.chain.keyState({ account: TREASURY, accessKey: w.provisioned.keyAddress, token: TOKEN, feeToken: null })).status).toBe('revoked')
    expect(await w.rolepay.policyKeys.authorize({ guildId: GUILD, policyId: w.policy.id, root })).toEqual({ ok: false, error: { code: 'no_pending_key' } })
    expect(await w.rolepay.policyKeys.revoke({ guildId: GUILD, policyId: w.policy.id, root, actor: null })).toMatchObject({ ok: true, value: { key: { status: 'revoked' } } })
    expect(await w.rolepay.policyKeys.revoke({ guildId: GUILD, policyId: w.policy.id, root, actor: null })).toEqual({ ok: false, error: { code: 'no_active_key' } })
    expect(await w.rolepay.policyKeys.budget({ guildId: GUILD, policyId: w.policy.id })).toEqual({ key: 'policy', remaining: null })
  })
})
