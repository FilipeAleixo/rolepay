import { type PayeeService, TOKEN_SYMBOLS } from '@rolepay/core'
import { Hono } from 'hono'
import { z } from 'zod'
import { failure, jsonResponse, linkStatus } from '../json.js'
import { payeePasskeyName } from '../passkeyNames.js'
import type { PasskeySessions } from '../ports.js'
import { claimPage } from '../views/claim.js'
import { linkErrorPage } from '../views/page.js'

/** `origin`: this server's public origin, from config (never from the request): wallet claims name it. */
export type ClaimRoutesDeps = { payees: PayeeService; sessions: PasskeySessions; network: string; explorerUrl: string; testnet: boolean; origin: string }

const WalletChallengeBody = z.object({ address: z.string() })
const WalletClaimBody = z.object({ message: z.string(), signature: z.string() })

/** A wallet claim that registered nothing: a link error keeps its status (404, 410), the rest is the request's fault (400) or the server's (501). */
const walletStatus = (code: string) => (code === 'not_configured' ? 501 : code.startsWith('link_') ? linkStatus(code) : 400)

/**
 * /claim/:token: the recipient registers where this community pays them, one of two ways. A
 * passkey: the page creates (or signs in with) a passkey account, and the address comes from the
 * passkey session the server verified. A wallet they already have: the page asks for a challenge
 * (`/wallet/challenge`), the wallet signs it, and the address comes from the signature the server
 * verified (`/wallet`). Never an address the page sends.
 */
export function claimRoutes(deps: ClaimRoutesDeps): Hono {
  const app = new Hono()

  app.get('/claim/:token', async (c) => {
    const token = c.req.param('token')
    const link = await deps.payees.describeLink({ token })
    if (!link.ok) return c.html(linkErrorPage(link.error.code, '/payee link', deps.testnet), linkStatus(link.error.code) as 404)
    const communityName = link.value.communityName ?? 'your Discord server'
    // The stablecoins they may choose to be paid in, set after the passkey registers (/account/preference).
    const options = await deps.payees.preferenceOptions({ guildId: link.value.guildId })
    const label = (address: string) => ({ address, label: TOKEN_SYMBOLS[address.toLowerCase()] ?? address })
    return c.html(
      claimPage(
        {
          page: 'claim',
          token,
          communityName,
          // One name per person (see passkeyNames.ts): the SDK signs in to a remembered account of the same name.
          passkeyName: payeePasskeyName(communityName, link.value.discordUsername ?? link.value.discordUserId),
          network: deps.network,
          explorerUrl: deps.explorerUrl,
          guildId: link.value.guildId,
          payoutLabel: options.ok ? label(options.value.payoutToken).label : null,
          preferredTokens: options.ok && options.value.enabled,
          choices: options.ok ? options.value.choices.map(label) : [],
        },
        deps.testnet,
      ),
    )
  })

  app.post('/claim/:token', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const token = c.req.param('token')
    const link = await deps.payees.describeLink({ token })
    const registered = await deps.payees.register({ token, address: session.address })
    if (!registered.ok) return failure(registered.error.code === 'invalid_input' ? 400 : linkStatus(registered.error.code), registered.error)
    return jsonResponse(200, {
      ok: true,
      address: registered.value.address,
      communityName: link.ok ? (link.value.communityName ?? null) : null,
      preferredToken: registered.value.preferredToken,
    })
  })

  // "Use a wallet I already have", step one: the message to sign. The address only fills in its text.
  app.post('/claim/:token/wallet/challenge', async (c) => {
    const body = WalletChallengeBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input' })
    const r = await deps.payees.walletChallenge({ token: c.req.param('token'), address: body.data.address, origin: deps.origin })
    if (!r.ok) return failure(walletStatus(r.error.code), r.error)
    return jsonResponse(200, { ok: true, message: r.value.message })
  })

  // Step two: the signed message. What is registered is the address that signed it.
  app.post('/claim/:token/wallet', async (c) => {
    const body = WalletClaimBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return failure(400, { code: 'invalid_input' })
    const token = c.req.param('token')
    const link = await deps.payees.describeLink({ token })
    const r = await deps.payees.registerExternal({ token, message: body.data.message, signature: body.data.signature, origin: deps.origin })
    if (!r.ok) return failure(walletStatus(r.error.code), r.error)
    return jsonResponse(200, { ok: true, address: r.value.address, addressKind: r.value.addressKind, communityName: link.ok ? link.value.communityName : null })
  })

  return app
}
