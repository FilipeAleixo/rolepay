// Paying each person in the stablecoin they prefer, on the pages: the treasurer's switch on the
// setup page (and the swap scope it adds to the key the page signs), and the payee's choice on the
// claim and account pages, always for the address of the verified passkey session.
import { TESTNET_TOKENS } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { ALICE, GUILD, OTHER_PASSKEY, PASSKEY, claimLink, pageConfig, registeredCommunity, setupLink, webHarness } from '../../test/harness.js'
import { type WireAuthorization, authorizationMismatch, buildAuthorization } from '../client/keychain.js'

const { alpha_usd: ALPHA, beta_usd: BETA, theta_usd: THETA, path_usd: PATH } = TESTNET_TOKENS
type H = ReturnType<typeof webHarness>
const inDays = (h: H, n: number) => Math.floor(h.clock.now().getTime() / 1000) + n * 86_400
const DEX = '0xdec0000000000000000000000000000000000000'

async function boundSetup(h: H) {
  const token = await setupLink(h)
  await h.post(`/setup/${token}/treasury`, {}, PASSKEY)
  return token
}

describe('the setup page: pay each person in the stablecoin they prefer (off by default)', () => {
  it('the page knows the tokens the key would swap into, and the state says the switch is off', async () => {
    const h = webHarness()
    const token = await boundSetup(h)
    expect(await pageConfig(await h.send(`/setup/${token}`))).toMatchObject({ swapTokens: [{ address: BETA, label: 'BetaUSD' }, { address: THETA, label: 'ThetaUSD' }] })
    expect(await (await h.send(`/setup/${token}/state`, { passkey: PASSKEY })).json()).toMatchObject({ community: { preferredTokens: false }, keyNeedsSwapScope: false })
    expect(await (await h.send(`/setup/${token}`)).text()).toContain('id="preferred-tokens"')
  })

  it('only the treasury passkey turns it on; the state then says the key needs the swap scope', async () => {
    const h = webHarness()
    const token = await boundSetup(h)
    expect((await h.post(`/setup/${token}/preferred-tokens`, { enabled: true })).status).toBe(401)
    expect((await h.post(`/setup/${token}/preferred-tokens`, { enabled: true }, OTHER_PASSKEY)).status).toBe(403)
    expect((await h.post(`/setup/${token}/preferred-tokens`, { enabled: 'yes' }, PASSKEY)).status).toBe(400)
    const on = await h.post(`/setup/${token}/preferred-tokens`, { enabled: true }, PASSKEY)
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ ok: true, preferredTokens: true, keyNeedsSwapScope: true })
    expect(await (await h.send(`/setup/${token}/state`, { passkey: PASSKEY })).json()).toMatchObject({ community: { preferredTokens: true }, keyNeedsSwapScope: true })
    expect(await h.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { preferredTokens: true } })
  })

  it('with it on, the key the server provisions carries exactly the swap scope, and the page builds the same authorisation from the form (nothing to refuse)', async () => {
    const h = webHarness()
    const token = await boundSetup(h)
    await h.post(`/setup/${token}/preferred-tokens`, { enabled: true }, PASSKEY)
    const expiresAt = inDays(h, 14)
    const body = (await (await h.post(`/setup/${token}/key`, { limit: '25', periodDays: 7, expiresAt }, PASSKEY)).json()) as { authorization: WireAuthorization }
    expect(body.authorization).toEqual({
      expiry: expiresAt,
      limits: [
        { token: ALPHA, limit: '25000000', period: 604_800 },
        { token: BETA, limit: '25000000', period: 604_800 },
        { token: THETA, limit: '25000000', period: 604_800 },
      ],
      scopes: [
        { address: ALPHA, selector: 'transferWithMemo(address,uint256,bytes32)' },
        { address: DEX, selector: 'swapExactAmountOut(address,address,uint128,uint128)' },
        { address: BETA, selector: 'transferWithMemo(address,uint256,bytes32)' },
        { address: THETA, selector: 'transferWithMemo(address,uint256,bytes32)' },
      ],
    })
    const mine = buildAuthorization({ limit: '25', periodDays: '7', validityDays: '14' }, { payoutToken: ALPHA, feeToken: null, swapTokens: [BETA, THETA] }, inDays(h, 0))
    if (!mine.ok) throw new Error(mine.error)
    expect(authorizationMismatch(mine.value, body.authorization)).toBeNull()
    // The page with the switch off would build the old authorisation, and refuse this one.
    const off = buildAuthorization({ limit: '25', periodDays: '7', validityDays: '14' }, { payoutToken: ALPHA, feeToken: null, swapTokens: null }, inDays(h, 0))
    expect(off.ok && authorizationMismatch(off.value, body.authorization)).toBe('different spending limits')
  })

  it('with it off, the key is authorised exactly as before', async () => {
    const h = webHarness()
    const token = await boundSetup(h)
    const body = (await (await h.post(`/setup/${token}/key`, { limit: '25', periodDays: 7, expiresAt: inDays(h, 14) }, PASSKEY)).json()) as { authorization: WireAuthorization }
    expect(body.authorization.scopes).toEqual([{ address: ALPHA, selector: 'transferWithMemo(address,uint256,bytes32)' }])
    expect(body.authorization.limits).toEqual([{ token: ALPHA, limit: '25000000', period: 604_800 }])
  })
})

describe('the claim page and the account page: the payee chooses, for their own passkey address', () => {
  it('the claim page carries the community, its payout token and the choices', async () => {
    const h = webHarness()
    await registeredCommunity(h, PASSKEY, { approverRoleId: null })
    const config = await pageConfig(await h.send(`/claim/${await claimLink(h)}`))
    expect(config).toMatchObject({
      guildId: GUILD,
      payoutLabel: 'AlphaUSD',
      preferredTokens: false,
      choices: [
        { address: ALPHA, label: 'AlphaUSD' },
        { address: BETA, label: 'BetaUSD' },
        { address: THETA, label: 'ThetaUSD' },
      ],
    })
  })

  it('after claiming, the payee sets their stablecoin with their passkey session; nobody else can, and only allowed tokens', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    await h.post(`/claim/${await claimLink(h)}`, {}, PASSKEY)
    expect((await h.post('/account/preference', { guildId: GUILD, token: BETA })).status).toBe(401)
    const other = await h.post('/account/preference', { guildId: GUILD, token: BETA }, OTHER_PASSKEY)
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual({ ok: false, error: { code: 'payee_not_found' } })
    const bad = await h.post('/account/preference', { guildId: GUILD, token: PATH }, PASSKEY)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ ok: false, error: { code: 'token_not_allowed' } })
    const res = await h.post('/account/preference', { guildId: GUILD, token: BETA, address: OTHER_PASSKEY }, PASSKEY)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, preferredToken: BETA })
    expect(await h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: PASSKEY, preferredToken: BETA } })
    expect(await (await h.post('/account/preference', { guildId: GUILD, token: null }, PASSKEY)).json()).toEqual({ ok: true, preferredToken: null })
  })

  it('a cross-site POST changes nothing (CSRF)', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    await h.post(`/claim/${await claimLink(h)}`, {}, PASSKEY)
    const res = await h.send('/account/preference', { method: 'POST', body: JSON.stringify({ guildId: GUILD, token: BETA }), passkey: PASSKEY, headers: { origin: 'https://evil.example' } })
    expect(res.status).toBe(403)
    expect(await h.rolepay.payees.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { preferredToken: null } })
  })

  it('the account page lists where the signed-in passkey is paid, with the choices and the current one', async () => {
    const h = webHarness()
    await registeredCommunity(h)
    await h.rolepay.communities.setPreferredTokens({ guildId: GUILD, enabled: true })
    await h.post(`/claim/${await claimLink(h)}`, {}, PASSKEY)
    await h.post('/account/preference', { guildId: GUILD, token: THETA }, PASSKEY)
    expect((await h.send('/account/payouts')).status).toBe(401)
    expect(await (await h.send('/account/payouts', { passkey: OTHER_PASSKEY })).json()).toEqual({ ok: true, payouts: [] })
    expect(await (await h.send('/account/payouts', { passkey: PASSKEY })).json()).toEqual({
      ok: true,
      payouts: [
        {
          guildId: GUILD,
          communityName: 'Mods guild',
          payoutToken: { address: ALPHA, label: 'AlphaUSD' },
          preferredToken: THETA,
          enabled: true,
          choices: [
            { address: ALPHA, label: 'AlphaUSD' },
            { address: BETA, label: 'BetaUSD' },
            { address: THETA, label: 'ThetaUSD' },
          ],
        },
      ],
    })
    expect(await (await h.send('/account')).text()).toContain('id="payouts"')
  })
})
