import { describe, expect, it } from 'vitest'
import { CONFIG } from '../test/app.js'
import { harness } from '../test/harness.js'
import { createDiscordInteractions } from './interactions.js'
import { RestMemberDirectory } from './adapters/restMemberDirectory.js'
import { createTestSigner } from './testing/signer.js'

describe('createDiscordInteractions (verifier + router + endpoint in one call)', () => {
  it('answers a signed PING with PONG and refuses an unsigned one', async () => {
    const h = await harness()
    const signer = await createTestSigner()
    const endpoint = createDiscordInteractions({
      publicKey: signer.publicKeyHex,
      deps: { payrun: h.payrun, rest: h.rest, queue: h.queue, members: new RestMemberDirectory(h.rest), clock: h.clock, config: CONFIG },
    })
    const body = JSON.stringify({ id: '800000000000000001', application_id: '500000000000000001', type: 1, token: 't', version: 1 })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signed = await endpoint(
      new Request('https://x/discord/interactions', {
        method: 'POST',
        headers: { 'x-signature-ed25519': await signer.sign(timestamp + body), 'x-signature-timestamp': timestamp },
        body,
      }),
    )
    expect(await signed.json()).toEqual({ type: 1 })
    const unsigned = await endpoint(new Request('https://x/discord/interactions', { method: 'POST', body }))
    expect(unsigned.status).toBe(401)
  })
})
