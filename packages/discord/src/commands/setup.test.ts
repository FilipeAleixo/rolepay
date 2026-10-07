import { describe, expect, it } from 'vitest'
import { SCOPE, appHarness, body, isEphemeral, text } from '../../test/app.js'
import { ADMIN, ALICE, GUILD, TOKEN, TREASURER_ROLE, TREASURY } from '../../test/fixtures.js'
import { slashCommand } from '../testing/interactions.js'

const admin = { userId: ADMIN, manageGuild: true }
const treasurerAdmin = { userId: ADMIN, manageGuild: true, roles: [TREASURER_ROLE] }
const PATH_USD = '0x20c0000000000000000000000000000000000000'
const setupUrl = (final: string) => /https:\/\/payrun\.test\/setup\/([A-Za-z0-9_-]+)/.exec(final)?.[1] ?? null
const NEW_ROLE = '400000000000000077'

async function setup(a: Awaited<ReturnType<typeof appHarness>>, values: Record<string, string | boolean | undefined>, who: { userId: string; manageGuild?: boolean; roles?: string[] } = admin) {
  a.clock.advance(60) // time passes between admin commands (keys are ordered by creation time)
  const token = `tok-setup-${Math.random()}`
  const d = await a.send(slashCommand(SCOPE, 'payrun', 'setup', values, who, token))
  return { d, final: text(a.rest.lastEdit(token)) }
}

const keyAddress = async (a: Awaited<ReturnType<typeof appHarness>>) => {
  const ks = await a.rolepay.communities.keyStatus({ guildId: GUILD })
  return ks.ok ? ks.value.key.address : null
}

describe('/payrun setup', () => {
  it('needs Manage Server, and registers nothing otherwise', async () => {
    const a = await appHarness()
    const { d } = await setup(a, { treasury: TREASURY }, { userId: ALICE, manageGuild: false })
    expect(isEphemeral(d)).toBe(true)
    expect(body(d).data?.content).toMatch(/Manage Server/)
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false)
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
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false)
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
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false) // registered when the treasury exists, on the page
    expect(await a.rolepay.communities.describeSetupLink({ token: token as string })).toMatchObject({
      ok: true,
      value: { guildId: GUILD, discordUserId: ADMIN, settings: { name: 'Mods guild', payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE } },
    })
  })

  it('a first setup can choose fees from a fee budget (pathUSD by default on testnet)', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { approver_role: TREASURER_ROLE, fees: 'fee_budget' }, treasurerAdmin)
    const link = await a.rolepay.communities.describeSetupLink({ token: setupUrl(final) as string })
    expect(link).toMatchObject({ ok: true, value: { settings: { feeMode: 'fee_budget', feeToken: PATH_USD } } })
  })

  it('once registered, a treasurer with Manage Server gets the treasury page link again (to change limits or revoke); others are told who can', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const mine = await setup(a, {}, treasurerAdmin)
    expect(setupUrl(mine.final)).not.toBeNull()
    const other = await setup(a, {})
    expect(setupUrl(other.final)).toBeNull()
    expect(other.final).toMatch(/treasury page/)
  })

  it('stores the server name from Discord, and keeps it up to date', async () => {
    const a = await appHarness()
    a.rest.guilds.set(GUILD, 'Mods guild')
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { name: 'Mods guild' } })
    a.rest.guilds.set(GUILD, 'Renamed guild')
    await setup(a, {})
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { name: 'Renamed guild' } })
  })

  it('switches fees between sponsored and a fee budget, and says when the key needs re-authorising', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    await a.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    const toBudget = await setup(a, { fees: 'fee_budget' }, treasurerAdmin)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'fee_budget', feeToken: PATH_USD } })
    expect(toBudget.final).toMatch(/From a fee budget in pathUSD/)
    expect(toBudget.final).toMatch(/fee budget/)
    expect(toBudget.final).toMatch(/new bot key/)
    const back = await setup(a, { fees: 'sponsor' }, treasurerAdmin)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'sponsor', feeToken: null } })
    expect(back.final).toMatch(/Sponsored/)
  })

  it('refuses a fee token equal to the payout token', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const { final } = await setup(a, { fees: 'fee_budget', fee_token: TOKEN }, treasurerAdmin)
    expect(final).toMatch(/fee token must differ/)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { feeMode: 'sponsor' } })
  })

  it('registers the community, provisions a bot key and says how to authorise it', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const c = await a.rolepay.communities.get(GUILD)
    expect(c).toMatchObject({ ok: true, value: { treasuryAddress: TREASURY, payoutToken: TOKEN, feeMode: 'sponsor', approverRoleId: TREASURER_ROLE } })
    expect(final).toMatch(/Waiting for the treasury to authorise/)
    expect(final).toContain('100 AlphaUSD per 30 days')
    expect(final).toContain(`pnpm dev:authorize-key ${GUILD}`)
    expect(final).toContain(`<@&${TREASURER_ROLE}>`)
  })

  it('run again by a treasurer, it updates the approver role and keeps the pending key', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const before = await keyAddress(a)
    const { final } = await setup(a, { approver_role: NEW_ROLE }, treasurerAdmin)
    expect((await a.rolepay.communities.get(GUILD)).ok && (await a.rolepay.communities.get(GUILD))).toMatchObject({ value: { approverRoleId: NEW_ROLE } })
    expect(await keyAddress(a)).toBe(before)
    expect(final).toContain(`<@&${NEW_ROLE}>`)
  })

  it('Manage Server alone cannot change the approver role, the fee mode or the separate-approver rule (H1)', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    for (const values of [{ approver_role: NEW_ROLE }, { fees: 'fee_budget' }, { separate_approver: true }]) {
      // A moderator with Manage Server, holding the role they want to make the approver.
      const { final } = await setup(a, values, { userId: ADMIN, manageGuild: true, roles: [NEW_ROLE] })
      expect(final).toContain(`Only a member with <@&${TREASURER_ROLE}>`)
    }
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({
      ok: true,
      value: { approverRoleId: TREASURER_ROLE, feeMode: 'sponsor', requireSeparateApprover: false },
    })
  })

  it('a treasurer can require a separate approver; the card says so; a first setup can choose it too', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const on = await setup(a, { separate_approver: true }, treasurerAdmin)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { requireSeparateApprover: true } })
    expect(on.final).toMatch(/created a run cannot approve it/)

    const b = await appHarness()
    const first = await setup(b, { approver_role: TREASURER_ROLE, separate_approver: true }, treasurerAdmin)
    expect(first.final).toMatch(/created a run cannot approve it/)
    const link = await b.rolepay.communities.describeSetupLink({ token: setupUrl(first.final) as string })
    expect(link).toMatchObject({ ok: true, value: { settings: { requireSeparateApprover: true } } })
  })

  it('once the treasury has authorised the key, shows it active with its remaining limit', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    expect((await a.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })).ok).toBe(true)
    const { final } = await setup(a, {})
    expect(final).toMatch(/Active/)
    expect(final).toContain('100 AlphaUSD of 100 AlphaUSD left')
    expect(final).toMatch(/Ready/)
  })

  it('new_key issues a fresh key with the given limit', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const before = await keyAddress(a)
    const { final } = await setup(a, { new_key: true, key_limit: '500' }, treasurerAdmin)
    expect(await keyAddress(a)).not.toBe(before)
    expect(final).toContain('500 AlphaUSD per 30 days')
  })

  it('a revoked key: the card says so; new_key (the dev path) provisions a fresh pending one', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    await a.rolepay.communities.authorizeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    await a.rolepay.communities.revokeBotKey({ guildId: GUILD, root: a.chain.rootSigner(TREASURY) })
    const revoked = await keyAddress(a)
    const plain = await setup(a, {})
    expect(plain.final).toMatch(/Revoked/)
    expect(await keyAddress(a)).toBe(revoked)
    const { final } = await setup(a, { new_key: true }, treasurerAdmin)
    expect(await keyAddress(a)).not.toBe(revoked)
    expect(final).toMatch(/Waiting for the treasury to authorise/)
  })

  it('says the treasury cannot be changed once registered', async () => {
    const a = await appHarness()
    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const { final } = await setup(a, { treasury: '0x8888888888888888888888888888888888888888' }, treasurerAdmin)
    expect(final).toMatch(/cannot be changed/)
    expect((await a.rolepay.communities.get(GUILD)).ok && (await a.rolepay.communities.get(GUILD))).toMatchObject({ value: { treasuryAddress: TREASURY } })
  })

  it('without an approver role, says nobody can approve yet', async () => {
    const a = await appHarness()
    await a.setupCommunity({ approverRoleId: null, activeKey: false })
    const { final } = await setup(a, {})
    expect(final).toMatch(/Nobody can approve/)
  })
})

describe('/payrun setup dev shortcuts (treasury, new_key, key_limit)', () => {
  const NOT_HERE = /dev shortcuts.*off/i

  it('are refused unless PAYRUN_DEV_SHORTCUTS is on, and then change nothing', async () => {
    const a = await appHarness({ config: { devShortcuts: false } })
    for (const values of [{ treasury: TREASURY, approver_role: TREASURER_ROLE }, { new_key: true }, { key_limit: '500' }]) {
      const { d } = await setup(a, values, treasurerAdmin)
      expect(isEphemeral(d)).toBe(true)
      expect(body(d).data?.content).toMatch(NOT_HERE)
    }
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false)
  })

  it('do not exist on any network but the Moderato testnet, even with the flag on', async () => {
    const a = await appHarness({ config: { network: 'mainnet', devShortcuts: true } })
    const { d } = await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    expect(body(d).data?.content).toMatch(NOT_HERE)
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false)
  })

  it('a registered community: new_key is refused when the flag is off, and the pending key stays the same', async () => {
    const a = await appHarness({ config: { devShortcuts: false } })
    await a.setupCommunity({ activeKey: false })
    await a.rolepay.communities.provisionBotKey({ guildId: GUILD, limit: 1n, periodSeconds: null, expiresAt: a.chain.time + 86_400 })
    const before = await keyAddress(a)
    const { d } = await setup(a, { new_key: true, key_limit: '500' }, treasurerAdmin)
    expect(body(d).data?.content).toMatch(NOT_HERE)
    expect(await keyAddress(a)).toBe(before)
  })

  it('need the approver role too: Manage Server alone cannot register a treasury or issue a key', async () => {
    const a = await appHarness()
    const squat = await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE })
    expect(squat.final).toContain(`<@&${TREASURER_ROLE}>`)
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false)
    const noRole = await setup(a, { treasury: TREASURY })
    expect(noRole.final).toMatch(/approver_role/)
    expect((await a.rolepay.communities.get(GUILD)).ok).toBe(false)

    await setup(a, { treasury: TREASURY, approver_role: TREASURER_ROLE }, treasurerAdmin)
    const before = await keyAddress(a)
    const hijack = await setup(a, { new_key: true })
    expect(hijack.final).toContain(`<@&${TREASURER_ROLE}>`)
    expect(await keyAddress(a)).toBe(before)
  })
})

describe('/payrun setup: AI proposals (off by default; a treasurer switches them on)', () => {
  const PROPOSERS = '400000000000000003'

  it('the card says they are off, how to turn them on, and that messages go to Anthropic', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const { final } = await setup(a, {}, treasurerAdmin)
    expect(final).toContain('"name":"AI proposals"')
    expect(final).toContain('Off. A member with the approver role turns them on with `/payrun setup ai_proposals:true`')
    expect(final).toContain("proposing from messages sends their text to Anthropic's API")
  })

  it('a treasurer turns them on and names a proposer role; the card says who can propose', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const { final } = await setup(a, { ai_proposals: true, proposer_role: PROPOSERS }, treasurerAdmin)
    expect(final).toContain(`On. <@&${TREASURER_ROLE}> and <@&${PROPOSERS}> can propose`)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { aiProposals: true, proposerRoleId: PROPOSERS } })
    await setup(a, { ai_proposals: false }, treasurerAdmin)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { aiProposals: false } })
  })

  it('Manage Server alone cannot switch them on or widen who proposes', async () => {
    const a = await appHarness()
    await a.setupCommunity()
    const { final } = await setup(a, { ai_proposals: true, proposer_role: PROPOSERS }, { userId: ADMIN, manageGuild: true, roles: [PROPOSERS] })
    expect(final).toMatch(/Only a member with .* can change AI proposals/)
    expect(await a.rolepay.communities.get(GUILD)).toMatchObject({ ok: true, value: { aiProposals: false, proposerRoleId: null } })
  })

  it('on a payrun server without an Anthropic key the card says they are not available', async () => {
    const a = await appHarness({ proposer: null })
    await a.setupCommunity()
    const { final } = await setup(a, { ai_proposals: true }, treasurerAdmin)
    expect(final).toContain('Not available on this payrun server (no Anthropic API key is configured).')
    expect(final).toContain('cannot run yet')
  })

  it('at first setup they wait for the treasury', async () => {
    const a = await appHarness()
    const { final } = await setup(a, { approver_role: TREASURER_ROLE, ai_proposals: true }, treasurerAdmin)
    expect(final).toMatch(/AI proposals are set after the treasury exists/)
  })
})
