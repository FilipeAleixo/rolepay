// In-process end to end for funding with attribution: the treasury page registers the treasury as
// a virtual-address master (the browser's part on the fake registry), the approver role creates a
// funding source with a signed /rolepay fund new, someone sends to its deposit address, and the
// deposit watcher attributes it, once, across a restart. Only the Discord REST and the chain are fakes.
import { slashCommand } from '@rolepay/discord/testing'
import { describe, expect, it } from 'vitest'
import { GUILD, TOKEN, testServer, usd } from './support.js'

const SCOPE = { guildId: GUILD, channelId: '700000000000000001' }
const TREASURER_ROLE = '400000000000000001'
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE] }
const PASSKEY = '0x7777777777777777777777777777777777777777'
const SPONSOR = '0x5555555555555555555555555555555555555555'
const SALT = `0x${'00'.repeat(28)}58e21090` as const
const DEPOSIT_ADDRESS = '0x58e21090fdfdfdfdfdfdfdfdfdfd000000000001'

describe('funding with attribution, end to end over HTTP', () => {
  it('treasury page, /rolepay fund new, a deposit, the watcher: attributed once, also after a restart', async () => {
    const s = await testServer({ devShortcuts: false })
    expect((await s.rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress: PASSKEY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE })).ok).toBe(true)
    const link = await s.rolepay.communities.issueSetupLink({ guildId: GUILD, discordUserId: TREASURER.userId, settings: { name: 'Mods guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE } })
    if (!link.ok) throw new Error(link.error.code)
    const base = `/setup/${link.value.token}`

    // Before anything is set up, the watcher reads nothing at all.
    expect(await s.tickFunding()).toEqual({ deposits: [], errors: [] })
    expect(s.fundingChain.calls.head).toBe(0)

    // 1. The treasury page: the server checks the salt this browser mined and answers with its copy of the call.
    const plan = await s.browserPost(`${base}/deposits/plan`, PASSKEY, { salt: SALT })
    expect(plan.status).toBe(200)
    expect(await plan.json()).toMatchObject({ ok: true, masterId: '0x58e21090', master: PASSKEY, call: { to: '0xfdc0000000000000000000000000000000000000' } })
    // 2. The passkey signs the registration (the browser's part), and the server reads it from the chain.
    const registered = s.fundingChain.register(PASSKEY, SALT)
    const confirm = await s.browserPost(`${base}/deposits/confirm`, PASSKEY, registered)
    expect(await confirm.json()).toEqual({ ok: true, masterId: '0x58e21090', txHash: registered.txHash })

    // 3. The approver role creates a funding source in Discord; the address is posted for the channel.
    const created = await s.interact(slashCommand(SCOPE, 'rolepay', 'fund new', { name: 'Judges pool' }, TREASURER))
    const reply = (await created.json()) as { type: number; data: { content: string; flags?: number } }
    expect(reply.data.content).toContain(`\`${DEPOSIT_ADDRESS}\``)
    expect(reply.data.flags ?? 0).toBe(0)

    // 4. Someone sends 2.5 AlphaUSD to it: it lands in the treasury, and the watcher attributes it.
    const sent = s.fundingChain.transfer({ token: TOKEN, from: SPONSOR, to: DEPOSIT_ADDRESS, amount: usd('2.5') })
    expect(s.fundingChain.balanceOf(TOKEN, PASSKEY)).toBe(usd('2.5'))
    const first = await s.tickFunding()
    expect(first.deposits.map((d) => [d.amount, d.txHash, d.from])).toEqual([[usd('2.5'), sent.txHash, SPONSOR]])
    const list = await s.interact(slashCommand(SCOPE, 'rolepay', 'fund list', {}, TREASURER))
    expect(((await list.json()) as { data: { content: string } }).data.content).toContain('**Judges pool**: `0x58e21090fdfdfdfdfdfdfdfdfdfd000000000001`, received 2.5 AlphaUSD in 1 deposit')

    // 5. A restarted process (same database and chain) stores nothing twice.
    const restarted = await testServer({ from: s, devShortcuts: false })
    expect(await restarted.tickFunding()).toEqual({ deposits: [], errors: [] })
    expect(await s.rolepay.funding.deposits({ guildId: GUILD })).toHaveLength(1)
    const audit = await s.rolepay.audit.list({ guildId: GUILD, types: ['funding_source.created', 'deposit.received'] })
    expect(audit.ok && audit.value.events.map((e) => [e.type, e.actor])).toEqual([
      ['deposit.received', null],
      ['funding_source.created', TREASURER.userId],
    ])
  })

  it('the watcher logs what it found, content-free', async () => {
    const s = await testServer({ devShortcuts: false, env: { ROLEPAY_FUNDING_INTERVAL_SECONDS: '1' } })
    await s.rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress: PASSKEY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE })
    const registered = s.fundingChain.register(PASSKEY, SALT)
    await s.rolepay.funding.confirmMaster({ guildId: GUILD, ...registered })
    const source = await s.rolepay.funding.createSource({ guildId: GUILD, actor: TREASURER.userId, actorRoleIds: [TREASURER_ROLE], name: 'Secret sponsor name' })
    if (!source.ok) throw new Error(source.error.code)
    s.fundingChain.transfer({ token: TOKEN, from: SPONSOR, to: source.value.depositAddress, amount: usd('1') })
    const loop = s.startFunding()
    await new Promise((r) => setTimeout(r, 50))
    await loop.stop()
    const line = s.logs.find((l) => l.event === 'funding')
    expect(line?.fields).toMatchObject({ deposits: [{ guildId: GUILD, sourceId: source.value.id, amount: '1', token: TOKEN }], errors: [] })
    expect(JSON.stringify(s.logs)).not.toContain('Secret sponsor name')
  })
})
