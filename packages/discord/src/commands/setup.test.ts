import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, GUILD, TOKEN, TREASURER_ROLE, TREASURY } from '../../test/fixtures.js'
import { slashCommand } from '../testing/interactions.js'

const admin = { userId: ADMIN, manageGuild: true }
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

  it('the first setup needs the treasury address', async () => {
    const a = await appHarness()
    const { d, final } = await setup(a, { approver_role: TREASURER_ROLE })
    expect(body(d)).toEqual({ type: 5, data: { flags: 64 } }) // deferred, only the admin sees it
    expect(final).toMatch(/treasury/)
    expect((await a.payrun.communities.get(GUILD)).ok).toBe(false)
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

  it('a revoked key is replaced by a fresh pending one', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY })
    await a.payrun.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    await a.payrun.communities.revokeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    const revoked = await keyAddress(a)
    const { final } = await setup(a, {})
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
