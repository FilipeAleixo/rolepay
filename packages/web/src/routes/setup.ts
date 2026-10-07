import { type Clock, type KeyStatusView, type Rolepay, formatAmount, keyLacksSwapScope, swapTokensFor } from '@rolepay/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { WebConfig } from '../config.js'
import { failure, jsonResponse, linkStatus } from '../json.js'
import type { PasskeySessions } from '../ports.js'
import { linkErrorPage } from '../views/page.js'
import { setupPage } from '../views/setup.js'
import { DAY, keyPolicyRequest, keyRef, provesPasskey, tokenLabel as label, treasurerOf } from './treasurer.js'

export type SetupRoutesDeps = { rolepay: Rolepay; sessions: PasskeySessions; config: WebConfig; clock: Clock; testnet: boolean }

/** Pay each person in the stablecoin they prefer: on or off. */
const PreferredTokensBody = z.object({ enabled: z.boolean() })

/** Deposit addresses: the salt this browser mined, then the registration it sent (core re-validates both). */
const SaltBody = z.object({ salt: z.string().max(80) })
const RegisteredBody = z.object({ masterId: z.string().max(20), txHash: z.string().max(80).nullable().default(null) })
const DEPOSIT_STATUS: Record<string, number> = { invalid_input: 400, invalid_salt: 400, community_not_found: 404 }

const keyJson = (s: KeyStatusView) => ({ address: s.key.address, status: s.key.status, policy: s.key.policy, chain: s.state })

/**
 * /setup/:token: the treasurer page and its JSON endpoints. The link (from /rolepay setup)
 * names the guild; binding a treasury takes the passkey session; everything after that
 * takes the session of the passkey that IS the treasury. The bot key authorisation and
 * the revoke are signed in the browser; the server only reads the result from the chain.
 * Replacing a key revokes every live old key in the same transaction (one passkey prompt).
 */
export function setupRoutes(deps: SetupRoutesDeps): Hono {
  const { rolepay, config } = deps
  const app = new Hono()

  const treasurer = (c: Context) => treasurerOf(c, deps)

  app.get('/setup/:token', async (c) => {
    const token = c.req.param('token')
    const link = await rolepay.communities.describeSetupLink({ token })
    if (!link.ok) return c.html(linkErrorPage(link.error.code, '/rolepay setup', deps.testnet), linkStatus(link.error.code) as 404)
    const { community, settings } = link.value
    const feeMode = community?.feeMode ?? settings.feeMode
    const feeToken = community?.feeToken ?? settings.feeToken
    const payoutToken = community?.payoutToken ?? settings.payoutToken
    const guildName = community?.name ?? settings.name ?? 'your Discord server'
    const d = config.botKeyDefaults
    // The stablecoins the key may swap into when the treasurer turns preferred stablecoins on: the
    // page adds them to the authorisation it builds itself, never taking them from the server's answer.
    const swapTokens = swapTokensFor({ network: config.network, payoutToken, feeToken: feeMode === 'fee_budget' ? feeToken : null }).map((address) => ({
      address,
      label: label(address) as string,
    }))
    return c.html(
      setupPage({
        page: 'setup',
        token,
        guildName,
        network: config.network,
        testnet: deps.testnet,
        rpcUrl: config.rpcUrl,
        sponsorUrl: config.sponsorUrl,
        explorerUrl: config.explorerUrl,
        treasury: community?.treasuryAddress ?? null,
        payoutToken,
        tokenLabel: label(payoutToken) as string,
        feeMode,
        feeToken,
        feeTokenLabel: label(feeToken),
        passkeyName: `Rolepay treasury: ${guildName}`,
        deposits: rolepay.funding.isConfigured(),
        defaults: {
          limit: formatAmount(d.limit),
          periodDays: Math.round(d.periodSeconds / DAY),
          validityDays: Math.round(d.validitySeconds / DAY),
          feeBudget: formatAmount(d.feeBudget),
        },
        swapTokens,
      }),
    )
  })

  app.get('/setup/:token/state', async (c) => {
    const link = await rolepay.communities.describeSetupLink({ token: c.req.param('token') })
    if (!link.ok) return failure(linkStatus(link.error.code), link.error)
    const community = link.value.community
    const session = await deps.sessions.current(c.req.raw)
    const status = community ? await rolepay.communities.keyStatus({ guildId: community.id }) : null
    const keys = community ? await rolepay.communities.listKeys({ guildId: community.id }) : null
    const funding = community ? await rolepay.funding.status({ guildId: community.id }) : null
    return jsonResponse(200, {
      ok: true,
      community: community
        ? {
            treasury: community.treasuryAddress,
            payoutToken: community.payoutToken,
            feeMode: community.feeMode,
            feeToken: community.feeToken,
            name: community.name,
            preferredTokens: community.preferredTokens,
          }
        : null,
      // The key that matters (the active one, never hidden by a pending one), and every key not
      // yet revoked: the page offers to revoke each one that is live on chain.
      key: status?.ok ? keyJson(status.value) : null,
      keys: keys?.ok ? keys.value.map(keyJson) : [],
      // Preferred stablecoins are on but the active key cannot swap: runs with swaps wait for a new key.
      keyNeedsSwapScope: Boolean(community && keyLacksSwapScope(community, status?.ok && status.value.key.status === 'active' ? status.value.key.policy : null)),
      // Deposit addresses (virtual addresses): whether this server offers them, and the treasury's master once registered.
      deposits:
        community && funding?.ok
          ? {
              available: funding.value.configured,
              masterId: funding.value.master?.masterId ?? null,
              txHash: funding.value.master?.txHash ?? null,
              sources: funding.value.sources.length,
              dashboard: `/dashboard/${community.id}/funding`,
            }
          : null,
      session: session ? { address: session.address } : null,
      isTreasurer: Boolean(community && session && session.address === community.treasuryAddress && provesPasskey(session, community)),
      signInRequired: Boolean(community && session && session.address === community.treasuryAddress && !provesPasskey(session, community)),
    })
  })

  app.post('/setup/:token/treasury', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const bound = await rolepay.communities.bindTreasury({ token: c.req.param('token'), treasuryAddress: session.address })
    if (!bound.ok) {
      const code = bound.error.code
      return failure(code === 'treasury_mismatch' ? 409 : code === 'invalid_input' ? 400 : linkStatus(code), bound.error)
    }
    return jsonResponse(200, { ok: true, treasury: bound.value.treasuryAddress })
  })

  app.post('/setup/:token/key', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const k = await keyPolicyRequest(c, t.value.community, deps.clock)
    if (!k.ok) return k.response
    const provisioned = await rolepay.communities.provisionBotKey({ guildId: t.value.community.id, ...k.value })
    if (!provisioned.ok) return failure(400, provisioned.error)
    return jsonResponse(200, { ok: true, keyAddress: provisioned.value.keyAddress, treasury: provisioned.value.account, authorization: provisioned.value.authorization })
  })

  /**
   * Pay each person in the stablecoin they prefer, on or off: the treasury passkey only. Turning it on
   * changes nothing on chain: the next key the page authorises includes the swap scope.
   */
  app.post('/setup/:token/preferred-tokens', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const body = PreferredTokensBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input', issues: ['enabled: true or false'] })
    const set = await rolepay.communities.setPreferredTokens({ guildId: t.value.community.id, enabled: body.data.enabled })
    if (!set.ok) return failure(404, set.error)
    return jsonResponse(200, { ok: true, preferredTokens: set.value.community.preferredTokens, keyNeedsSwapScope: set.value.keyNeedsSwapScope })
  })

  app.post('/setup/:token/key/confirm', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const keyAddress = await keyRef(c)
    if (!keyAddress) return failure(400, { code: 'invalid_input', issues: ['keyAddress: the key this page authorised'] })
    const confirmed = await rolepay.communities.confirmBotKey({ guildId: t.value.community.id, keyAddress })
    if (!confirmed.ok) return failure(409, confirmed.error)
    return jsonResponse(200, { ok: true, key: confirmed.value })
  })

  app.post('/setup/:token/key/revoked', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const keyAddress = await keyRef(c)
    if (!keyAddress) return failure(400, { code: 'invalid_input', issues: ['keyAddress: the key this page revoked'] })
    const revoked = await rolepay.communities.confirmRevocation({ guildId: t.value.community.id, keyAddress })
    if (!revoked.ok) return failure(409, revoked.error)
    return jsonResponse(200, { ok: true, key: revoked.value })
  })

  /**
   * Deposit addresses, step 1: the page mined a salt for the treasury (the 32-bit proof of work
   * TIP-1022 asks for). Core checks it and that its masterId is free, and answers with its copy of
   * the registration call; the page builds its own and signs nothing if they differ.
   */
  app.post('/setup/:token/deposits/plan', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const body = SaltBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input', issues: ['salt: the 32-byte salt this page mined'] })
    const plan = await rolepay.funding.planMaster({ guildId: t.value.community.id, salt: body.data.salt })
    if (!plan.ok) return failure(DEPOSIT_STATUS[plan.error.code] ?? 409, plan.error)
    return jsonResponse(200, { ok: true, ...plan.value })
  })

  /** Step 2: the passkey sent the registration; core reads it from the chain (never this page's word) and records it. */
  app.post('/setup/:token/deposits/confirm', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const body = RegisteredBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input', issues: ['masterId and txHash: the registration this page sent'] })
    const confirmed = await rolepay.funding.confirmMaster({ guildId: t.value.community.id, ...body.data })
    if (!confirmed.ok) return failure(DEPOSIT_STATUS[confirmed.error.code] ?? 409, confirmed.error)
    return jsonResponse(200, { ok: true, masterId: confirmed.value.masterId, txHash: confirmed.value.txHash })
  })

  return app
}
