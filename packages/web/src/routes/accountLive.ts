import { type ReceivedPayment, type Rolepay, TOKEN_SYMBOLS, displayAmount } from '@rolepay/core'
import { Hono } from 'hono'
import type { WebConfig } from '../config.js'
import { failure } from '../json.js'
import { type LiveStreams, eventStream } from '../live/streams.js'
import type { PasskeySessions } from '../ports.js'
import { type ReceivedItem, receivedItems } from '../views/account.js'

export type AccountLiveDeps = { rolepay: Rolepay; sessions: PasskeySessions; config: WebConfig; live: LiveStreams }

const tokenLabel = (token: string) => TOKEN_SYMBOLS[token.toLowerCase()] ?? token

/** One payment as the account page shows it: the amount for people, the token's name, where it came from and its transaction. */
function item(p: ReceivedPayment, explorer: string): ReceivedItem {
  return {
    key: `${p.runId}:${p.line}`,
    amount: displayAmount(p.amount),
    token: tokenLabel(p.token),
    communityName: p.communityName,
    runId: p.runId,
    line: p.line,
    txUrl: p.txHash ? `${explorer}/tx/${p.txHash}` : null,
  }
}

const htmlFragment = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

/**
 * The account page, live. Both endpoints answer only for the address of the verified passkey
 * session, never an address the page sends, and say nothing about anyone else:
 *
 * - `GET /account/received`: what this account was paid recently, as list items rendered here
 *   (the page re-reads it when a payment lands, so all its HTML comes from the server);
 * - `GET /account/live`: server-sent events, one `payment` per run line paid to this address (amount,
 *   token, run, line, transaction, the community's name), checked at every heartbeat that the
 *   session is still the same.
 */
export function accountLiveRoutes(deps: AccountLiveDeps): Hono {
  const app = new Hono()
  const explorer = deps.config.explorerUrl

  app.get('/account/received', async (c) => {
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return htmlFragment('<li class="none">Sign in with your passkey to see what you received.</li>', 401)
    const list = await deps.rolepay.live.received({ address: session.address, limit: 10 })
    return htmlFragment(receivedItems(list.map((p) => item(p, explorer))))
  })

  app.get('/account/live', async (c) => {
    if (!deps.rolepay.live.enabled) return failure(404, { code: 'live_not_available' })
    const session = await deps.sessions.current(c.req.raw)
    if (!session) return failure(401, { code: 'no_passkey_session' })
    const address = session.address
    return eventStream(deps.live, c.req.raw, {
      sessionKey: `passkey:${session.credentialId}`,
      open: (sink) =>
        deps.rolepay.live.payments({ address }, (p) =>
          sink.send('payment', { ...item(p, explorer), amountMicros: p.amount.toString(), tokenAddress: p.token, guildId: p.guildId, txHash: p.txHash }, p.seq),
        ),
      stillAllowed: async () => (await deps.sessions.current(c.req.raw))?.address === address,
    })
  })
  return app
}
