import { describe, expect, it } from 'vitest'
import { DEV_TREASURY, FEE_TOKEN, GUILD, OTHER_PASSKEY, PASSKEY, ROLE, TOKEN, pageConfig, registeredCommunity, setupLink, webHarness } from '../../test/harness.js'

type H = ReturnType<typeof webHarness>
type Json = any
const json = async (res: Response): Promise<Json> => res.json()
/** The expiry the page computes from "expires after N days" (it signs that exact number). */
const inDays = (h: H, n: number) => Math.floor(h.clock.now().getTime() / 1000) + n * 86_400

/** What the treasurer's browser does after the server hands it an authorisation: sign it on chain with the passkey. */
async function signOnChain(h: H, body: { keyAddress: string; authorization: { expiry: number; limits: { token: string; limit: string; period?: number }[]; scopes: unknown[] } }) {
  const authorization = { ...body.authorization, limits: body.authorization.limits.map((l) => ({ ...l, limit: BigInt(l.limit) })) }
  const r = await h.chain.authorizeKey({ root: h.chain.rootSigner(PASSKEY), accessKey: body.keyAddress as `0x${string}`, authorization: authorization as never })
  if (!r.ok) throw new Error(JSON.stringify(r.error))
}

describe('the treasurer setup page', () => {
  it('a valid link renders the page with the settings and the suggested key policy', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    const res = await h.send(`/setup/${token}`)
    expect(res.status).toBe(200)
    expect(await pageConfig(res)).toMatchObject({
      page: 'setup',
      token,
      guildName: 'Mods guild',
      treasury: null,
      testnet: true,
      payoutToken: TOKEN,
      tokenLabel: 'AlphaUSD',
      feeMode: 'sponsor',
      rpcUrl: 'https://rpc.moderato.tempo.xyz',
      sponsorUrl: 'https://sponsor.moderato.tempo.xyz',
      passkeyName: 'payrun treasury: Mods guild',
      defaults: { limit: '100', periodDays: 30, validityDays: 30, feeBudget: '1' },
    })
  })

  it('an unknown or expired link renders an error page', async () => {
    const h = webHarness()
    expect((await h.send('/setup/nope')).status).toBe(404)
    const token = await setupLink(h)
    h.clock.advance(1800)
    const res = await h.send(`/setup/${token}`)
    expect(res.status).toBe(410)
    expect(await res.text()).toMatch(/\/payrun setup/)
  })

  it('binds the passkey signed in on this browser as the treasury, registering the community', async () => {
    const h = webHarness()
    const token = await setupLink(h, { feeMode: 'fee_budget', feeToken: FEE_TOKEN })
    expect((await h.post(`/setup/${token}/treasury`)).status).toBe(401)
    const res = await h.post(`/setup/${token}/treasury`, { address: OTHER_PASSKEY }, PASSKEY)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, treasury: PASSKEY })
    expect(await h.payrun.communities.get(GUILD)).toMatchObject({
      ok: true,
      value: { treasuryAddress: PASSKEY, name: 'Mods guild', approverRoleId: ROLE, feeMode: 'fee_budget', feeToken: FEE_TOKEN },
    })
  })

  it('another passkey cannot take over a bound treasury', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const res = await h.post(`/setup/${token}/treasury`, {}, OTHER_PASSKEY)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'treasury_mismatch', treasuryAddress: PASSKEY } })
  })

  it('the state endpoint says who is signed in and whether that passkey controls the treasury', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    expect(await (await h.send(`/setup/${token}/state`)).json()).toMatchObject({ ok: true, community: null, key: null, session: null, isTreasurer: false })
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    expect(await (await h.send(`/setup/${token}/state`, { passkey: PASSKEY })).json()).toMatchObject({
      ok: true,
      community: { treasury: PASSKEY, feeMode: 'sponsor', payoutToken: TOKEN },
      session: { address: PASSKEY },
      isTreasurer: true,
    })
    expect(await (await h.send(`/setup/${token}/state`, { passkey: OTHER_PASSKEY })).json()).toMatchObject({ isTreasurer: false })
  })

  it('provisions a bot key with the chosen policy and returns the exact authorisation to sign (transferWithMemo only)', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const res = await h.post(`/setup/${token}/key`, { limit: '25.5', periodDays: 7, expiresAt: inDays(h, 14) }, PASSKEY)
    expect(res.status).toBe(200)
    const body = await json(res)
    const nowS = Math.floor(h.clock.now().getTime() / 1000)
    expect(body).toMatchObject({
      ok: true,
      treasury: PASSKEY,
      authorization: {
        expiry: nowS + 14 * 86_400,
        limits: [{ token: TOKEN, limit: '25500000', period: 7 * 86_400 }],
        scopes: [{ address: TOKEN, selector: 'transferWithMemo(address,uint256,bytes32)' }],
      },
    })
    expect(await h.payrun.communities.keyStatus({ guildId: GUILD })).toMatchObject({ ok: true, value: { key: { status: 'pending_authorization', address: body.keyAddress } } })
  })

  it('a period of 0 days means one limit for the whole life of the key', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const body = await json(await h.post(`/setup/${token}/key`, { limit: '10', periodDays: 0, expiresAt: inDays(h, 3) }, PASSKEY))
    expect(body.authorization.limits).toEqual([{ token: TOKEN, limit: '10000000' }])
  })

  it('in fee_budget mode the authorisation also carries the fee budget', async () => {
    const h = webHarness()
    const token = await setupLink(h, { feeMode: 'fee_budget', feeToken: FEE_TOKEN })
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const body = await json(await h.post(`/setup/${token}/key`, { limit: '10', periodDays: 30, expiresAt: inDays(h, 30), feeBudget: '2' }, PASSKEY))
    expect(body.authorization.limits).toEqual([
      { token: TOKEN, limit: '10000000', period: 2_592_000 },
      { token: FEE_TOKEN, limit: '2000000', period: 2_592_000 },
    ])
  })

  it('refuses a bad policy with a readable reason', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const res = await h.post(`/setup/${token}/key`, { limit: 'lots', periodDays: 7, expiresAt: inDays(h, 14) }, PASSKEY)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect((await h.post(`/setup/${token}/key`, { limit: '1', periodDays: 7, expiresAt: inDays(h, 0) }, PASSKEY)).status).toBe(400)
    expect((await h.post(`/setup/${token}/key`, { limit: '1', periodDays: 7, expiresAt: inDays(h, 400) }, PASSKEY)).status).toBe(400)
    expect((await h.post(`/setup/${token}/key`, { limit: '1', periodDays: 7, validityDays: 14 }, PASSKEY)).status).toBe(400)
  })

  it('only the treasury passkey can manage the key', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    expect(await (await h.post(`/setup/${token}/key`, { limit: '1', periodDays: 1, expiresAt: inDays(h, 1) }, PASSKEY)).json()).toEqual({
      ok: false,
      error: { code: 'treasury_not_bound' },
    })
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    for (const path of ['key', 'key/confirm', 'key/revoked']) {
      const anon = await h.post(`/setup/${token}/${path}`, { limit: '1', periodDays: 1, expiresAt: inDays(h, 1) })
      expect(anon.status).toBe(401)
      const other = await h.post(`/setup/${token}/${path}`, { limit: '1', periodDays: 1, expiresAt: inDays(h, 1) }, OTHER_PASSKEY)
      expect(other.status).toBe(403)
      expect(await other.json()).toEqual({ ok: false, error: { code: 'not_the_treasury', treasuryAddress: PASSKEY } })
    }
    expect((await h.payrun.communities.keyStatus({ guildId: GUILD })).ok).toBe(false)
  })

  it('a dev-registered community whose treasury is not this passkey says so', async () => {
    const h = webHarness()
    await registeredCommunity(h, DEV_TREASURY)
    const token = await setupLink(h)
    const res = await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'treasury_mismatch', treasuryAddress: DEV_TREASURY } })
  })

  it('confirms the key once the passkey has authorised it on chain, then confirms a revoke the same way', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const provisioned = await json(await h.post(`/setup/${token}/key`, { limit: '50', periodDays: 30, expiresAt: inDays(h, 30) }, PASSKEY))

    const keyAddress = provisioned.keyAddress
    const early = await h.post(`/setup/${token}/key/confirm`, { keyAddress }, PASSKEY)
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ ok: false, error: { code: 'key_not_authorized_on_chain' } })

    await signOnChain(h, provisioned)
    const confirmed = await h.post(`/setup/${token}/key/confirm`, { keyAddress }, PASSKEY)
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toMatchObject({ ok: true, key: { address: provisioned.keyAddress, status: 'active' } })
    expect(await (await h.send(`/setup/${token}/state`, { passkey: PASSKEY })).json()).toMatchObject({
      key: { address: provisioned.keyAddress, status: 'active', chain: { status: 'active', remaining: '50000000' }, policy: { limit: '50000000' } },
    })

    expect((await h.post(`/setup/${token}/key/revoked`, { keyAddress }, PASSKEY)).status).toBe(409)
    await h.chain.revokeKey({ root: h.chain.rootSigner(PASSKEY), accessKey: provisioned.keyAddress })
    const revoked = await h.post(`/setup/${token}/key/revoked`, { keyAddress }, PASSKEY)
    expect(await revoked.json()).toMatchObject({ ok: true, key: { status: 'revoked' } })
    expect(await h.payrun.communities.keyStatus({ guildId: GUILD })).toMatchObject({ ok: true, value: { key: { status: 'revoked' } } })
  })

  it('confirm and revoked name the key they are about; without it they do nothing', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    for (const path of ['key/confirm', 'key/revoked']) {
      const res = await h.post(`/setup/${token}/${path}`, {}, PASSKEY)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    }
  })

  it('replacing the key: the state lists every live key; once the old one is revoked in the same transaction it leaves the list', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const first = await json(await h.post(`/setup/${token}/key`, { limit: '50', periodDays: 30, expiresAt: inDays(h, 30) }, PASSKEY))
    await signOnChain(h, first)
    await h.post(`/setup/${token}/key/confirm`, { keyAddress: first.keyAddress }, PASSKEY)
    h.clock.advance(60)

    const second = await json(await h.post(`/setup/${token}/key`, { limit: '10', periodDays: 30, expiresAt: inDays(h, 30) }, PASSKEY))
    const during = await json(await h.send(`/setup/${token}/state`, { passkey: PASSKEY }))
    // A pending key never hides the active one (M5): the state still describes it, and lists both.
    expect(during.key).toMatchObject({ address: first.keyAddress, status: 'active' })
    expect(during.keys).toMatchObject([
      { address: second.keyAddress, status: 'pending_authorization', chain: { status: 'not_authorized' } },
      { address: first.keyAddress, status: 'active', chain: { status: 'active' } },
    ])

    await h.chain.revokeKey({ root: h.chain.rootSigner(PASSKEY), accessKey: first.keyAddress })
    await signOnChain(h, second)
    expect((await h.post(`/setup/${token}/key/confirm`, { keyAddress: second.keyAddress }, PASSKEY)).status).toBe(200)
    const after = await json(await h.send(`/setup/${token}/state`, { passkey: PASSKEY }))
    expect(after.key).toMatchObject({ address: second.keyAddress, status: 'active' })
    expect(after.keys.map((k: { address: string }) => k.address)).toEqual([second.keyAddress])
  })

  it('a replaced key still live on chain stays listed, and the page can revoke it by address', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    const first = await json(await h.post(`/setup/${token}/key`, { limit: '50', periodDays: 30, expiresAt: inDays(h, 30) }, PASSKEY))
    await signOnChain(h, first)
    await h.post(`/setup/${token}/key/confirm`, { keyAddress: first.keyAddress }, PASSKEY)
    h.clock.advance(60)
    const second = await json(await h.post(`/setup/${token}/key`, { limit: '10', periodDays: 30, expiresAt: inDays(h, 30) }, PASSKEY))
    await signOnChain(h, second)
    await h.post(`/setup/${token}/key/confirm`, { keyAddress: second.keyAddress }, PASSKEY)

    const state = await json(await h.send(`/setup/${token}/state`, { passkey: PASSKEY }))
    expect(state.keys).toMatchObject([
      { address: second.keyAddress, status: 'active', chain: { status: 'active' } },
      { address: first.keyAddress, status: 'superseded', chain: { status: 'active' } },
    ])
    await h.chain.revokeKey({ root: h.chain.rootSigner(PASSKEY), accessKey: first.keyAddress })
    expect(await json(await h.post(`/setup/${token}/key/revoked`, { keyAddress: first.keyAddress }, PASSKEY))).toMatchObject({ ok: true, key: { status: 'revoked' } })
    expect((await json(await h.send(`/setup/${token}/state`, { passkey: PASSKEY }))).keys.map((k: { address: string }) => k.address)).toEqual([second.keyAddress])
  })

  it('a registration session minted after the treasury existed is no proof of its passkey: sign in first (M4)', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    const now = Math.floor(h.clock.now().getTime() / 1000)
    // The passkey that creates the treasury: its registration session predates the community.
    const creator = { address: PASSKEY, proof: 'registration' as const, issuedAt: now - 1 }
    expect((await h.post(`/setup/${token}/treasury`, {}, creator)).status).toBe(200)
    h.clock.advance(120)
    // Anyone can "register" the treasury's public key (it is public on chain) with attestation none.
    const forged = { address: PASSKEY, proof: 'registration' as const, issuedAt: now + 60 }
    const policy = { limit: '1', periodDays: 1, expiresAt: inDays(h, 1) }
    for (const path of ['key', 'key/confirm', 'key/revoked']) {
      const res = await h.post(`/setup/${token}/${path}`, { ...policy, keyAddress: PASSKEY }, forged)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ ok: false, error: { code: 'sign_in_required' } })
    }
    expect(await json(await h.send(`/setup/${token}/state`, { passkey: forged }))).toMatchObject({ isTreasurer: false, signInRequired: true })
    expect((await h.payrun.communities.keyStatus({ guildId: GUILD })).ok).toBe(false)

    // The creator's own registration session goes on (create, then authorise: one prompt each),
    // and a session from a passkey login (a signature over a server challenge) always does.
    expect((await h.post(`/setup/${token}/key`, policy, creator)).status).toBe(200)
    expect((await h.post(`/setup/${token}/key`, policy, { address: PASSKEY, proof: 'login', issuedAt: now + 60 })).status).toBe(200)
    expect(await json(await h.send(`/setup/${token}/state`, { passkey: creator }))).toMatchObject({ isTreasurer: true, signInRequired: false })
  })

  it('the setup link stops working when it expires, even for the treasury passkey', async () => {
    const h = webHarness()
    const token = await setupLink(h)
    await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
    h.clock.advance(1800)
    const res = await h.post(`/setup/${token}/key`, { limit: '1', periodDays: 1, expiresAt: inDays(h, 1) }, PASSKEY)
    expect(res.status).toBe(410)
  })
})
