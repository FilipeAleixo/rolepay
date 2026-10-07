import { type Clock, type KeyStatusView, type Rolepay, formatAmount } from '@rolepay/core'
import { type Context, Hono } from 'hono'
import type { WebConfig } from '../config.js'
import { failure, jsonResponse, linkStatus } from '../json.js'
import type { PasskeySessions } from '../ports.js'
import { linkErrorPage } from '../views/page.js'
import { setupPage } from '../views/setup.js'
import { DAY, keyPolicyRequest, keyRef, provesPasskey, tokenLabel as label, treasurerOf } from './treasurer.js'

export type SetupRoutesDeps = { rolepay: Rolepay; sessions: PasskeySessions; config: WebConfig; clock: Clock; testnet: boolean }

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
        defaults: {
          limit: formatAmount(d.limit),
          periodDays: Math.round(d.periodSeconds / DAY),
          validityDays: Math.round(d.validitySeconds / DAY),
          feeBudget: formatAmount(d.feeBudget),
        },
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
    return jsonResponse(200, {
      ok: true,
      community: community
        ? { treasury: community.treasuryAddress, payoutToken: community.payoutToken, feeMode: community.feeMode, feeToken: community.feeToken, name: community.name }
        : null,
      // The key that matters (the active one, never hidden by a pending one), and every key not
      // yet revoked: the page offers to revoke each one that is live on chain.
      key: status?.ok ? keyJson(status.value) : null,
      keys: keys?.ok ? keys.value.map(keyJson) : [],
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

  return app
}
