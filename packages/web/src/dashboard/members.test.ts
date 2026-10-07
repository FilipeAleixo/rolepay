import { ManualClock } from '@rolepay/core/adapters'
import { describe, expect, it } from 'vitest'
import { FakeGuildMembers } from '../testing/index.js'
import { CachedGuildMembers, ROLES_MAX_AGE_SECONDS } from './members.js'

const GUILD = '1094309218049937418'
const USER = '200000000000000001'

describe('CachedGuildMembers (the bot view of members, cached briefly)', () => {
  it('serves a member from the cache for a minute, then asks Discord again', async () => {
    const clock = new ManualClock()
    const inner = new FakeGuildMembers()
    inner.set(GUILD, USER, ['r1'], 'Felix')
    const members = new CachedGuildMembers(inner, clock)
    expect(await members.member(GUILD, USER)).toEqual({ roles: ['r1'], name: 'Felix' })
    inner.set(GUILD, USER, [], 'Felix')
    expect(await members.member(GUILD, USER)).toEqual({ roles: ['r1'], name: 'Felix' })
    expect(inner.lookups).toBe(1)
    clock.advance(ROLES_MAX_AGE_SECONDS + 1)
    expect(await members.member(GUILD, USER)).toEqual({ roles: [], name: 'Felix' })
    expect(inner.lookups).toBe(2)
  })

  it('a fresh read (before every action) always asks Discord, and refreshes the cache', async () => {
    const clock = new ManualClock()
    const inner = new FakeGuildMembers()
    inner.set(GUILD, USER, ['r1'])
    const members = new CachedGuildMembers(inner, clock)
    await members.member(GUILD, USER)
    inner.remove(GUILD, USER)
    expect(await members.member(GUILD, USER, { fresh: true })).toBeNull()
    expect(await members.member(GUILD, USER)).toBeNull()
    expect(inner.lookups).toBe(2)
  })

  it('names many people at once, from the cache for ten minutes, asking for at most `limit` of them', async () => {
    const clock = new ManualClock()
    const inner = new FakeGuildMembers()
    const ids = ['200000000000000001', '200000000000000002', '200000000000000003']
    inner.set(GUILD, ids[0] as string, [], 'Ana')
    inner.set(GUILD, ids[1] as string, [], null)
    const members = new CachedGuildMembers(inner, clock)
    expect(await members.names(GUILD, [...ids, ids[0] as string], { limit: 10 })).toEqual(new Map([[ids[0], 'Ana']]))
    expect(inner.lookups).toBe(3)
    clock.advance(300)
    await members.names(GUILD, ids, { limit: 10 })
    expect(inner.lookups).toBe(3)
    clock.advance(301)
    expect((await members.names(GUILD, ids, { limit: 1 })).get(ids[0] as string)).toBe('Ana')
    expect(inner.lookups).toBe(4)
  })
})
