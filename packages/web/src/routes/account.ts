import { AddressSchema, DiscordIdSchema, KNOWN_TOKENS, type PayeeService, TOKEN_SYMBOLS } from '@rolepay/core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { WebConfig } from '../config.js'
import { failure, jsonResponse } from '../json.js'
import type { PasskeySessions } from '../ports.js'
import { accountPage } from '../views/account.js'

export type AccountRoutesDeps = { config: WebConfig; testnet: boolean; payees: PayeeService; sessions: PasskeySessions }

const label = (address: string) => ({ address, label: TOKEN_SYMBOLS[address.toLowerCase()] ?? address })

/** The community and the stablecoin; never an address (it comes from the verified passkey session). null = the payout token. */
const PreferenceBody = z.object({ guildId: DiscordIdSchema, token: AddressSchema.nullable() })

const PREFERENCE_STATUS: Record<string, number> = { invalid_input: 400, token_not_allowed: 400, payee_not_found: 404, community_not_found: 404 }

/**
 * /account: the payee's own account page. Sending money stays in the browser: the passkey signs any
 * transfer and sends it straight to Tempo, so no endpoint takes an address or an amount. The only
 * thing the server stores from here is which stablecoin the payee wants to be paid in, per
 * community (`/account/payouts`, `/account/preference`), always for the address of the passkey
 * session it verified, never an address the page sends.
 */
export function accountRoutes(deps: AccountRoutesDeps): Hono {
  const { config } = deps
  const app = new Hono()
  app.get('/account', (c) =>
    c.html(
      accountPage({
        page: 'account',
        network: config.network,
        testnet: deps.testnet,
        rpcUrl: config.rpcUrl,
        sponsorUrl: config.sponsorUrl,
        explorerUrl: config.explorerUrl,
        tokens: KNOWN_TOKENS[config.network].map((address) => ({ address, label: TOKEN_SYMBOLS[address] ?? address })),
      }),
    ),
  )

  /** Where the signed-in passkey is paid: per community, its payout token, the choices and the current one. */
  app.get('/account/payouts', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const payouts = (await deps.payees.registrations({ address: session.address })).map((r) => ({
      guildId: r.guildId,
      communityName: r.communityName,
      payoutToken: label(r.payoutToken),
      preferredToken: r.preferredToken,
      enabled: r.enabled,
      choices: r.choices.map(label),
    }))
    return jsonResponse(200, { ok: true, payouts })
  })

  app.post('/account/preference', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const body = PreferenceBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input', issues: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    const set = await deps.payees.setPreferredTokenByAddress({ guildId: body.data.guildId, address: session.address, token: body.data.token })
    if (!set.ok) return failure(PREFERENCE_STATUS[set.error.code] ?? 400, set.error)
    return jsonResponse(200, { ok: true, preferredToken: set.value[0]?.preferredToken ?? null })
  })
  return app
}
