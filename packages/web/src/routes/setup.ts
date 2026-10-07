import { AddressSchema, type Clock, type Community, type KeyStatusView, type Rolepay, TOKEN_SYMBOLS, formatAmount, parseAmount } from '@rolepay/core'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { WebConfig } from '../config.js'
import { failure, jsonResponse, linkStatus } from '../json.js'
import type { PasskeySession, PasskeySessions } from '../ports.js'
import { linkErrorPage } from '../views/page.js'
import { setupPage } from '../views/setup.js'

export type SetupRoutesDeps = { rolepay: Rolepay; sessions: PasskeySessions; config: WebConfig; clock: Clock; testnet: boolean }

const DAY = 86_400
const label = (token: string | null) => (token ? (TOKEN_SYMBOLS[token.toLowerCase()] ?? token) : null)

const MAX_DAYS = 366
const KeyPolicyBody = z.object({
  limit: z.string().min(1),
  /** 0 = one limit for the key's whole life. */
  periodDays: z.coerce.number().int().min(0).max(MAX_DAYS),
  /**
   * Unix seconds, computed by the page from "expires after N days". The page signs exactly this
   * number (it builds the authorisation itself), so the server takes it rather than choosing one.
   */
  expiresAt: z.number().int().positive(),
  feeBudget: z.string().min(1).optional(),
})

/** confirm and revoked name the key they are about: the one this browser just signed for. */
const KeyRefBody = z.object({ keyAddress: AddressSchema })

type Treasurer = { community: Community; session: PasskeySession }

/**
 * Whether a session proves the treasury's passkey (M4). A login session does: it signed a server
 * challenge. A registration session proves nothing (anyone can register a public key, and the
 * treasury's is public on chain once it signs), except the one that created the treasury: it was
 * issued before the community existed, when nobody else could have known that public key. So the
 * treasurer who just created the treasury authorises the key without a second prompt, and anyone
 * replaying the public key later must sign in, which they cannot.
 */
const provesPasskey = (s: PasskeySession, c: Community) => s.proof === 'login' || s.issuedAt * 1000 <= c.createdAt.getTime()

const keyJson = (s: KeyStatusView) => ({ address: s.key.address, status: s.key.status, policy: s.key.policy, chain: s.state })

/**
 * /setup/:token: the treasurer page and its JSON endpoints. The link (from /payrun setup)
 * names the guild; binding a treasury takes the passkey session; everything after that
 * takes the session of the passkey that IS the treasury. The bot key authorisation and
 * the revoke are signed in the browser; the server only reads the result from the chain.
 * Replacing a key revokes every live old key in the same transaction (one passkey prompt).
 */
export function setupRoutes(deps: SetupRoutesDeps): Hono {
  const { rolepay, config } = deps
  const app = new Hono()

  /** The link, the community it set up, and the passkey session that controls it, or the response to send. */
  async function treasurer(c: Context): Promise<{ ok: true; value: Treasurer } | { ok: false; response: Response }> {
    const link = await rolepay.communities.describeSetupLink({ token: c.req.param('token') as string })
    if (!link.ok) return { ok: false, response: failure(linkStatus(link.error.code), link.error) }
    const community = link.value.community
    if (!community) return { ok: false, response: failure(409, { code: 'treasury_not_bound' }) }
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return { ok: false, response: failure(401, { code: 'no_passkey_session' }) }
    if (session.address !== community.treasuryAddress) {
      return { ok: false, response: failure(403, { code: 'not_the_treasury', treasuryAddress: community.treasuryAddress }) }
    }
    if (!provesPasskey(session, community)) return { ok: false, response: failure(401, { code: 'sign_in_required' }) }
    return { ok: true, value: { community, session } }
  }

  app.get('/setup/:token', async (c) => {
    const token = c.req.param('token')
    const link = await rolepay.communities.describeSetupLink({ token })
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
    // A day of slack for the treasurer's device clock; the chain enforces the expiry it is given.
    if (body.data.expiresAt <= now || body.data.expiresAt > now + (MAX_DAYS + 1) * DAY) {
      return failure(400, { code: 'invalid_input', issues: [`expiresAt: must be in the future and at most ${MAX_DAYS} days away`] })
    }
    const provisioned = await rolepay.communities.provisionBotKey({
      guildId: t.value.community.id,
      limit: limit.value,
      periodSeconds: body.data.periodDays === 0 ? null : body.data.periodDays * DAY,
      expiresAt: body.data.expiresAt,
      feeBudget,
    })
    if (!provisioned.ok) return failure(400, provisioned.error)
    return jsonResponse(200, { ok: true, keyAddress: provisioned.value.keyAddress, treasury: provisioned.value.account, authorization: provisioned.value.authorization })
  })

  const keyRef = async (c: Context) => {
    const body = KeyRefBody.safeParse(await c.req.json().catch(() => null))
    return body.success ? body.data.keyAddress : null
  }

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
