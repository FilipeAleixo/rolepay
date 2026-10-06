import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, GUILD, TOKEN, TREASURER_ROLE, TREASURY } from '../../test/fixtures.js'
import { slashCommand } from '../testing/interactions.js'

const admin = { userId: ADMIN, manageGuild: true }
const treasurerAdmin = { userId: ADMIN, manageGuild: true, roles: [TREASURER_ROLE] }
const PATH_USD = '0x20c0000000000000000000000000000000000000'
const setupUrl = (final: string) => /https:\/\/payrun\.test\/setup\/([A-Za-z0-9_-]+)/.exec(final)?.[1] ?? null
const NEW_ROLE = '400000000000000077'

async function setup(a: Awaited<ReturnType<typeof appHarness>>, values: Record<string, string | boolean | undefined>, who = admin) {
  a.clock.advance(60) // time passes between admin commands (keys are ordered by creation time)
  const token = `tok-setup-${Math.random()}`
  const d = await a.send(slashCommand(SCOPE, 'payrun', 'setup', values, who, token))
  return { d, final: text(a.rest.lastEdit(token)) }
}

const keyAddress = async (a: Awaited<ReturnType<typeof appHarness>>) => {
  const ks = await a.payrun.communities.keyStatus({ guildId: GUILD })
  return ks.ok ? ks.value.key.address : null
}

describe('/payrun setup', () => {
  it('needs Manage Server, and registers nothing otherwise', async () => {
    const a = await appHarness()
    const { d } = await setup(a, { treasury: TREASURY }, { userId: ALICE, manageGuild: false })
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/Manage Server/)
    expect((await a.payrun.communities.get(GUILD)).ok).toBe(false)
  })

  it('refuses a malformed treasury address before doing anything', async () => {
    const a = await appHarness()
    const { d } = await setup(a, { treasury: '0x123' })
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/treasury/)
  })

  it('the first setup needs the approver role, so the treasury link goes to a treasurer', async () => {
    const a = await appHarness()
    const { d, final } = await setup(a, {})
    expect(body(d)).toEqual({ type: 5, data: { flags: 64 } }) // deferred, only the admin sees it
    expect(final).toMatch(/approver_role/)
    expect(setupUrl(final)).toBeNull()
    expect((await a.payrun.communities.get(GUILD)).ok).toBe(false)
  })

  it('the first setup link goes only to someone who holds the approver role too', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { approver_role: TREASURER_ROLE })
    expect(final).toContain(`<@&${TREASURER_ROLE}>`)
    expect(setupUrl(final)).toBeNull()
  })

  it('a first setup by a treasurer with Manage Server issues the treasury page link, carrying the settings and the server name', async () => {
    const a = await appHarness()
    a.rest.guilds.set(GUILD, 'Mods guild')
    const { final } = await setup(a, { approver_role: TREASURER_ROLE }, treasurerAdmin)
    const token = setupUrl(final)
    expect(token).not.toBeNull()
    expect(final).toMatch(/passkey/)
    expect(final).toMatch(/only for you/i)
    expect((await a.payrun.communities.get(GUILD)).ok).toBe(false) // registered when the treasury exists, on the page
    expect(await a.payrun.communities.describeSetupLink({ token: token as string })).toMatchObject({
      ok: true,
      value: { guildId: GUILD, discordUserId: ADMIN, settings: { name: 'Mods guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE } },
    })
  })

  it('a first setup can choose fees from a fee budget (pathUSD by default on testnet)', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { approver_role: TREASURER_ROLE, fees: 'fee_budget' }, treasurerAdmin)
    const link = await a.payrun.communities.describeSetupLink({ token: setupUrl(final) as string })
    expect(link).toMatchObject({ ok: true, value: { settings: { feeMode: 'fee_budget', feeToken: PATH_USD } } })
  })

  it('once registered, a treasurer with Manage Server gets the treasury page link again (to change limits or revoke); others are told who can', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    const mine = await setup(a, {}, treasurerAdmin)
    expect(setupUrl(mine.final)).not.toBeNull()
    const other = await setup(a, {})
    expect(setupUrl(other.final)).toBeNull()
    expect(other.final).toMatch(/treasury page/)
  })

  it('stores the server name from Discord, and keeps it up to date', async () => {
    const a = await appHarness()
    a.rest.guilds.set(GUILD, 'Mods guild')
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    expect(await a.payrun.communities.get(GUILD)).toMatchObject({ ok: true, value: { name: 'Mods guild' } })
    a.rest.guilds.set(GUILD, 'Renamed guild')
    await setup(a, {})
    expect(await a.payrun.communities.get(GUILD)).toMatchObject({ ok: true, value: { name: 'Renamed guild' } })
  })

  it('switches fees between sponsored and a fee budget, and says when the key needs re-authorising', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    await a.payrun.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    const toBudget = await setup(a, { fees: 'fee_budget' })
    expect(await a.payrun.communities.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'fee_budget', feeToken: PATH_USD } })
    expect(toBudget.final).toMatch(/From a fee budget in pathUSD/)
    expect(toBudget.final).toMatch(/fee budget/)
    expect(toBudget.final).toMatch(/new bot key/)
    const back = await setup(a, { fees: 'sponsor' })
    expect(await a.payrun.communities.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'sponsor', feeToken: null } })
    expect(back.final).toMatch(/Sponsored/)
  })

  it('refuses a fee token equal to the payout token', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY })
    const { final } = await setup(a, { fees: 'fee_budget', fee_token: TOKEN })
    expect(final).toMatch(/fee token must differ/)
    expect(await a.payrun.communities.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'sponsor' } })
  })

  it('registers the community, provisions a bot key and says how to authorise it', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    const c = await a.payrun.communities.get(GUILD)
    expect(c).toMatchObject({ ok: true, value: { treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE } })
    expect(final).toMatch(/Waiting for the treasury to authorise/)
    expect(final).toContain('100 AlphaUSD per 30 days')
    expect(final).toContain(`pnpm dev:authorize-key ${GUILD}`)
    expect(final).toContain(`<@&${TREASURER_ROLE}>`)
  })

  it('run again, it updates the approver role and keeps the pending key', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    const before = await keyAddress(a)
    const { final } = await setup(a, { approver_role: NEW_ROLE })
    expect((await a.payrun.communities.get(GUILD)).ok && (await a.payrun.communities.get(GUILD))).toMatchObject({ value: { approverRoleId: NEW_ROLE } })
    expect(await keyAddress(a)).toBe(before)
    expect(final).toContain(`<@&${NEW_ROLE}>`)
  })

  it('once the treasury has authorised the key, shows it active with its remaining limit', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    expect((await a.payrun.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })).ok).toBe(true)
    const { final } = await setup(a, {})
    expect(final).toMatch(/Active/)
    expect(final).toContain('100 AlphaUSD of 100 AlphaUSD left')
    expect(final).toMatch(/Ready/)
  })

  it('new_key issues a fresh key with the given limit', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY })
    const before = await keyAddress(a)
    const { final } = await setup(a, { new_key: true, key_limit: '500' })
    expect(await keyAddress(a)).not.toBe(before)
    expect(final).toContain('500 AlphaUSD per 30 days')
  })

  it('a revoked key: the card says so; new_key (the dev path) provisions a fresh pending one', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY })
    await a.payrun.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    await a.payrun.communities.revokeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    const revoked = await keyAddress(a)
    const plain = await setup(a, {})
    expect(plain.final).toMatch(/Revoked/)
    expect(await keyAddress(a)).toBe(revoked)
    const { final } = await setup(a, { new_key: true })
    expect(await keyAddress(a)).not.toBe(revoked)
    expect(final).toMatch(/Waiting for the treasury to authorise/)
  })

  it('says the treasury cannot be changed once registered', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY })
    const { final } = await setup(a, { treasury: '0x8888888888888888888888888888888888888888' })
    expect(final).toMatch(/cannot be changed/)
    expect((await a.payrun.communities.get(GUILD)).ok && (await a.payrun.communities.get(GUILD))).toMatchObject({ value: { treasuryAddress: TREASURY } })
  })

  it('without an approver role, says nobody can approve yet', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { treasury: TREASURY })
    expect(final).toMatch(/Nobody can approve/)
  })
})
