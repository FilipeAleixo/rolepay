import { describe, expect, it } from 'vitest'
import { CONFIG } from '../test/app.js'
import { harness } from '../test/harness.js'
import { createDiscordInteractions } from './interactions.js'
import { RestMemberDirectory } from './adapters/restMemberDirectory.js'
import { ALICE, BOB, CHANNEL, GUILD, MODS_ROLE, TREASURER, TREASURER_ROLE } from '../test/fixtures.js'
import { emptyCriteria } from '@rolepay/core/adapters'
import { MemoryPendingSources } from './testing/fakeDiscordRest.js'
import { buttonClick, messageCommand, modalSubmit, slashCommand, userCommand } from './testing/interactions.js'
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
    const opened = (await (await post(messageCommand({ guildId: GUILD, channelId: CHANNEL }, 'Draft pay run with AI', target, who))).json()) as { type: number }
    expect(opened.type).toBe(9)
    const submitted = (await (await post(modalSubmit({ guildId: GUILD, channelId: CHANNEL }, `proposal-modal:instruct:${target.id}`, { instruction: '10 each' }, who, { token: 'tok-signed' }))).json()) as { type: number }
    expect(submitted).toEqual({ type: 4, data: { content: 'Reading the message and drafting a proposal…', flags: 64 } })
    await Promise.all(background)
    expect(JSON.stringify(h.rest.lastEdit('tok-signed'))).toContain('20 AlphaUSD for 2 people')
  })

  it('signed direct payments: Apps > Pay the author and Apps > Pay with Rolepay each open the form, and the signed form posts the review', async () => {
    const h = await harness()
    await h.setupCommunity()
    await h.registerAll()
    const signer = await createTestSigner()
    const endpoint = createDiscordInteractions({
      publicKey: signer.publicKeyHex,
      deps: { rolepay: h.rolepay, rest: h.rest, queue: h.queue, members: new RestMemberDirectory(h.rest), pendingSources: new MemoryPendingSources(), clock: h.clock, config: CONFIG },
    })
    const post = async (interaction: unknown) => {
      const body = JSON.stringify(interaction)
      const timestamp = String(Math.floor(Date.now() / 1000))
      const headers = { 'x-signature-ed25519': await signer.sign(timestamp + body), 'x-signature-timestamp': timestamp }
      return (await endpoint(new Request('https://x/discord/interactions', { method: 'POST', headers, body }))).json() as Promise<{ type: number; data: { custom_id?: string } }>
    }
    const scope = { guildId: GUILD, channelId: CHANNEL }
    const who = { userId: TREASURER, roles: [TREASURER_ROLE] }
    const target = wireMessage({ channelId: CHANNEL, authorId: ALICE, at: new Date(), content: 'Fixed the claim page' })
    const author = await post(messageCommand(scope, 'Pay the author', target, who))
    expect(author).toMatchObject({ type: 9, data: { custom_id: `pay-modal:author:${ALICE}:${CHANNEL}:${target.id}` } })
    const member = await post(userCommand(scope, 'Pay with Rolepay', { id: BOB }, who))
    expect(member).toMatchObject({ type: 9, data: { custom_id: `pay-modal:member:${BOB}` } })
    for (const [form, amount] of [[author.data.custom_id, '3'], [member.data.custom_id, '4']] as const) {
      const review = await post(modalSubmit(scope, form as string, { amount, note: '' }, who))
      expect(review.type).toBe(4)
      expect(JSON.stringify(review)).toContain('Pay run awaiting approval')
    }
    expect((await h.rolepay.payRuns.list({ guildId: GUILD })).map((r) => [r.lines[0]?.payeeDiscordId, r.total]).sort()).toEqual([
      [ALICE, 3_000_000n],
      [BOB, 4_000_000n],
    ])
  })

  it('a signed /rolepay policy new posts the preview; a signed Approve from a non-approver is refused, from the treasurer it activates', async () => {
    const h = await harness()
    await h.setupCommunity()
    await h.registerAll()
    await h.rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [TREASURER_ROLE] })
    h.rest.roles.set(GUILD, [{ id: MODS_ROLE, name: 'Mods' }])
    h.rest.setMember(GUILD, ALICE, [MODS_ROLE])
    h.proposer.onCriteria = () => emptyCriteria({ amount: { kind: 'flat', amount: '5', per: '', cap: '', total: '', splitBy: '' } }, { hasRole: ['R1'] })
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
    const scope = { guildId: GUILD, channelId: CHANNEL }
    const created = await post(slashCommand(scope, 'rolepay', 'policy new', { instruction: '5 to every Mod each Monday', schedule: 'weekly', weekday: 'monday', hour: 9 }, { userId: TREASURER, roles: [TREASURER_ROLE] }, 'tok-policy'))
    expect(await created.json()).toEqual({ type: 5, data: {} })
    await Promise.all(background)
    const preview = JSON.stringify(h.rest.lastEdit('tok-policy'))
    expect(preview).toContain('5 each.')
    expect(preview).toContain(`<@${ALICE}>  5 AlphaUSD`)
    const approve = /policy:approve:pol_[A-Za-z0-9_]+:1/.exec(preview)?.[0] as string
    const refused = (await (await post(buttonClick(scope, approve, { userId: BOB, manageGuild: true }))).json()) as { data: { flags: number } }
    expect(refused.data.flags).toBe(64)
    const approved = (await (await post(buttonClick(scope, approve, { userId: TREASURER, roles: [TREASURER_ROLE] }))).json()) as { type: number }
    expect(approved.type).toBe(7)
    const policies = await h.rolepay.policies.list({ guildId: GUILD })
    expect(policies.map((p) => p.policy.status)).toEqual(['active'])
  })
})
