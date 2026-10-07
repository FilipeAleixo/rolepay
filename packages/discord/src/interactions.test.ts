import { describe, expect, it } from 'vitest'
import { CONFIG } from '../test/app.js'
import { harness } from '../test/harness.js'
import { createDiscordInteractions } from './interactions.js'
import { RestMemberDirectory } from './adapters/restMemberDirectory.js'
import { ALICE, BOB, CHANNEL, GUILD, TREASURER, TREASURER_ROLE } from '../test/fixtures.js'
import { MemoryPendingSources } from './testing/fakeDiscordRest.js'
import { messageCommand, modalSubmit } from './testing/interactions.js'
import { wireMessage } from './testing/messages.js'
import { createTestSigner } from './testing/signer.js'

describe('createDiscordInteractions (verifier + router + endpoint in one call)', () => {
  it('answers a signed PING with PONG and refuses an unsigned one', async () => {
    const h = await harness()
    const signer = await createTestSigner()
    const endpoint = createDiscordInteractions({
      publicKey: signer.publicKeyHex,
      deps: { rolepay: h.rolepay, rest: h.rest, queue: h.queue, members: new RestMemberDirectory(h.rest), pendingSources: new MemoryPendingSources(), clock: h.clock, config: CONFIG },
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

  it('a signed message command opens the instruction modal; the signed modal submit proposes', async () => {
    const h = await harness()
    await h.setupCommunity()
    await h.registerAll()
    await h.rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [TREASURER_ROLE] })
    const signer = await createTestSigner()
    const background: Promise<unknown>[] = []
    const endpoint = createDiscordInteractions({
      publicKey: signer.publicKeyHex,
      deps: { rolepay: h.rolepay, rest: h.rest, queue: h.queue, members: new RestMemberDirectory(h.rest), pendingSources: new MemoryPendingSources(), clock: h.clock, config: CONFIG },
      waitUntil: (p) => void background.push(p),
    })
    const post = async (interaction: unknown) => {
      const body = JSON.stringify(interaction)
      const timestamp = String(Math.floor(Date.now() / 1000))
      const headers = { 'x-signature-ed25519': await signer.sign(timestamp + body), 'x-signature-timestamp': timestamp }
      return endpoint(new Request('https://x/discord/interactions', { method: 'POST', headers, body }))
    }
    const target = wireMessage({ channelId: CHANNEL, authorId: TREASURER, at: new Date(), content: `Winners: <@${ALICE}> and <@${BOB}>`, mentions: [ALICE, BOB] })
    const who = { userId: TREASURER, roles: [TREASURER_ROLE] }
    const opened = (await (await post(messageCommand({ guildId: GUILD, channelId: CHANNEL }, 'Propose pay run', target, who))).json()) as { type: number }
    expect(opened.type).toBe(9)
    const submitted = (await (await post(modalSubmit({ guildId: GUILD, channelId: CHANNEL }, `proposal-modal:instruct:${target.id}`, { instruction: '10 each' }, who, { token: 'tok-signed' }))).json()) as { type: number }
    expect(submitted).toEqual({ type: 4, data: { content: 'Reading the message and drafting a proposal…', flags: 64 } })
    await Promise.all(background)
    expect(JSON.stringify(h.rest.lastEdit('tok-signed'))).toContain('20 AlphaUSD for 2 people')
  })
})
