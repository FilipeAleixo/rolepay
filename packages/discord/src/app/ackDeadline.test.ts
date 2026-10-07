// Discord shows "This interaction failed" when the first answer takes longer than 3 seconds. Whatever a
// handler waits on (the chain, Discord's REST API, the model, a cold path), the router answers within
// the deadline with a deferred response and delivers the handler's answer by an edit or a follow-up.
import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, BOB, CAROL, CHANNEL, GUILD, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { usd } from '../../test/harness.js'
import { autocomplete, buttonClick, messageCommand, slashCommand } from '../testing/interactions.js'
import { wireMessage } from '../testing/messages.js'
import { createDispatcher } from './router.js'

const DEADLINE_MS = 50
const SLOW_MS = 400
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }

/** Makes one service method slow, like a cold path or a slow network read would. */
function slow<T extends object, K extends keyof T>(target: T, key: K) {
  const real = (target[key] as (...args: unknown[]) => Promise<unknown>).bind(target)
  target[key] = (async (...args: unknown[]) => {
    await sleep(SLOW_MS)
    return real(...args)
  }) as T[K]
}

async function withPendingRun() {
  const a = await appHarness()
  await a.setupCommunity()
  await a.registerAll()
  const created = await a.rolepay.payRuns.create({
    guildId: GUILD,
    createdBy: ADMIN,
    note: 'October mods',
    lines: [
      { discordUserId: ALICE, amount: usd('1.5') },
      { discordUserId: BOB, amount: usd('25') },
    ],
  })
  if (!created.ok) throw new Error(created.error.code)
  await a.rolepay.payRuns.submit({ guildId: GUILD, runId: created.value.id, actor: ADMIN })
  return { ...a, runId: created.value.id, dispatch: createDispatcher(a.deps, { ackDeadlineMs: DEADLINE_MS }) }
}

/** Dispatches and times the first answer (what Discord waits for), then runs the background work. */
async function timed(dispatch: ReturnType<typeof createDispatcher>, interaction: unknown) {
  const started = performance.now()
  const d = await dispatch(interaction)
  const ms = performance.now() - started
  if (d.kind === 'respond') await d.background?.()
  return { d, ms }
}

describe('the 3-second rule: a slow handler is acknowledged in time', () => {
  it('a slow Approve answers with a deferred update within the deadline, then edits the message to "paying"', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.payRuns, 'approve')
    const { d, ms } = await timed(a.dispatch, buttonClick(SCOPE, `rolepay:approve:${a.runId}`, treasurer, 'tok-approve'))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 6 })
    expect(text(a.rest.lastEdit('tok-approve'))).toMatch(/Approved, paying/)
    expect(a.queue.jobs).toHaveLength(1)
  })

  it('a fast Approve still updates the message in the first answer', async () => {
    const a = await withPendingRun()
    const { d } = await timed(a.dispatch, buttonClick(SCOPE, `rolepay:approve:${a.runId}`, treasurer, 'tok-approve'))
    expect(body(d).type).toBe(7)
    expect(a.rest.edits).toEqual([])
  })

  it('a slow button whose answer is a private reply sends it as a private follow-up', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.communities, 'get')
    const { d, ms } = await timed(a.dispatch, buttonClick(SCOPE, `rolepay:approve:${a.runId}`, { userId: CAROL, roles: [] }, 'tok-bystander'))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 6 })
    expect(a.rest.followUps).toHaveLength(1)
    expect(a.rest.followUps[0]?.message.flags).toBe(64)
    expect(a.rest.followUps[0]?.message.content).toContain(`<@&${TREASURER_ROLE}>`)
    expect(a.queue.jobs).toEqual([])
  })

  it('a private answer whose follow-up fails is never posted in the channel instead', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.communities, 'get')
    a.rest.expiredTokens.add('tok-bystander')
    await timed(a.dispatch, buttonClick(SCOPE, `rolepay:approve:${a.runId}`, { userId: CAROL, roles: [] }, 'tok-bystander'))
    expect(a.rest.channelPosts).toEqual([])
  })

  it('a slow Cancel (it may read the chain) is acknowledged, then the message shows the cancelled run', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.payRuns, 'cancel')
    const { d, ms } = await timed(a.dispatch, buttonClick(SCOPE, `rolepay:cancel:${a.runId}`, { userId: ADMIN, manageGuild: true }, 'tok-cancel'))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 6 })
    expect(text(a.rest.lastEdit('tok-cancel'))).toMatch(/Cancelled/)
  })

  it('a slow command answers with a private deferred reply, then the reply is edited in', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.payees, 'issueLink')
    const { d, ms } = await timed(a.dispatch, slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }, 'tok-link'))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 5, data: { flags: 64 } })
    expect(isEphemeral(d)).toBe(true)
    expect(text(a.rest.lastEdit('tok-link'))).toContain('https://rolepay.test/claim/')
  })

  it('a slow /rolepay new still shows its review to everyone: posted in the channel as the bot', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.communities, 'get')
    const { d, ms } = await timed(a.dispatch, slashCommand(SCOPE, 'rolepay', 'new', { amount: '10', users: `<@${ALICE}>` }, { userId: ADMIN, manageGuild: true }, 'tok-new'))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 5, data: { flags: 64 } })
    expect(a.rest.channelPosts).toHaveLength(1)
    expect(text(a.rest.channelPosts[0]?.message)).toMatch(/Pay run awaiting approval/)
    expect(a.rest.deletes.map((r) => r.token)).toEqual(['tok-new'])
  })

  it('a handler that throws after the deadline still ends with an apology, and the error is reported', async () => {
    const a = await withPendingRun()
    a.rolepay.payees.issueLink = async () => {
      await sleep(SLOW_MS)
      throw new Error('database is down')
    }
    const { d } = await timed(a.dispatch, slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }, 'tok-link'))
    expect(body(d).type).toBe(5)
    expect(a.rest.lastEdit('tok-link')?.content).toMatch(/went wrong/)
    expect(a.errors).toHaveLength(1)
  })

  it('a form that is ready too late cannot be shown: the deferred reply asks to try again', async () => {
    const a = await withPendingRun()
    await a.rolepay.communities.setAiProposals({ guildId: GUILD, enabled: true, actorRoleIds: [TREASURER_ROLE] })
    slow(a.rolepay.communities, 'get')
    const target = wireMessage({ channelId: CHANNEL, authorId: TREASURER, at: new Date(), content: `Winners: <@${ALICE}>`, mentions: [ALICE] })
    const { d, ms } = await timed(a.dispatch, messageCommand(SCOPE, 'Propose pay run', target, treasurer, 'tok-form'))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 5, data: { flags: 64 } })
    expect(a.rest.lastEdit('tok-form')?.content).toMatch(/took too long/)
  })

  it('slow autocomplete answers with no choices in time (it cannot be deferred)', async () => {
    const a = await withPendingRun()
    slow(a.rolepay.payRuns, 'list')
    const { d, ms } = await timed(a.dispatch, autocomplete(SCOPE, 'rolepay', 'status', { run: '' }, 'run', { userId: ADMIN, manageGuild: true }))
    expect(ms).toBeLessThan(SLOW_MS / 2)
    expect(body(d)).toEqual({ type: 8, data: { choices: [] } })
  })
})
