import { type Clock, type Community, type Payrun, TOKEN_SYMBOLS, formatAmount, parseAmount } from '@payrun/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { WebConfig } from '../config.js'
import { failure, jsonResponse, linkStatus } from '../json.js'
import type { PasskeySession, PasskeySessions } from '../ports.js'
import { linkErrorPage } from '../views/page.js'
import { setupPage } from '../views/setup.js'

export type SetupRoutesDeps = { payrun: Payrun; sessions: PasskeySessions; config: WebConfig; clock: Clock; testnet: boolean }

const DAY = 86_400
const label = (token: string | null) => (token ? (TOKEN_SYMBOLS[token.toLowerCase()] ?? token) : null)

const KeyPolicyBody = z.object({
  limit: z.string().min(1),
  /** 0 = one limit for the key's whole life. */
  periodDays: z.coerce.number().int().min(0).max(366),
  validityDays: z.coerce.number().int().min(1).max(366),
  feeBudget: z.string().min(1).optional(),
})

type Treasurer = { community: Community; session: PasskeySession }

/**
 * /setup/:token: the treasurer page and its JSON endpoints. The link (from /payrun setup)
 * names the guild; binding a treasury takes the passkey session; everything after that
 * takes the session of the passkey that IS the treasury. The bot key authorisation and
 * the revoke are signed in the browser; the server only reads the result from the chain.
 */
export function setupRoutes(deps: SetupRoutesDeps): Hono {
  const { payrun, config } = deps
  const app = new Hono()

  /** The link, the community it set up, and the passkey session that controls it, or the response to send. */
  async function treasurer(c: Context): Promise<{ ok: true; value: Treasurer } | { ok: false; response: Response }> {
    const link = await payrun.communities.describeSetupLink({ token: c.req.param('token') as string })
    if (!link.ok) return { ok: false, response: failure(linkStatus(link.error.code), link.error) }
    const community = link.value.community
    if (!community) return { ok: false, response: failure(409, { code: 'treasury_not_bound' }) }
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return { ok: false, response: failure(401, { code: 'no_passkey_session' }) }
    if (session.address !== community.treasuryAddress) {
      return { ok: false, response: failure(403, { code: 'not_the_treasury', treasuryAddress: community.treasuryAddress }) }
    }
    return { ok: true, value: { community, session } }
  }

  app.get('/setup/:token', async (c) => {
    const token = c.req.param('token')
    const link = await payrun.communities.describeSetupLink({ token })
    if (!link.ok) return c.html(linkErrorPage(link.error.code, '/payrun setup', deps.testnet), linkStatus(link.error.code) as 404)
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
        passkeyName: `payrun treasury: ${guildName}`,
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
    const link = await payrun.communities.describeSetupLink({ token: c.req.param('token') })
    if (!link.ok) return failure(linkStatus(link.error.code), link.error)
    const community = link.value.community
    const session = await deps.sessions.current(c.req.raw)
    const status = community ? await payrun.communities.keyStatus({ guildId: community.id }) : null
    return jsonResponse(200, {
      ok: true,
      community: community
        ? { treasury: community.treasuryAddress, payoutToken: community.payoutToken, feeMode: community.feeMode, feeToken: community.feeToken, name: community.name }
        : null,
      key: status?.ok ? { address: status.value.key.address, status: status.value.key.status, policy: status.value.key.policy, chain: status.value.state } : null,
      session: session ? { address: session.address } : null,
      isTreasurer: Boolean(community && session && session.address === community.treasuryAddress),
    })
  })

  app.post('/setup/:token/treasury', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const bound = await payrun.communities.bindTreasury({ token: c.req.param('token'), treasuryAddress: session.address })
    if (!bound.ok) {
      const code = bound.error.code
      return failure(code === 'treasury_mismatch' ? 409 : code === 'invalid_input' ? 400 : linkStatus(code), bound.error)
    }
    return jsonResponse(200, { ok: true, treasury: bound.value.treasuryAddress })
  })

  app.post('/setup/:token/key', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const body = KeyPolicyBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input', issues: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    const limit = parseAmount(body.data.limit)
    if (!limit.ok) return failure(400, { code: 'invalid_input', issues: [`limit: "${body.data.limit}" is not an amount`] })
    let feeBudget: bigint | null = null
    if (t.value.community.feeMode === 'fee_budget') {
      const parsed = parseAmount(body.data.feeBudget ?? '')
      if (!parsed.ok) return failure(400, { code: 'invalid_input', issues: ['feeBudget: needed in fee budget mode, for example 1'] })
      feeBudget = parsed.value
    }
    const now = Math.floor(deps.clock.now().getTime() / 1000)
    const provisioned = await payrun.communities.provisionBotKey({
      guildId: t.value.community.id,
      limit: limit.value,
      periodSeconds: body.data.periodDays === 0 ? null : body.data.periodDays * DAY,
      expiresAt: now + body.data.validityDays * DAY,
      feeBudget,
    })
    if (!provisioned.ok) return failure(400, provisioned.error)
    return jsonResponse(200, { ok: true, keyAddress: provisioned.value.keyAddress, treasury: provisioned.value.account, authorization: provisioned.value.authorization })
  })

  app.post('/setup/:token/key/confirm', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const confirmed = await payrun.communities.confirmBotKey({ guildId: t.value.community.id })
    if (!confirmed.ok) return failure(409, confirmed.error)
    return jsonResponse(200, { ok: true, key: confirmed.value })
  })

  app.post('/setup/:token/key/revoked', async (c) => {
    const t = await treasurer(c)
    if (!t.ok) return t.response
    const revoked = await payrun.communities.confirmRevocation({ guildId: t.value.community.id })
    if (!revoked.ok) return failure(409, revoked.error)
    return jsonResponse(200, { ok: true, key: revoked.value })
  })

  return app
}
