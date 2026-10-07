import { describe, expect, it } from 'vitest'
import { GUILD, OTHER_PASSKEY, PASSKEY, ROLE, TOKEN, TREASURER, approvedPolicy, pageConfig, registeredCommunity, setupLink, webHarness } from '../../test/harness.js'

type H = ReturnType<typeof webHarness>
type Json = any
const json = async (res: Response): Promise<Json> => res.json()
const inDays = (h: H, n: number) => Math.floor(h.clock.now().getTime() / 1000) + n * 86_400
const WEEK = 7 * 86_400

/** What the treasurer's browser does after the server hands it an authorisation: sign it on chain with the passkey. */
async function signOnChain(h: H, body: { keyAddress: string; authorization: { expiry: number; limits: { token: string; limit: string; period?: number }[]; scopes: unknown[] } }) {
  const authorization = { ...body.authorization, limits: body.authorization.limits.map((l) => ({ ...l, limit: BigInt(l.limit) })) }
  const r = await h.chain.authorizeKey({ root: h.chain.rootSigner(PASSKEY), accessKey: body.keyAddress as `0x${string}`, authorization: authorization as never })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
}

/** A registered community with an approved policy, its bot key active, and a live setup link. */
async function world() {
  const h = webHarness()
  await registeredCommunity(h)
  await h.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: 500_000_000n, periodSeconds: 30 * 86_400, expiresAt: inDays(h, 30) })
  await h.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: h.chain.rootSigner(PASSKEY) })
  const policy = await approvedPolicy(h)
  const token = await setupLink(h)
  const base = `/setup/${token}/policies/${policy.id}`
  return { h, policy, token, base }
}

describe("a policy's budget page (/setup/:token/policies/:policyId)", () => {
  it("renders for a live link with the policy, defaulting the limit to its cap per run and the period to one run of its schedule", async () => {
    const { h, policy, token, base } = await world()
    const res = await h.send(base)
    expect(res.status).toBe(200)
    const html = await res.clone().text()
    expect(await pageConfig(res)).toMatchObject({
      page: 'policy-budget',
      token,
      policyId: policy.id,
      policyName: 'Treasurers',
      guildName: 'Mods guild',
      treasury: PASSKEY,
      payoutToken: TOKEN,
      tokenLabel: 'AlphaUSD',
      feeMode: 'sponsor',
      defaults: { limit: '30', periodDays: 7, validityDays: 30, feeBudget: '1' },
    })
    expect(html).toContain('Treasurers')
    expect(html).toContain('id="budget-form"')
    // Escaped like every string a person controls.
    const named = await approvedPolicy(h, { name: '<script>x</script>' })
    expect(await (await h.send(`/setup/${token}/policies/${named.id}`)).text()).not.toContain('<script>x</script>')
  })

  it("without a cap per run, the limit starts from the server's bot key default", async () => {
    const { h, token } = await world()
    const uncapped = await approvedPolicy(h, { perRun: null, name: 'Uncapped' })
    expect(await pageConfig(await h.send(`/setup/${token}/policies/${uncapped.id}`))).toMatchObject({ defaults: { limit: '100' } })
  })

  it('an unknown policy, an unknown or expired link, or a community without a treasury gets an error page', async () => {
    const { h, token, base } = await world()
    expect((await h.send(`/setup/${token}/policies/pol_nope`)).status).toBe(404)
    expect((await h.send('/setup/nope/policies/pol_nope')).status).toBe(404)
    h.clock.advance(1800)
    expect((await h.send(base)).status).toBe(410)
    const fresh = webHarness()
    const unbound = await setupLink(fresh)
    expect((await fresh.send(`/setup/${unbound}/policies/pol_x`)).status).toBe(409)
  })

  it("state: who is signed in, and the policy's own key (none yet: it pays from the bot key)", async () => {
    const { h, policy, base } = await world()
    expect(await json(await h.send(`${base}/state`))).toMatchObject({ ok: true, policy: { id: policy.id, name: 'Treasurers', status: 'active' }, signs: 'bot', key: null, keys: [], isTreasurer: false })
    expect(await json(await h.send(`${base}/state`, { passkey: PASSKEY }))).toMatchObject({ isTreasurer: true, signInRequired: false })
    expect(await json(await h.send(`${base}/state`, { passkey: { address: PASSKEY, proof: 'registration', issuedAt: Math.floor(h.clock.now().getTime() / 1000) + 60 } }))).toMatchObject({
      isTreasurer: false,
      signInRequired: true,
    })
  })

  it('provisioning needs the treasury passkey, proven by a sign-in', async () => {
    const { h, base } = await world()
    const body = { limit: '30', periodDays: 7, expiresAt: inDays(h, 30) }
    expect((await h.post(`${base}/key`, body)).status).toBe(401)
    expect(await json(await h.post(`${base}/key`, body, OTHER_PASSKEY))).toMatchObject({ ok: false, error: { code: 'not_the_treasury' } })
    expect((await h.post(`${base}/key`, body, { address: PASSKEY, proof: 'registration', issuedAt: Math.floor(h.clock.now().getTime() / 1000) + 60 })).status).toBe(401)
    expect((await h.post(`${base}/key`, { ...body, limit: 'lots' }, PASSKEY)).status).toBe(400)
    expect((await h.post(`${base}/key`, { ...body, expiresAt: inDays(h, 400) }, PASSKEY)).status).toBe(400)
  })

  it('give the policy its own budget: provision, sign on chain, confirm; then the policy pays from it, and the audit log names who opened the page', async () => {
    const { h, policy, base } = await world()
    const p = await json(await h.post(`${base}/key`, { limit: '30', periodDays: 7, expiresAt: inDays(h, 30) }, PASSKEY))
    expect(p).toMatchObject({
      ok: true,
      treasury: PASSKEY,
      authorization: {
        expiry: inDays(h, 30),
        limits: [{ token: TOKEN, limit: '30000000', period: WEEK }],
        scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }],
      },
    })
    // Not signed yet: nothing to confirm.
    expect(await json(await h.post(`${base}/key/confirm`, { keyAddress: p.keyAddress }, PASSKEY))).toMatchObject({ ok: false, error: { code: 'key_not_authorized_on_chain' } })
    await signOnChain(h, p)
    expect(await json(await h.post(`${base}/key/confirm`, { keyAddress: p.keyAddress }, PASSKEY))).toMatchObject({ ok: true, key: { address: p.keyAddress, status: 'active', policyId: policy.id } })
    const state = await json(await h.send(`${base}/state`, { passkey: PASSKEY }))
    expect(state).toMatchObject({ signs: 'own', key: { address: p.keyAddress, status: 'active', chain: { status: 'active', remaining: '30000000' } }, keys: [{ address: p.keyAddress }] })
    expect(await h.rolepay.policyKeys.budget({ guildId: GUILD, policyId: policy.id })).toEqual({ key: 'policy', remaining: 30_000_000n })
    const audit = await h.rolepay.audit.list({ guildId: GUILD, types: ['policy_key.authorized'] })
    expect(audit.ok && audit.value.events).toMatchObject([{ actor: TREASURER, policyId: policy.id }])
  })

  it("the state lists only this policy's keys: never the bot key, never another policy's key (the page revokes what it lists)", async () => {
    const { h, policy, base, token } = await world()
    const other = await approvedPolicy(h, { name: 'Other' })
    for (const [path, id] of [[base, policy.id], [`/setup/${token}/policies/${other.id}`, other.id]] as const) {
      const p = await json(await h.post(`${path}/key`, { limit: '5', periodDays: 7, expiresAt: inDays(h, 30) }, PASSKEY))
      await signOnChain(h, p)
      await h.post(`${path}/key/confirm`, { keyAddress: p.keyAddress }, PASSKEY)
      expect((await h.rolepay.policyKeys.status({ guildId: GUILD, policyId: id })).ok).toBe(true)
    }
    const state = await json(await h.send(`${base}/state`, { passkey: PASSKEY }))
    const bot = await h.rolepay.communities.keyStatus({ guildId: GUILD })
    const listed = state.keys.map((k: { address: string }) => k.address)
    expect(listed).toHaveLength(1)
    expect(listed).not.toContain(bot.ok ? bot.value.key.address : '')
    const otherKey = await h.rolepay.policyKeys.status({ guildId: GUILD, policyId: other.id })
    expect(listed).not.toContain(otherKey.ok ? otherKey.value.key?.address : '')
    // And the setup page's own list (the bot key's rotation) never lists a policy key.
    const setup = await json(await h.send(`/setup/${token}/state`, { passkey: PASSKEY }))
    expect(setup.keys.map((k: { address: string }) => k.address)).toEqual([bot.ok ? bot.value.key.address : ''])
  })

  it('revoking: recorded once the chain shows it; then the policy pays nothing (it never falls back to the bot key)', async () => {
    const { h, policy, base } = await world()
    const p = await json(await h.post(`${base}/key`, { limit: '30', periodDays: 7, expiresAt: inDays(h, 30) }, PASSKEY))
    await signOnChain(h, p)
    await h.post(`${base}/key/confirm`, { keyAddress: p.keyAddress }, PASSKEY)
    expect(await json(await h.post(`${base}/key/revoked`, { keyAddress: p.keyAddress }, PASSKEY))).toMatchObject({ ok: false, error: { code: 'key_not_revoked_on_chain' } })
    await h.chain.revokeKey({ root: h.chain.rootSigner(PASSKEY), accessKey: p.keyAddress })
    expect(await json(await h.post(`${base}/key/revoked`, { keyAddress: p.keyAddress }, PASSKEY))).toMatchObject({ ok: true, key: { status: 'revoked' } })
    expect(await json(await h.send(`${base}/state`, { passkey: PASSKEY }))).toMatchObject({ signs: 'retired', key: { status: 'revoked' }, keys: [] })
    expect(await h.rolepay.policyKeys.budget({ guildId: GUILD, policyId: policy.id })).toEqual({ key: 'policy', remaining: null })
    expect((await h.post(`${base}/key/revoked`, {}, PASSKEY)).status).toBe(400)
  })

  it('an archived policy can still have its key revoked here, but not get a new one', async () => {
    const { h, policy, base } = await world()
    await h.rolepay.policies.archive({ guildId: GUILD, actor: TREASURER, actorRoleIds: [ROLE], policyId: policy.id })
    expect((await h.send(base)).status).toBe(200)
    expect(await json(await h.post(`${base}/key`, { limit: '30', periodDays: 7, expiresAt: inDays(h, 30) }, PASSKEY))).toMatchObject({ ok: false, error: { code: 'policy_archived' } })
  })
})
