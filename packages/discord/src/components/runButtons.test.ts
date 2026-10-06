import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, APP_ID, BOB, CAROL, CHANNEL, GUILD, TREASURER, TREASURER_ROLE } from '../../test/fixtures.js'
import { usd } from '../../test/harness.js'
import { buttonClick } from '../testing/interactions.js'

const treasurer = { userId: TREASURER, roles: [TREASURER_ROLE] }

async function withPendingRun(opts: { approverRoleId?: string | null } = {}) {
  const a = await appHarness()
  await a.setupCommunity(opts)
  await a.registerAll()
  const created = await a.payrun.payRuns.create({
    guildId: GUILD,
    createdBy: ADMIN,
    note: 'October mods',
    lines: [
      { discordUserId: ALICE, amount: usd('1.5') },
      { discordUserId: BOB, amount: usd('25') },
    ],
  })
  if (!created.ok) throw new Error(created.error.code)
  await a.payrun.payRuns.submit({ guildId: GUILD, runId: created.value.id, actor: ADMIN })
  return { ...a, runId: created.value.id }
}

const status = async (a: Awaited<ReturnType<typeof withPendingRun>>) => {
  const r = await a.payrun.payRuns.get({ guildId: GUILD, runId: a.runId })
  return r.ok ? r.value.status : null
}

describe('Approve button', () => {
  it('only a member with the approver role can approve', async () => {
    const a = await withPendingRun()
    const d = await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, { userId: CAROL, roles: [] }))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toContain(`<@&${TREASURER_ROLE}>`)
    expect(await status(a)).toBe('pending_approval')
    expect(a.queue.jobs).toEqual([])
  })

  it('Manage Server alone is not enough to approve', async () => {
    const a = await withPendingRun()
    await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, { userId: ADMIN, manageGuild: true }))
    expect(await status(a)).toBe('pending_approval')
  })

  it('the creator may approve their own run, unless the server requires a separate approver', async () => {
    const creatorTreasurer = { userId: ADMIN, roles: [TREASURER_ROLE] }
    const a = await withPendingRun()
    await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, creatorTreasurer))
    expect(await status(a)).toBe('approved')

    const b = await withPendingRun()
    await b.payrun.communities.setRequireSeparateApprover({ guildId: GUILD, value: true, actorRoleIds: [TREASURER_ROLE] })
    const own = await b.send(buttonClick(SCOPE, `payrun:approve:${b.runId}`, creatorTreasurer))
    expect(isEphemeral(own)).toBe(true)
    expect(body(own).data?.content).toMatch(/created .* cannot approve/)
    expect(await status(b)).toBe('pending_approval')
    expect(b.queue.jobs).toEqual([])
    await b.send(buttonClick(SCOPE, `payrun:approve:${b.runId}`, treasurer))
    expect(await status(b)).toBe('approved')
  })

  it('with no approver role configured, nobody can approve, and the message says how to fix it', async () => {
    const a = await withPendingRun({ approverRoleId: null })
    const d = await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, treasurer))
    expect(body(d).data?.content).toMatch(/approver_role/)
    expect(await status(a)).toBe('pending_approval')
  })

  it('an approver approves: the message turns into "paying" without buttons, and execution is queued', async () => {
    const a = await withPendingRun()
    const d = await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, treasurer, 'tok-approve'))
    expect(body(d).type).toBe(7) // update the message the button is on
    expect(text(body(d))).toMatch(/Paying/)
    expect(text(body(d))).not.toContain('payrun:approve:')
    expect(await status(a)).toBe('approved')
    expect(a.queue.jobs).toEqual([
      {
        kind: 'execute_run',
        guildId: GUILD,
        runId: a.runId,
        reply: { applicationId: APP_ID, token: 'tok-approve' },
        channelId: CHANNEL,
        messageId: '810000000000000001', // the review message, so it can be updated after a restart
      },
    ])
    const r = await a.payrun.payRuns.get({ guildId: GUILD, runId: a.runId })
    expect(r.ok && r.value.approvedBy).toBe(TREASURER)
  })

  it('a second click (or a second treasurer) is told it is already approved, and nothing is queued twice', async () => {
    const a = await withPendingRun()
    await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, treasurer))
    const second = await a.send(buttonClick(SCOPE, `payrun:approve:${a.runId}`, treasurer))
    expect(isEphemeral(second)).toBe(true)
    expect(body(second).data?.content).toMatch(/approved/)
    expect(a.queue.jobs).toHaveLength(1)
  })

  it('a run from another server is not found', async () => {
    const a = await withPendingRun()
    const d = await a.send(buttonClick({ guildId: '1094309218049937499' }, `payrun:approve:${a.runId}`, treasurer))
    expect(body(d).data?.content).toMatch(/set up payrun|no pay run/)
  })
})

describe('Cancel button', () => {
  it('the creator can cancel; the message shows it cancelled', async () => {
    const a = await withPendingRun()
    const d = await a.send(buttonClick(SCOPE, `payrun:cancel:${a.runId}`, { userId: ADMIN }))
    expect(body(d).type).toBe(7)
    expect(text(body(d))).toMatch(/Cancelled/)
    expect(await status(a)).toBe('cancelled')
  })

  it('an approver can cancel; a bystander cannot', async () => {
    const a = await withPendingRun()
    const nope = await a.send(buttonClick(SCOPE, `payrun:cancel:${a.runId}`, { userId: CAROL }))
    expect(isEphemeral(nope)).toBe(true)
    expect(await status(a)).toBe('pending_approval')
    await a.send(buttonClick(SCOPE, `payrun:cancel:${a.runId}`, treasurer))
    expect(await status(a)).toBe('cancelled')
  })
})

describe('Retry button', () => {
  it('an approver retries an approved run that has not been paid: queued and shown as paying', async () => {
    const a = await withPendingRun()
    await a.payrun.payRuns.approve({ guildId: GUILD, runId: a.runId, actor: TREASURER, actorCanApprove: true })
    const d = await a.send(buttonClick(SCOPE, `payrun:retry:${a.runId}`, treasurer, 'tok-retry'))
    expect(body(d).type).toBe(7)
    expect(text(body(d))).toMatch(/Paying/)
    expect(a.queue.jobs.map((j) => j.reply.token)).toEqual(['tok-retry'])
  })

  it('only approvers can retry, and only runs that can be paid again', async () => {
    const a = await withPendingRun()
    await a.payrun.payRuns.approve({ guildId: GUILD, runId: a.runId, actor: TREASURER, actorCanApprove: true })
    const bystander = await a.send(buttonClick(SCOPE, `payrun:retry:${a.runId}`, { userId: CAROL }))
    expect(isEphemeral(bystander)).toBe(true)
    await a.payrun.payRuns.execute({ guildId: GUILD, runId: a.runId }) // now paid
    const paid = await a.send(buttonClick(SCOPE, `payrun:retry:${a.runId}`, treasurer))
    expect(isEphemeral(paid)).toBe(true)
    expect(body(paid).data?.content).toMatch(/paid/)
    expect(a.queue.jobs).toEqual([])
  })
})
