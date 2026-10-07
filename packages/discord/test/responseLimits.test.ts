// Every answer a button gets, and every message Rolepay edits or posts, checked against Discord's
// documented limits (test/discordLimits.ts). Discord refuses a body over any limit, and for a button
// the person sees only "This interaction failed" while the server logs a 200: this keeps that from
// shipping. The biggest run Rolepay allows is checked in every state, not just a small one.
import { MAX_LINES_PER_RUN, MAX_NOTE_LENGTH, type Run, newRun } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { createDispatcher } from '../src/app/router.js'
import { buttonClick, slashCommand } from '../src/testing/interactions.js'
import { explainError } from '../src/views/errors.js'
import { editModal, instructionModal, proposalCreatedMessage, proposalDiscardedMessage, proposalMessage } from '../src/views/proposal.js'
import { type RunViewContext, receiptDm, runMessage } from '../src/views/run.js'
import { SCOPE, appHarness, body } from './app.js'
import { FLAG, messageProblems, responseProblems } from './discordLimits.js'
import { ADMIN, ALICE, BOB, GUILD, T0, TOKEN, TREASURER, TREASURER_ROLE, TREASURY, TX, advance, paid, pending, proposal, run } from './fixtures.js'
import { usd } from './harness.js'

const network = 'moderato' as const
const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }

/** The biggest run Rolepay allows: 50 lines of the largest amounts, the longest note, every character of it escaped. */
function largestRun(): Run {
  const lines = Array.from({ length: MAX_LINES_PER_RUN }, (_, i) => ({
    payeeDiscordId: `20000000000000${String(i).padStart(4, '0')}`,
    address: `0x${String(i + 1).padStart(40, '0')}`,
    amount: 999_999_999_999_999n,
  }))
  const r = newRun({ id: 'run_largest0largest0', communityId: GUILD, token: TOKEN, note: '*_'.repeat(MAX_NOTE_LENGTH / 2), createdBy: ADMIN, lines, now: T0 })
  if (!r.ok) throw new Error(r.error.code)
  return r.value
}

function states(base: Run): [string, Run, Omit<RunViewContext, 'network'>][] {
  const submitted = advance(base, { type: 'submit', actor: ADMIN })
  const approvedRun = advance(submitted, { type: 'approve', actor: TREASURER })
  const executingRun = advance(approvedRun, { type: 'start_attempt', fromBlock: 1n, validBefore: 1_800_000_000 })
  const paidRun = advance(executingRun, { type: 'mark_paid', txHash: TX, blockNumber: 7n })
  // The node's own text, as long as the adapter lets it get (600 characters).
  const failedRun = advance(executingRun, { type: 'mark_failed', reason: 'rejected', detail: `insufficient_balance: ${'x'.repeat(600)}` })
  const mismatched = advance(executingRun, { type: 'mark_failed', reason: 'partial_match', detail: `paid lines 1,2; missing ${'3,'.repeat(40)}` })
  return [
    ['awaiting approval', submitted, { approverRoleId: TREASURER_ROLE }],
    ['approved, paying (the Approve update)', approvedRun, {}],
    ['approved, not paid yet', approvedRun, { problem: explainError({ code: 'insufficient_limit', remaining: 1n, needed: 2n }, { token: TOKEN }) }],
    ['paying again (the Retry update)', failedRun, { paying: true }],
    ['executing, still confirming', executingRun, { stillConfirming: true }],
    ['paid', paidRun, {}],
    ['paid, receipts going out', paidRun, { receipts: 'sending' }],
    ['paid, receipts sent', paidRun, { receipts: { sent: 1, total: 2 } }],
    ['failed, safe to retry', failedRun, {}],
    ['failed, with the node detail (a private status)', failedRun, { showDetail: true }],
    ['failed, a person must look', mismatched, { problem: explainError({ code: 'chain_shows_payments', detail: 'partial' }) }],
    ['cancelled', advance(submitted, { type: 'cancel', actor: ADMIN }), {}],
  ]
}

describe('the Discord limits check itself (it must be able to fail)', () => {
  const review = runMessage(pending(), { network, approverRoleId: TREASURER_ROLE })
  const embed = review.embeds?.[0] ?? {}
  const button = { type: 2, style: 1, label: 'Go', custom_id: 'rolepay:approve:run_1' }

  it('accepts a review as an update and as a reply', () => {
    expect(responseProblems({ type: 7, data: review })).toEqual([])
    expect(responseProblems({ type: 4, data: review })).toEqual([])
  })

  it('refuses an update that tries to make the message ephemeral, or carries attachments without files', () => {
    expect(responseProblems({ type: 7, data: { ...review, flags: FLAG.Ephemeral } })).toEqual(['type 7.flags: 64 is not allowed here'])
    expect(responseProblems({ type: 7, data: { ...review, attachments: [{ id: 0, filename: 'a.csv' }] } })).toEqual(['type 7: attachments without the files (a JSON body)'])
  })

  it('refuses empty or over-long embed text, too many characters in all, and too many or repeated buttons', () => {
    expect(responseProblems({ type: 7, data: { embeds: [{ ...embed, fields: [{ name: 'Total', value: '' }] }] } })).not.toEqual([])
    expect(responseProblems({ type: 7, data: { embeds: [{ ...embed, description: 'x'.repeat(4097) }] } })).not.toEqual([])
    const sixFull = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, value: 'x'.repeat(1024) }))
    expect(responseProblems({ type: 7, data: { embeds: [{ title: 't', fields: sixFull }] } })).toEqual([expect.stringContaining('over 6000')])
    expect(responseProblems({ type: 7, data: { content: 'x', components: [{ type: 1, components: Array.from({ length: 6 }, (_, i) => ({ ...button, custom_id: `b${i}` })) }] } })).not.toEqual([])
    expect(responseProblems({ type: 4, data: { content: 'x', components: [{ type: 1, components: [button, button] }] } })).toEqual(['type 4: a custom_id appears twice in one message'])
  })

  it('refuses an empty reply, data on a deferred update, content on a deferral, and an unknown type', () => {
    expect(responseProblems({ type: 4, data: {} })).toEqual(['type 4: a message needs content, an embed, a component or a file'])
    expect(responseProblems({ type: 6, data: {} })).toEqual(['type 6 carries no data'])
    expect(responseProblems({ type: 5, data: { content: 'x' } })).not.toEqual([])
    expect(responseProblems({ type: 3 })).toEqual(['type 3 is not an interaction response type'])
  })

  it('a message over REST may be ephemeral only where it is allowed (a follow-up)', () => {
    expect(messageProblems({ content: 'x', flags: FLAG.Ephemeral })).toEqual(['message.flags: 64 is not allowed here'])
    expect(messageProblems({ content: 'x', flags: FLAG.Ephemeral }, { ephemeral: true })).toEqual([])
  })
})

describe('every state of a run message fits Discord, for a small run and the biggest allowed', () => {
  const cases: [string, Run, Omit<RunViewContext, 'network'>][] = [
    ...states(run()).map(([name, r, ctx]): [string, Run, Omit<RunViewContext, 'network'>] => [`small run, ${name}`, r, ctx]),
    ...states(largestRun()).map(([name, r, ctx]): [string, Run, Omit<RunViewContext, 'network'>] => [`largest run, ${name}`, r, ctx]),
  ]

  it.each(cases)('%s: as the update a button answers with, as a reply, and as an edit or post', (_, r, extra) => {
    const m = runMessage(r, { network, ...extra })
    expect(responseProblems({ type: 7, data: m })).toEqual([])
    expect(responseProblems({ type: 4, data: m })).toEqual([])
    expect(messageProblems(m)).toEqual([])
  })

  it('the receipt DM fits, with a long server name', () => {
    const r = paid()
    for (const line of r.lines) expect(messageProblems(receiptDm(r, line, { network, communityName: 'S'.repeat(100) }))).toEqual([])
  })
})

describe('every answer to a run button, through the router (what Discord receives)', () => {
  async function withRuns() {
    const a = await appHarness()
    await a.setupCommunity()
    await a.registerAll()
    const make = async () => {
      const created = await a.rolepay.payRuns.create({ guildId: GUILD, createdBy: ADMIN, note: 'October mods', lines: [{ discordUserId: ALICE, amount: usd('1.5') }, { discordUserId: BOB, amount: usd('25') }] })
      if (!created.ok) throw new Error(created.error.code)
      await a.rolepay.payRuns.submit({ guildId: GUILD, runId: created.value.id, actor: ADMIN })
      return created.value.id
    }
    return { ...a, make }
  }

  it('Approve answers with an update Discord accepts (the "This interaction failed" report on the demo)', async () => {
    const a = await withRuns()
    const runId = await a.make()
    const d = await a.send(buttonClick(SCOPE, `rolepay:approve:${runId}`, treasurer, 'tok-approve'))
    expect(body(d).type).toBe(7)
    expect(responseProblems(body(d))).toEqual([])
    expect(a.queue.jobs).toHaveLength(1)
  })

  it('Cancel, Retry, and a click by someone who may not answer each fit too', async () => {
    const a = await withRuns()
    const toCancel = await a.make()
    const cancelled = await a.send(buttonClick(SCOPE, `rolepay:cancel:${toCancel}`, { userId: ADMIN, manageGuild: true }, 'tok-cancel'))
    expect(body(cancelled).type).toBe(7)
    expect(responseProblems(body(cancelled))).toEqual([])

    const toRetry = await a.make()
    await a.rolepay.payRuns.approve({ guildId: GUILD, runId: toRetry, actor: TREASURER, actorCanApprove: true })
    a.chain.fund(TOKEN, TREASURY, -usd('1000')) // the network refuses: the run fails, safe to retry
    expect(await a.rolepay.payRuns.execute({ guildId: GUILD, runId: toRetry })).toMatchObject({ ok: true, value: { status: 'failed' } })
    const retried = await a.send(buttonClick(SCOPE, `rolepay:retry:${toRetry}`, treasurer, 'tok-retry'))
    expect(body(retried).type).toBe(7)
    expect(responseProblems(body(retried))).toEqual([])

    const refused = await a.send(buttonClick(SCOPE, `rolepay:approve:${await a.make()}`, { userId: '200000000000000009' }, 'tok-bystander'))
    expect(responseProblems(body(refused))).toEqual([])
  })

  it('a slow Approve: the deferred update and the edit that follows both fit', async () => {
    const a = await withRuns()
    const runId = await a.make()
    const approve = a.rolepay.payRuns.approve.bind(a.rolepay.payRuns)
    a.rolepay.payRuns.approve = async (input) => {
      await new Promise((r) => setTimeout(r, 60))
      return approve(input)
    }
    const d = await createDispatcher(a.deps, { ackDeadlineMs: 10 })(buttonClick(SCOPE, `rolepay:approve:${runId}`, treasurer, 'tok-slow'))
    if (d.kind !== 'respond') throw new Error('expected a response')
    expect(responseProblems(d.body)).toEqual([])
    await d.background?.()
    const edited = a.rest.lastEdit('tok-slow')
    expect(edited).toBeDefined()
    expect(messageProblems(edited ?? {})).toEqual([])
  })

  it('/rolepay new: the public deferral and the review it is edited into', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'rolepay', 'new', { amount: '10', users: `<@${ALICE}> <@${BOB}>=40`, note: 'October mods' }, { userId: ADMIN, manageGuild: true }, 'tok-new'))
    expect(responseProblems(body(d))).toEqual([])
    expect(messageProblems(a.rest.lastEdit('tok-new') ?? {})).toEqual([])
  })
})

describe('the proposal buttons and forms', () => {
  it('the update after Create and the review it posts, the update after Discard, the forms', () => {
    const p = proposal()
    const review = pending()
    expect(responseProblems({ type: 7, data: proposalCreatedMessage({ ...p, status: 'run_created', runId: review.id }, review, { approverRoleId: TREASURER_ROLE }) })).toEqual([])
    expect(messageProblems(runMessage(review, { network, approverRoleId: TREASURER_ROLE }))).toEqual([])
    expect(responseProblems({ type: 7, data: proposalDiscardedMessage({ ...p, status: 'discarded' }) })).toEqual([])
    expect(responseProblems({ type: 9, data: editModal(p) })).toEqual([])
    expect(responseProblems({ type: 9, data: instructionModal('810000000000000001') })).toEqual([])
    expect(messageProblems(proposalMessage(p, { approverRoleId: TREASURER_ROLE }), { ephemeral: true })).toEqual([])
  })
})
