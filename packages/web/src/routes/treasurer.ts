import { AddressSchema, type Clock, type Community, type Rolepay, type SetupLinkView, TOKEN_SYMBOLS, parseAmount } from '@rolepay/core'
import type { Context } from 'hono'
import { z } from 'zod'
import { failure, linkStatus } from '../json.js'
import type { PasskeySession, PasskeySessions } from '../ports.js'

/**
 * Whether a session proves the treasury's passkey. A login session does: it signed a server
 * challenge. A registration session proves nothing (anyone can register a public key, and the
 * treasury's is public on chain once it signs), except the one that created the treasury: it was
 * issued before the community existed, when nobody else could have known that public key. So the
 * treasurer who just created the treasury authorises the key without a second prompt, and anyone
 * replaying the public key later must sign in, which they cannot.
 */
export const provesPasskey = (s: PasskeySession, c: Community) => s.proof === 'login' || s.issuedAt * 1000 <= c.createdAt.getTime()

/** The setup link, the community it set up, and the passkey session that IS its treasury. */
export type Treasurer = { community: Community; session: PasskeySession; link: SetupLinkView }

/**
 * The gate for every treasury action (the setup page and a policy's budget page): a live setup link
 * for a community whose treasury is bound, and the session of the passkey that is that treasury,
 * proven by a sign-in. Otherwise the response to send.
 */
export async function treasurerOf(c: Context, deps: { rolepay: Rolepay; sessions: PasskeySessions }): Promise<{ ok: true; value: Treasurer } | { ok: false; response: Response }> {
  const link = await deps.rolepay.communities.describeSetupLink({ token: c.req.param('token') as string })
  if (!link.ok) return { ok: false, response: failure(linkStatus(link.error.code), link.error) }
  const community = link.value.community
  if (!community) return { ok: false, response: failure(409, { code: 'treasury_not_bound' }) }
  const session = await deps.sessions.current(c.req.raw)
  if (!session) return { ok: false, response: failure(401, { code: 'no_passkey_session' }) }
  if (session.address !== community.treasuryAddress) {
    return { ok: false, response: failure(403, { code: 'not_the_treasury', treasuryAddress: community.treasuryAddress }) }
  }
  if (!provesPasskey(session, community)) return { ok: false, response: failure(401, { code: 'sign_in_required' }) }
  return { ok: true, value: { community, session, link: link.value } }
}

export const DAY = 86_400
export const MAX_DAYS = 366
/** A token as people say it (AlphaUSD), or its address when Rolepay does not know it. */
export const tokenLabel = (token: string | null) => (token ? (TOKEN_SYMBOLS[token.toLowerCase()] ?? token) : null)

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

/** What the treasurer typed for a key (the bot key's, or a policy's own), checked; or the response to send. */
export async function keyPolicyRequest(
  c: Context,
  community: Community,
  clock: Clock,
): Promise<{ ok: true; value: { limit: bigint; periodSeconds: number | null; expiresAt: number; feeBudget: bigint | null } } | { ok: false; response: Response }> {
  const bad = (issues: string[]) => ({ ok: false as const, response: failure(400, { code: 'invalid_input', issues }) })
  const body = KeyPolicyBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return bad(body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  const limit = parseAmount(body.data.limit)
  if (!limit.ok) return bad([`limit: "${body.data.limit}" is not an amount`])
  let feeBudget: bigint | null = null
  if (community.feeMode === 'fee_budget') {
    const parsed = parseAmount(body.data.feeBudget ?? '')
    if (!parsed.ok) return bad(['feeBudget: needed in fee budget mode, for example 1'])
    feeBudget = parsed.value
  }
  const now = Math.floor(clock.now().getTime() / 1000)
  // A day of slack for the treasurer's device clock; the chain enforces the expiry it is given.
  if (body.data.expiresAt <= now || body.data.expiresAt > now + (MAX_DAYS + 1) * DAY) return bad([`expiresAt: must be in the future and at most ${MAX_DAYS} days away`])
  return { ok: true, value: { limit: limit.value, periodSeconds: body.data.periodDays === 0 ? null : body.data.periodDays * DAY, expiresAt: body.data.expiresAt, feeBudget } }
}

/** confirm and revoked name the key they are about: the one this browser just signed for. */
const KeyRefBody = z.object({ keyAddress: AddressSchema })

export async function keyRef(c: Context): Promise<string | null> {
  const body = KeyRefBody.safeParse(await c.req.json().catch(() => null))
  return body.success ? body.data.keyAddress : null
}
