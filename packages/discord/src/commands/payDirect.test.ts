import type { Run } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, CAROL, CHANNEL, GUILD, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { usd } from '../../test/harness.js'
import { buttonClick, messageCommand, modalSubmit } from '../testing/interactions.js'
import { wireMessage } from '../testing/messages.js'

const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }
const admin = { userId: ADMIN, manageGuild: true }
const DAVE = '200000000000000004' // not registered
const BOT = '500000000000000777'
const T0 = new Date('2026-10-06T12:00:00.000Z')

async function ready() {
  const a = await appHarness()
  await a.setupCommunity()
  await a.registerAll()
  return a
}

const latestRun = async (a: Awaited<ReturnType<typeof ready>>): Promise<Run | undefined> => (await a.rolepay.payRuns.list({ guildId: GUILD }))[0]

const byAlice = wireMessage({ channelId: CHANNEL, authorId: ALICE, at: T0, content: 'Shipped the claim page fix.' })
const link = `https://discord.com/channels/${GUILD}/${CHANNEL}/${byAlice.id}`
const formId = `pay-modal:author:${ALICE}:${CHANNEL}:${byAlice.id}`
/** The text inputs of a modal response, by custom_id. */
const inputs = (d: Awaited<ReturnType<Awaited<ReturnType<typeof ready>>['send']>>) =>
  Object.fromEntries(((body(d).data?.components ?? []) as { components: { custom_id: string; max_length?: number }[] }[]).flatMap((row) => row.components).map((c) => [c.custom_id, c]))

describe('Apps > Pay the author (a message command)', () => {
  it('asks for the amount and a note, then creates a one-line run for the author, posted for the Treasurer like any run', async () => {
    const a = await ready()
    const opened = await a.send(messageCommand(SCOPE, 'Pay the author', byAlice, treasurer))
    expect(body(opened)).toMatchObject({ type: 9, data: { custom_id: formId, title: 'Pay the author of this message' } })
    expect(inputs(opened)).toEqual({
      amount: expect.objectContaining({ label: 'Amount in AlphaUSD', style: 1, required: true }),
      note: expect.objectContaining({ label: 'Note (on the receipt and in the CSV)', style: 1, required: false, value: 'For this message' }),
    })
    // Nothing exists until the form is sent.
    expect(await latestRun(a)).toBeUndefined()

    const sent = await a.send(modalSubmit(SCOPE, formId, { amount: '25', note: 'For this message' }, treasurer))
    expect(isEphemeral(sent)).toBe(false)
    const review = text(body(sent))
    expect(review).toContain('Pay run awaiting approval')
    expect(review).toContain(`<@${ALICE}>  25 AlphaUSD`)
    expect(review).toContain(`<@&${TREASURER_ROLE}>`)
    const r = await latestRun(a)
    expect(r && { status: r.status, createdBy: r.createdBy, note: r.note, lines: r.lines.map((l) => [l.payeeDiscordId, l.amount]) }).toEqual({
      status: 'pending_approval',
      createdBy: TREASURER,
      note: `For this message (${link})`,
      lines: [[ALICE, usd('25')]],
    })
    expect(review).toContain(`rolepay:approve:${r?.id}`)

    // The approval is the normal one.
    const approved = await a.send(buttonClick(SCOPE, `rolepay:approve:${r?.id}`, treasurer))
    expect(body(approved).type).toBe(7)
    expect(a.queue.jobs).toHaveLength(1)
  })

  it('an empty note leaves just the link to the message; amounts like 1,000 or $12.50 are read exactly', async () => {
    const a = await ready()
    await a.send(modalSubmit(SCOPE, formId, { amount: '1,000', note: '  ' }, admin))
    expect(await latestRun(a)).toMatchObject({ note: link, total: usd('1000'), createdBy: ADMIN })
    a.clock.advance(1)
    await a.send(modalSubmit(SCOPE, formId, { amount: '$12.50', note: 'Bounty #12' }, admin))
    expect(await latestRun(a)).toMatchObject({ note: `Bounty #12 (${link})`, total: usd('12.5') })
  })

  it('the note always fits the run with its link: the form says how long it may be', async () => {
    const a = await ready()
    const opened = await a.send(messageCommand(SCOPE, 'Pay the author', byAlice, treasurer))
    const max = inputs(opened).note?.max_length ?? 0
    expect(max).toBe(200 - ` (${link})`.length)
    await a.send(modalSubmit(SCOPE, formId, { amount: '5', note: 'x'.repeat(250) }, treasurer))
    const r = await latestRun(a)
    expect(r?.note).toBe(`${'x'.repeat(max)} (${link})`)
  })

  it('needs Manage Server or the approver role, as /rolepay new does, checked again when the form is sent', async () => {
    const a = await ready()
    const member = { userId: CAROL }
    const refused = await a.send(messageCommand(SCOPE, 'Pay the author', byAlice, member))
    expect(isEphemeral(refused) && body(refused).data?.content).toMatch(/Manage Server or the approver role/)
    const submitted = await a.send(modalSubmit(SCOPE, formId, { amount: '25', note: '' }, member))
    expect(isEphemeral(submitted) && body(submitted).data?.content).toMatch(/Manage Server or the approver role/)
    expect(body(await a.send(messageCommand(SCOPE, 'Pay the author', byAlice, admin))).type).toBe(9)
    expect(await latestRun(a)).toBeUndefined()
  })

  it('in a server without setup, says so', async () => {
    const a = await appHarness()
    const d = await a.send(messageCommand(SCOPE, 'Pay the author', byAlice, admin))
    expect(body(d).data?.content).toMatch(/\/rolepay setup/)
  })

  it('an author who is not a registered payee: refused before the form, pointing them to /payee link', async () => {
    const a = await ready()
    const d = await a.send(messageCommand(SCOPE, 'Pay the author', wireMessage({ channelId: CHANNEL, authorId: DAVE, at: T0, content: 'hi' }), treasurer))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toBe(`<@${DAVE}> is not a registered payee yet, so Rolepay cannot pay them. They run \`/payee link\` first to register the account they are paid at, then you can pay them.`)
    // The form checks again (they could have been removed in between): the same words.
    const sent = await a.send(modalSubmit(SCOPE, `pay-modal:author:${DAVE}:${CHANNEL}:${byAlice.id}`, { amount: '5', note: '' }, treasurer))
    expect(body(sent).data?.content).toMatch(/is not a registered payee yet.*\/payee link/)
    expect(await latestRun(a)).toBeUndefined()
  })

  it('a message by a bot or a webhook: refused, Rolepay pays people', async () => {
    const a = await ready()
    const d = await a.send(messageCommand(SCOPE, 'Pay the author', wireMessage({ channelId: CHANNEL, authorId: BOT, at: T0, content: 'Winners: ...', bot: true }), treasurer))
    expect(isEphemeral(d) && body(d).data?.content).toBe('That message was written by a bot or a webhook, and Rolepay pays people. Pick a message a member wrote.')
  })

  it('your own message: allowed by default (a treasurer approves it), refused when the server requires a separate approver', async () => {
    const a = await ready()
    await a.registerPayee(TREASURER, '0x4444444444444444444444444444444444444444')
    const mine = wireMessage({ channelId: CHANNEL, authorId: TREASURER, at: T0, content: 'Paid the hosting bill' })
    expect(body(await a.send(messageCommand(SCOPE, 'Pay the author', mine, treasurer))).type).toBe(9)

    await a.rolepay.communities.setRequireSeparateApprover({ guildId: GUILD, value: true, actorRoleIds: [TREASURER_ROLE] })
    const d = await a.send(messageCommand(SCOPE, 'Pay the author', mine, treasurer))
    expect(isEphemeral(d) && body(d).data?.content).toBe(
      'This server requires a separate approver (`separate_approver`), so you cannot create a run that pays you. Ask another member with Manage Server or the approver role to pay you.',
    )
    const sent = await a.send(modalSubmit(SCOPE, `pay-modal:author:${TREASURER}:${CHANNEL}:${mine.id}`, { amount: '5', note: '' }, treasurer))
    expect(body(sent).data?.content).toMatch(/separate approver/)
    expect(await latestRun(a)).toBeUndefined()
  })

  it('an amount that is not one: refused in plain words, nothing created', async () => {
    const a = await ready()
    const said = async (amount: string) => {
      const d = await a.send(modalSubmit(SCOPE, formId, { amount, note: '' }, treasurer))
      expect(isEphemeral(d)).toBe(true)
      return body(d).data?.content
    }
    expect(await said('twenty')).toBe('"twenty" is not an amount. Write digits and a dot, for example 25 or 12.50.')
    expect(await said('')).toBe('Say how much to pay, for example 25 or 12.50.')
    expect(await said('0')).toBe('The amount must be more than 0.')
    expect(await said('1.0000001')).toBe('"1.0000001" has more than 6 decimals.')
    expect(await said('-5')).toMatch(/is not an amount/)
    expect(await latestRun(a)).toBeUndefined()
  })
})
