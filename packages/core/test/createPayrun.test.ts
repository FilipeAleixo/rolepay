// Wiring test: the public entry point composes working services from ports.
import { describe, expect, it } from 'vitest'
import { FakePayoutChain, ManualClock, PlainKeyVault, SequentialIds, createMemoryRepositories } from '../src/adapters/memory/index.js'
import { createPayrun, parseAmount } from '../src/index.js'

const GUILD = '1094309218049937418'
const TREASURY = '0x9999999999999999999999999999999999999999'
const TOKEN = '0x20c0000000000000000000000000000000000001'
const MODS = ['200000000000000001', '200000000000000002', '200000000000000003']
const usd = (s: string) => {
  const r = parseAmount(s)
  if (!r.ok) throw new Error(s)
  return r.value
}

describe('createPayrun', () => {
  it('composes services that run a whole pay run end to end', async () => {
    const clock = new ManualClock()
    const chain = new FakePayoutChain({ startTime: Math.floor(clock.now().getTime() / 1000) })
    chain.fund(TOKEN, TREASURY, usd('1000'))
    const payrun = createPayrun({
      chain,
      repositories: createMemoryRepositories(),
      vault: new PlainKeyVault(),
      ids: new SequentialIds(),
      clock,
      network: 'moderato',
    })

    expect((await payrun.communities.register({ guildId: GUILD, name: 'Mods', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor' })).ok).toBe(true)
    await payrun.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 2_592_000, expiresAt: chain.time + 86_400 })
    expect((await payrun.communities.authorizeBotKey({ guildId: GUILD, root: chain.rootSigner(TREASURY) })).ok).toBe(true)

    for (const [i, user] of MODS.entries()) {
      const link = await payrun.payees.issueLink({ guildId: GUILD, discordUserId: user })
      if (!link.ok) throw new Error(link.error.code)
      expect((await payrun.payees.register({ token: link.value.token, address: `0x${String(i + 1).repeat(40)}` })).ok).toBe(true)
    }

    const run = await payrun.payRuns.create({
      guildId: GUILD,
      createdBy: MODS[0] as string,
      note: 'October',
      lines: MODS.map((u, i) => ({ discordUserId: u, amount: usd(['1', '2.5', '3.25'][i] as string) })),
    })
    if (!run.ok) throw new Error(run.error.code)
    await payrun.payRuns.submit({ guildId: GUILD, runId: run.value.id, actor: MODS[0] as string })
    await payrun.payRuns.approve({ guildId: GUILD, runId: run.value.id, actor: '300000000000000001', actorCanApprove: true })
    expect(await payrun.payRuns.execute({ guildId: GUILD, runId: run.value.id })).toMatchObject({ ok: true, value: { status: 'paid' } })
    expect(chain.balance(TOKEN, `0x${'2'.repeat(40)}`)).toBe(usd('2.5'))
  })
})
