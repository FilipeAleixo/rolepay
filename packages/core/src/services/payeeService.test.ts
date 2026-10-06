import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryCommunityRepository, MemoryPayeeRepository } from '../adapters/memory/repositories.js'
import { ManualClock, PlainKeyVault, SequentialIds } from '../adapters/memory/support.js'
import { community } from '../../test/support/fixtures.js'
import { PayeeService } from './payeeService.js'

const GUILD = '1094309218049937418'
const ALICE = '200000000000000001'
const ADDR = '0x1111111111111111111111111111111111111111'

describe('PayeeService', () => {
  let clock: ManualClock
  let payees: MemoryPayeeRepository
  let svc: PayeeService

  beforeEach(async () => {
    clock = new ManualClock(new Date('2026-10-06T12:00:00Z'))
    const communities = new MemoryCommunityRepository()
    await communities.insert(community())
    payees = new MemoryPayeeRepository()
    svc = new PayeeService({ communities, payees, vault: new PlainKeyVault(), ids: new SequentialIds(), clock, linkTtlSeconds: 1800 })
  })

  const issue = async () => {
    const r = await svc.issueLink({ guildId: GUILD, discordUserId: ALICE })
    if (!r.ok) throw new Error(r.error.code)
    return r.value
  }

  it('issues a one-time link that expires after the TTL, storing only a fingerprint', async () => {
    const link = await issue()
    expect(link.expiresAt).toEqual(new Date('2026-10-06T12:30:00Z'))
    expect(await payees.getLinkToken(link.token)).toBeNull()
    expect(await payees.getLinkToken(`fp:${link.token}`)).toMatchObject({ communityId: GUILD, discordUserId: ALICE })
  })

  it('refuses links for unknown communities and invalid users', async () => {
    expect(await svc.issueLink({ guildId: '1094309218049937499', discordUserId: ALICE })).toEqual({
      ok: false,
      error: { code: 'community_not_found' },
    })
    expect(await svc.issueLink({ guildId: GUILD, discordUserId: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  it('describes a link for the claim page without consuming it', async () => {
    const link = await issue()
    expect(await svc.describeLink({ token: link.token })).toEqual({
      ok: true,
      value: { guildId: GUILD, communityName: 'Test guild', discordUserId: ALICE, expiresAt: link.expiresAt },
    })
    expect(await svc.describeLink({ token: link.token })).toMatchObject({ ok: true })
  })

  it('registers the passkey account address once, then the link is spent', async () => {
    const link = await issue()
    const r = await svc.register({ token: link.token, address: '0x1111111111111111111111111111111111111111' })
    expect(r).toMatchObject({ ok: true, value: { communityId: GUILD, discordUserId: ALICE, address: ADDR } })
    expect(await svc.get({ guildId: GUILD, discordUserId: ALICE })).toMatchObject({ ok: true, value: { address: ADDR } })
    expect(await svc.register({ token: link.token, address: ADDR })).toEqual({ ok: false, error: { code: 'link_already_used' } })
    expect(await svc.describeLink({ token: link.token })).toEqual({ ok: false, error: { code: 'link_already_used' } })
  })

  it('refuses expired and unknown links', async () => {
    const link = await issue()
    clock.advance(1800)
    expect(await svc.register({ token: link.token, address: ADDR })).toEqual({ ok: false, error: { code: 'link_expired' } })
    expect(await svc.register({ token: 'link_bogus', address: ADDR })).toEqual({ ok: false, error: { code: 'link_not_found' } })
  })

  it('refuses an invalid address without spending the link', async () => {
    const link = await issue()
    expect(await svc.register({ token: link.token, address: '0x0000000000000000000000000000000000000000' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect((await svc.register({ token: link.token, address: ADDR })).ok).toBe(true)
  })

  it('re-registering through a new link updates the address and keeps registeredAt', async () => {
    await svc.register({ token: (await issue()).token, address: ADDR })
    clock.advance(60)
    const r = await svc.register({ token: (await issue()).token, address: '0x2222222222222222222222222222222222222222' })
    expect(r).toMatchObject({
      ok: true,
      value: { address: '0x2222222222222222222222222222222222222222', registeredAt: new Date('2026-10-06T12:00:00Z') },
    })
  })

  it('lists payees per community and says payee_not_found for strangers', async () => {
    await svc.register({ token: (await issue()).token, address: ADDR })
    expect((await svc.list({ guildId: GUILD })).map((p) => p.discordUserId)).toEqual([ALICE])
    expect(await svc.get({ guildId: GUILD, discordUserId: '200000000000000009' })).toEqual({
      ok: false,
      error: { code: 'payee_not_found' },
    })
  })
})
