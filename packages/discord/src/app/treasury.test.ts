import { describe, expect, it } from 'vitest'
import { GUILD } from '../../test/fixtures.js'
import { FakeDiscordRest } from '../testing/fakeDiscordRest.js'
import { confirmTreasuryChannel, readTextChannels } from './treasury.js'

const VIEW = String(1 << 10)
const CATEGORY = '700000000000000100'

describe('readTextChannels (what the treasury channel setting offers)', () => {
  it('lists text channels only, in the order Discord shows them: no categories, voice channels, forums or threads', async () => {
    const rest = new FakeDiscordRest()
    rest.channels.set(GUILD, [
      { id: '700000000000000003', name: 'treasury', type: 0, position: 1, parent_id: CATEGORY },
      { id: CATEGORY, name: 'Staff', type: 4, position: 2 },
      { id: '700000000000000002', name: 'general', type: 0, position: 0 },
      { id: '700000000000000004', name: 'voice', type: 2, position: 1 },
      { id: '700000000000000005', name: 'forum', type: 15, position: 3 },
      { id: '700000000000000006', name: 'thread', type: 11 },
      { id: '700000000000000001', name: 'payouts', type: 0, position: 0, parent_id: CATEGORY },
    ])
    expect((await readTextChannels(rest, GUILD))?.map((c) => c.name)).toEqual(['general', 'payouts', 'treasury'])
  })

  it('says whether @everyone can see each one: the @everyone role (its ID is the server ID) with the channel overwrite for it', async () => {
    const rest = new FakeDiscordRest()
    rest.roles.set(GUILD, [{ id: GUILD, name: '@everyone', permissions: VIEW }])
    rest.channels.set(GUILD, [
      { id: '700000000000000001', name: 'payouts', type: 0, position: 0 },
      { id: '700000000000000002', name: 'treasury', type: 0, position: 1, permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: VIEW }] },
      // An overwrite for another role says nothing about @everyone.
      { id: '700000000000000003', name: 'mods', type: 0, position: 2, permission_overwrites: [{ id: '400000000000000001', type: 0, allow: '0', deny: VIEW }] },
    ])
    expect((await readTextChannels(rest, GUILD, { visibility: true }))?.map((c) => [c.name, c.everyoneCanView])).toEqual([
      ['payouts', true],
      ['treasury', false],
      ['mods', true],
    ])
    // A server where @everyone cannot view channels at all, except where a channel allows it.
    rest.roles.set(GUILD, [{ id: GUILD, name: '@everyone', permissions: '0' }])
    rest.channels.set(GUILD, [
      { id: '700000000000000001', name: 'payouts', type: 0, position: 0, permission_overwrites: [{ id: GUILD, type: 0, allow: VIEW, deny: '0' }] },
      { id: '700000000000000002', name: 'treasury', type: 0, position: 1 },
    ])
    expect((await readTextChannels(rest, GUILD, { visibility: true }))?.map((c) => [c.name, c.everyoneCanView])).toEqual([
      ['payouts', true],
      ['treasury', false],
    ])
  })

  it('is null when Discord does not answer, and skips a channel it sends in a shape it does not know', async () => {
    const down = { getGuildChannels: async () => ({ ok: false as const, error: { code: 'forbidden' as const } }), getGuildRoles: async () => ({ ok: true as const, value: [] }) }
    expect(await readTextChannels(down, GUILD)).toBeNull()
    const odd = new FakeDiscordRest()
    odd.channels.set(GUILD, [{ id: 'nope', name: 'x', type: 0 }, { id: '700000000000000001', name: 'payouts', type: 0 }])
    expect((await readTextChannels(odd, GUILD))?.map((c) => c.id)).toEqual(['700000000000000001'])
  })
})

describe('confirmTreasuryChannel', () => {
  it('posts what Rolepay will post there, pinging nobody; a channel it cannot post in says so', async () => {
    const rest = new FakeDiscordRest()
    expect(await confirmTreasuryChannel(rest, '700000000000000009')).toEqual({ ok: true, value: undefined })
    expect(rest.channelPosts).toEqual([
      { channelId: '700000000000000009', message: { content: 'Rolepay will post here what needs a Treasurer: runs to approve, runs you can veto, and runs it holds.', allowed_mentions: { parse: [] } } },
    ])
    rest.closedChannels.set('700000000000000008', 'forbidden')
    expect(await confirmTreasuryChannel(rest, '700000000000000008')).toEqual({ ok: false, error: { code: 'forbidden' } })
  })
})
