import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, BOB, CAROL, GUILD } from '../../test/fixtures.js'
import { usd } from '../../test/harness.js'
import { autocomplete, slashCommand } from '../testing/interactions.js'

const admin = { userId: ADMIN, manageGuild: true }
const bystander = { userId: CAROL }

async function withRuns() {
  const a = await appHarness()
  await a.setupCommunity()
  await a.registerAll()
  const mk = async (note: string) => {
    a.clock.advance(60)
    const r = await a.payrun.payRuns.create({
      guildId: GUILD,
      createdBy: ADMIN,
      note,
      lines: [
        { discordUserId: ALICE, amount: usd('1.5') },
        { discordUserId: BOB, amount: usd('25') },
      ],
    })
    if (!r.ok) throw new Error(r.error.code)
    await a.payrun.payRuns.submit({ guildId: GUILD, runId: r.value.id, actor: ADMIN })
    return r.value.id
  }
  const first = await mk('September')
  const second = await mk('October')
  return { ...a, first, second }
}

describe('/payrun status', () => {
  it('is for admins and approvers only', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'status', {}, bystander))
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/Manage Server or the approver role/)
  })

  it('shows one run in detail, privately, with the buttons its status allows', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'status', { run: a.first }, admin))
    expect(isEphemeral(d)).toBe(true)
    expect(text(body(d))).toContain('September')
    expect(text(body(d))).toContain(`payrun:approve:${a.first}`)
  })

  it('an approved run that is not paid gets a Retry (a restart may have lost its job)', async () => {
    const a = await withRuns()
    await a.payrun.payRuns.approve({ guildId: GUILD, runId: a.first, actor: '300000000000000001', actorCanApprove: true })
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'status', { run: a.first }, admin))
    expect(text(body(d))).toContain(`payrun:retry:${a.first}`)
  })

  it('an unknown run is not found', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'status', { run: 'run_nope' }, admin))
    expect(body(d).data?.content).toMatch(/no pay run/i)
  })

  it('the overview lists recent runs and the bot key as the chain sees it', async () => {
    const a = await withRuns()
    const token = 'tok-status'
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'status', {}, admin, token))
    expect(body(d)).toEqual({ type: 5, data: { flags: 64 } })
    const final = text(a.rest.lastEdit(token))
    expect(final).toContain(a.first)
    expect(final).toContain(a.second)
    expect(final).toMatch(/Awaiting approval/)
    expect(final).toMatch(/Active/)
  })
})

describe('/payrun export', () => {
  it('sends the run as a CSV attachment, only to the caller', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'export', { run: a.first }, admin))
    expect(isEphemeral(d)).toBe(true)
    if (d.kind !== 'respond') throw new Error('no response')
    expect(d.files?.[0]?.name).toBe(`payrun-${a.first}.csv`)
    expect(d.files?.[0]?.contentType).toMatch(/text\/csv/)
    const csv = d.files?.[0]?.data ?? ''
    expect(csv.split('\n')[0]).toMatch(/^run_id,line,discord_user_id,address,amount/)
    expect(csv).toContain(`${a.first},1,${ALICE}`)
    expect(csv).toContain('September')
  })

  it('without a run option, exports the latest run', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'export', {}, admin))
    expect(d.kind === 'respond' && d.files?.[0]?.name).toBe(`payrun-${a.second}.csv`)
  })

  it('with no runs yet, says so', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'export', {}, admin))
    expect(body(d).data?.content).toMatch(/No pay runs yet/)
  })

  it('is for admins and approvers only', async () => {
    const a = await withRuns()
    const d = await a.send(slashCommand(SCOPE, 'payrun', 'export', { run: a.first }, bystander))
    expect(d.kind === 'respond' && d.files).toBeUndefined()
  })
})

describe('run autocomplete (status and export)', () => {
  it('suggests recent runs matching what was typed, newest first', async () => {
    const a = await withRuns()
    const d = await a.send(autocomplete(SCOPE, 'payrun', 'export', { run: '' }, 'run', admin))
    const choices = (body(d).data?.choices ?? []) as { name: string; value: string }[]
    expect(body(d).type).toBe(8)
    expect(choices.map((c) => c.value)).toEqual([a.second, a.first])
    expect(choices[0]?.name).toMatch(/October/)
    for (const c of choices) expect(c.name.length).toBeLessThanOrEqual(100)
    const filtered = await a.send(autocomplete(SCOPE, 'payrun', 'status', { run: a.first.slice(-2) }, 'run', admin))
    expect(((body(filtered).data?.choices ?? []) as { value: string }[]).map((c) => c.value)).toEqual([a.first])
  })

  it('suggests nothing to people who cannot see runs', async () => {
    const a = await withRuns()
    const d = await a.send(autocomplete(SCOPE, 'payrun', 'export', { run: '' }, 'run', bystander))
    expect(body(d).data?.choices).toEqual([])
  })
})
