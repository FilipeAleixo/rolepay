// In-process end to end, all through POST /discord/interactions with signed requests:
// setup -> claim links -> /rolepay new -> review -> Approve -> deferred -> queue -> core
// -> fake chain -> webhook edit + DMs -> export. Only the Discord REST and the chain are fakes.
import { buttonClick, slashCommand } from '@rolepay/discord/testing'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it, vi } from 'vitest'
import { GUILD, TOKEN, TREASURY, testServer, usd } from './support.js'

const CHANNEL = '700000000000000001'
const SCOPE = { guildId: GUILD, channelId: CHANNEL }
const ADMIN = { userId: '300000000000000002', manageGuild: true }
const TREASURER_ROLE = '400000000000000001'
/** The dev path is for a treasurer: Manage Server and the approver role. */
const TREASURER_ADMIN = { ...ADMIN, roles: [TREASURER_ROLE] }
const TREASURER = { userId: '300000000000000001', roles: [TREASURER_ROLE] }
const ALICE = '200000000000000001'
const BOB = '200000000000000002'
const ADDR = { alice: '0x1111111111111111111111111111111111111111', bob: '0x2222222222222222222222222222222222222222' }
const text = (v: unknown) => JSON.stringify(v ?? null)

describe('pay run end to end through the HTTP endpoint', () => {
  it('setup, register, create, approve, pay once, receipts, export', async () => {
    const s = await testServer()

    // 1. The admin sets up the server (deferred, ephemeral).
    const setup = await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { treasury: TREASURY, approver_role: TREASURER_ROLE }, TREASURER_ADMIN, 'tok-setup'))
    expect(await setup.json()).toEqual({ type: 5, data: { flags: 64 } })
    await s.drain()
    expect(text(s.rest.lastEdit('tok-setup'))).toMatch(/Waiting for the treasury to authorise/)
    expect(text(s.rest.lastEdit('tok-setup'))).toContain(`pnpm dev:authorize-key ${GUILD}`)

    // 2. The treasury authorises the bot key (what `pnpm dev:authorize-key` does on testnet).
    expect((await s.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: s.chain.rootSigner(TREASURY) })).ok).toBe(true)

    // 3. Two people get their one-time links and register on the claim page.
    for (const [user, address] of [
      [ALICE, ADDR.alice],
      [BOB, ADDR.bob],
    ] as const) {
      const res = await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: user }))
      const reply = (await res.json()) as { data: { content: string; flags: number } }
      expect(reply.data.flags).toBe(64)
      const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(reply.data.content)?.[1]
      expect(url).toBeDefined()
      // The claim page: the person's passkey session supplies the address (fake sessions here).
      const claimed = await s.browserPost(url as string, address)
      expect(claimed.status).toBe(200)
    }

    // 4. The admin creates the run: deferred publicly, then the review embed appears.
    const created = await s.interact(slashCommand(SCOPE, 'rolepay', 'new', { amount: '10', users: `<@${ALICE}> <@${BOB}>=40`, note: 'October mods' }, ADMIN, 'tok-new'))
    expect(await created.json()).toEqual({ type: 5, data: {} })
    await s.drain()
    const review = text(s.rest.lastEdit('tok-new'))
    const runId = /rolepay:approve:([^"]+)"/.exec(review)?.[1] as string
    expect(runId).toBeDefined()
    expect(review).toContain('50 AlphaUSD')

    // 5. A bystander cannot approve.
    const refused = await s.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, { userId: '200000000000000009' }))
    expect(((await refused.json()) as { data: { flags: number } }).data.flags).toBe(64)

    // 6. The treasurer approves: the message turns into "paying" at once, the job pays.
    const approved = await s.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, TREASURER, 'tok-approve'))
    const update = (await approved.json()) as { type: number }
    expect(update.type).toBe(7)
    expect(text(update)).toMatch(/Paying/)
    await s.drain()

    const final = text(s.rest.lastEdit('tok-approve'))
    expect(final).toMatch(/"title":"Paid"/)
    expect(final).toMatch(/https:\/\/explore\.testnet\.tempo\.xyz\/tx\/0x[0-9a-f]{64}/)
    expect(final).toMatch(/to all 2 people/)
    expect(s.rest.dms.map((d) => d.userId)).toEqual([ALICE, BOB])
    expect(text(s.rest.dms[1]?.message)).toContain('40 AlphaUSD')
    // Each receipt says where the payee sees and moves the money: this server's account page.
    expect(text(s.rest.dms[1]?.message)).toContain('https://rolepay.test/account')
    expect(s.chain.balance(TOKEN, ADDR.alice)).toBe(usd('10'))
    expect(s.chain.balance(TOKEN, ADDR.bob)).toBe(usd('40'))
    expect(s.chain.landedTxCount).toBe(1)

    // 7. A late second click changes nothing.
    const late = await s.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, TREASURER))
    expect(((await late.json()) as { data: { flags: number } }).data.flags).toBe(64)
    await s.drain()
    expect(s.chain.landedTxCount).toBe(1)

    // 8. Export: a CSV attachment (multipart) with the paid transaction.
    const exported = await s.interact(slashCommand(SCOPE, 'rolepay', 'export', { run: runId }, ADMIN))
    expect(exported.headers.get('content-type')).toMatch(/multipart\/form-data/)
    const form = await exported.formData()
    const csv = await (form.get('files[0]') as File).text()
    expect(csv).toContain(`${runId},1,${ALICE},${ADDR.alice},10.000000`)
    expect(csv).toContain(`${runId},2,${BOB},${ADDR.bob},40.000000`)
    expect(csv).toMatch(/,paid,0x[0-9a-f]{64},/)
  })

  it("a payee who registers a wallet they already have (signed on the claim page) is paid there by a normal run, and the receipt links the explorer", async () => {
    const s = await testServer()
    await s.rolepay.communities.register({ guildId: GUILD, name: 'Mods guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE })
    await s.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 86_400, expiresAt: s.chain.time + 86_400 })
    await s.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: s.chain.rootSigner(TREASURY) })
    const wallet = privateKeyToAccount(generatePrivateKey())
    const reply = (await (await s.interact(slashCommand(SCOPE, 'payee', 'link', {}, { userId: ALICE }))).json()) as { data: { content: string } }
    const url = /https:\/\/rolepay\.test(\/claim\/\S+)/.exec(reply.data.content)?.[1] as string
    const post = (path: string, body: unknown) =>
      s.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://rolepay.test' }, body: JSON.stringify(body) })
    const { message } = (await (await post(`${url}/wallet/challenge`, { address: wallet.address })).json()) as { message: string }
    expect(message.split('\n')[0]).toBe(`Rolepay on rolepay.test: pay me in Mods guild at ${wallet.address.toLowerCase()} on Tempo (chain 42431).`)
    const claimed = await post(`${url}/wallet`, { message, signature: await wallet.signMessage({ message }) })
    expect(await claimed.json()).toMatchObject({ ok: true, address: wallet.address.toLowerCase(), addressKind: 'external' })

    const created = await s.interact(slashCommand(SCOPE, 'rolepay', 'new', { amount: '7', users: `<@${ALICE}>`, note: 'Bounty' }, ADMIN, 'tok-new'))
    expect(created.status).toBe(200)
    await s.drain()
    const runId = /rolepay:approve:([^"]+)"/.exec(text(s.rest.lastEdit('tok-new')))?.[1] as string
    await s.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, TREASURER, 'tok-approve'))
    await s.drain()
    expect(text(s.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(s.chain.balance(TOKEN, wallet.address.toLowerCase())).toBe(usd('7'))
    const receipt = text(s.rest.dms[0]?.message)
    expect(receipt).toContain(`https://explore.testnet.tempo.xyz/address/${wallet.address.toLowerCase()}`)
    expect(receipt).not.toContain('https://rolepay.test/account')
  })

  it('a crash after approval loses nothing: recovery reconciles, Retry finishes it, still one payment', async () => {
    const s = await testServer()
    await s.rolepay.communities.register({ guildId: GUILD, name: null, treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE })
    await s.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 86_400, expiresAt: s.chain.time + 86_400 })
    await s.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: s.chain.rootSigner(TREASURY) })
    const link = await s.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: ALICE })
    if (!link.ok) throw new Error(link.error.code)
    await s.rolepay.payees.register({ token: link.value.token, address: ADDR.alice })
    const run = await s.rolepay.payRuns.create({ guildId: GUILD, createdBy: ADMIN.userId, lines: [{ discordUserId: ALICE, amount: usd('5') }] })
    if (!run.ok) throw new Error(run.error.code)
    await s.rolepay.payRuns.submit({ guildId: GUILD, runId: run.value.id, actor: ADMIN.userId })
    await s.rolepay.payRuns.approve({ guildId: GUILD, runId: run.value.id, actor: TREASURER.userId, actorCanApprove: true })
    // The process "died" before the queued job ran: the run is approved, nothing executing.

    const status = await s.interact(slashCommand(SCOPE, 'rolepay', 'status', { run: run.value.id }, ADMIN))
    expect(text(await status.json())).toContain(`rolepay:retry:${run.value.id}`)

    await s.interact(buttonClick(SCOPE, `rolepay:retry:${run.value.id}`, TREASURER, 'tok-retry'))
    await s.drain()
    expect(text(s.rest.lastEdit('tok-retry'))).toMatch(/"title":"Paid"/)
    expect(s.chain.landedTxCount).toBe(1)
  })

  it('a run left executing when the process died is finished by the next process: message updated, receipts once', async () => {
    const before = await testServer({ sleep: async () => Promise.reject(new Error('the process died')) })
    await before.rolepay.communities.register({ guildId: GUILD, name: 'Test guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE })
    await before.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 86_400, expiresAt: before.chain.time + 86_400 })
    await before.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: before.chain.rootSigner(TREASURY) })
    const link = await before.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: ALICE })
    if (!link.ok) throw new Error(link.error.code)
    await before.rolepay.payees.register({ token: link.value.token, address: ADDR.alice })
    await before.interact(slashCommand(SCOPE, 'rolepay', 'new', { amount: '5', users: `<@${ALICE}>` }, ADMIN, 'tok-new'))
    await before.drain()
    const runId = /rolepay:approve:([^"]+)"/.exec(text(before.rest.lastEdit('tok-new')))?.[1] as string

    // The transaction lands but the answer is lost, and the process dies while waiting.
    before.chain.faults.nextBroadcast = 'land_then_lose_response'
    await before.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, TREASURER, 'tok-approve'))
    await before.drain()
    expect((await before.rolepay.payRuns.get({ guildId: GUILD, runId })).ok && (await before.rolepay.payRuns.get({ guildId: GUILD, runId }))).toMatchObject({ value: { status: 'executing' } })
    expect(before.rest.dms).toEqual([])

    // The next process: same database, a fresh Discord connection, the recovery sweep on start.
    const after = await testServer({ from: before })
    const recovery = after.startRecovery()
    await vi.waitFor(() => expect(after.rest.channelEdits).toHaveLength(1))
    await recovery.stop()
    expect(after.rest.channelEdits[0]).toMatchObject({ channelId: CHANNEL, messageId: '810000000000000001' })
    expect(text(after.rest.channelEdits[0]?.message)).toMatch(/"title":"Paid"/)
    expect(after.rest.dms.map((d) => d.userId)).toEqual([ALICE])
    expect(text(after.rest.dms[0]?.message)).toContain('https://rolepay.test/account')
    expect(after.chain.landedTxCount).toBe(1)

    // Another sweep (or process) tells nobody again.
    const again = after.startRecovery()
    await new Promise((r) => setTimeout(r, 20))
    await again.stop()
    expect(after.rest.dms).toHaveLength(1)
  })

  it('a recovery sweep while the job waits between checks leaves the run to the job: one report, receipts once, one broadcast', async () => {
    // The sweep runs inside the job's wait, as the 30-second interval would hit it on the demo.
    let duringWait: (() => Promise<void>) | null = null
    let s!: Awaited<ReturnType<typeof testServer>>
    s = await testServer({
      sleep: async (ms) => {
        s.clock.advance(ms / 1000)
        s.chain.advance(Math.ceil(ms / 1000))
        const sweep = duringWait
        duringWait = null
        await sweep?.()
      },
    })
    await s.rolepay.communities.register({ guildId: GUILD, name: 'Test guild', treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE })
    await s.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: usd('100'), periodSeconds: 86_400, expiresAt: s.chain.time + 86_400 })
    await s.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: s.chain.rootSigner(TREASURY) })
    const link = await s.rolepay.payees.issueLink({ guildId: GUILD, discordUserId: ALICE })
    if (!link.ok) throw new Error(link.error.code)
    await s.rolepay.payees.register({ token: link.value.token, address: ADDR.alice })
    await s.interact(slashCommand(SCOPE, 'rolepay', 'new', { amount: '5', users: `<@${ALICE}>` }, ADMIN, 'tok-new'))
    await s.drain()
    const runId = /rolepay:approve:([^"]+)"/.exec(text(s.rest.lastEdit('tok-new')))?.[1] as string

    // The payment lands but its answer is lost: the job waits, then checks again. The sweep fires in that wait.
    s.chain.faults.nextBroadcast = 'land_then_lose_response'
    duringWait = async () => {
      const sweep = s.startRecovery()
      await new Promise((r) => setTimeout(r, 20))
      await sweep.stop()
    }
    await s.interact(buttonClick(SCOPE, `rolepay:approve:${runId}`, TREASURER, 'tok-approve'))
    await s.drain()

    expect(duringWait).toBeNull() // the sweep did run inside the wait
    expect(text(s.rest.lastEdit('tok-approve'))).toMatch(/"title":"Paid"/)
    expect(s.logs.filter((l) => l.event === 'recovery')).toEqual([]) // nothing raced, nothing reported twice
    expect(s.rest.channelEdits).toEqual([])
    expect(s.rest.dms.map((d) => d.userId)).toEqual([ALICE])
    expect(s.chain.broadcastCount).toBe(1)
    expect(s.chain.landedTxCount).toBe(1)

    // The timing lines: the job (how it ended and where the time went) and the deferred review (its phases).
    expect(s.logs.find((l) => l.event === 'job')?.fields).toMatchObject({ runId, status: 'paid', checks: 1, contended: 0 })
    const review = s.logs.find((l) => l.event === 'deferred' && l.fields?.name === 'rolepay new')?.fields
    expect(review).toMatchObject({ kind: 'command', ok: true })
    // `discord`: with no treasury channel set, Rolepay looks for a channel named "treasury" before posting the review.
    expect(Object.keys((review?.phases ?? {}) as Record<string, number>).sort()).toEqual(['db', 'discord', 'reply', 'work'])
  })

  it('with the production default (no ROLEPAY_DEV_SHORTCUTS), Discord cannot register a treasury or issue a key', async () => {
    const s = await testServer({ devShortcuts: false })
    const res = await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { treasury: TREASURY, approver_role: TREASURER_ROLE }, TREASURER_ADMIN, 'tok-setup'))
    expect(text(await res.json())).toMatch(/dev shortcuts.*off/)
    await s.drain()
    expect((await s.rolepay.communities.get(GUILD)).ok).toBe(false)
  })

  it('the production setup: a treasurer gets the treasury page link, the passkey binds the treasury and authorises the key', async () => {
    const s = await testServer({ devShortcuts: false })
    s.rest.guilds.set(GUILD, 'Mods guild')
    const treasurerAdmin = { ...TREASURER, manageGuild: true }
    await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', { approver_role: TREASURER_ROLE }, treasurerAdmin, 'tok-setup'))
    await s.drain()
    const path = /https:\/\/rolepay\.test(\/setup\/[A-Za-z0-9_-]+)/.exec(text(s.rest.lastEdit('tok-setup')))?.[1] as string
    expect(path).toBeDefined()
    expect((await s.app.request(path)).status).toBe(200)

    // On the page (the passkey session is faked here; the browser e2e uses a real one).
    const passkey = '0x7777777777777777777777777777777777777777'
    expect((await s.browserPost(`${path}/treasury`, passkey)).status).toBe(200)
    const provisioned = (await (await s.browserPost(`${path}/key`, passkey, { limit: '20', periodDays: 30, expiresAt: Math.floor(s.clock.now().getTime() / 1000) + 30 * 86_400 })).json()) as {
      keyAddress: `0x${string}`
      authorization: { expiry: number; limits: { token: string; limit: string; period?: number }[]; scopes: never }
    }
    const authorization = { ...provisioned.authorization, limits: provisioned.authorization.limits.map((l) => ({ ...l, limit: BigInt(l.limit) })) }
    expect((await s.chain.authorizeKey({ root: s.chain.rootSigner(passkey), accessKey: provisioned.keyAddress, authorization: authorization as never })).ok).toBe(true)
    expect((await s.browserPost(`${path}/key/confirm`, passkey, { keyAddress: provisioned.keyAddress })).status).toBe(200)

    await s.interact(slashCommand(SCOPE, 'rolepay', 'setup', {}, treasurerAdmin, 'tok-setup-2'))
    await s.drain()
    const card = text(s.rest.lastEdit('tok-setup-2'))
    expect(card).toContain('Rolepay setup: Mods guild')
    expect(card).toContain('20 AlphaUSD of 20 AlphaUSD left')
    expect(card).toMatch(/Ready/)
  })
})
