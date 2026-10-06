import { describe, expect, it } from 'vitest'
import { FakeDiscordRest } from '../testing/fakeDiscordRest.js'
import { RestMemberDirectory } from './restMemberDirectory.js'

const GUILD = '1094309218049937418'
const MODS = '400000000000000001'
const [ALICE, BOB, CAROL, DAVE] = ['200000000000000001', '200000000000000002', '200000000000000003', '200000000000000004']

describe('RestMemberDirectory (one member lookup per candidate, no GUILD_MEMBERS intent)', () => {
  it('keeps only the candidates who hold the role, in order', async () => {
    const rest = new FakeDiscordRest()
    rest.setMember(GUILD, ALICE, [MODS])
    rest.setMember(GUILD, BOB, ['400000000000000009'])
    rest.setMember(GUILD, CAROL, ['400000000000000009', MODS])
    const dir = new RestMemberDirectory(rest)
    expect(await dir.withRole({ guildId: GUILD, roleId: MODS, userIds: [ALICE, BOB, CAROL] })).toEqual([ALICE, CAROL])
  })

  it('drops candidates who are no longer members', async () => {
    const rest = new FakeDiscordRest()
    rest.setMember(GUILD, ALICE, [MODS])
    const dir = new RestMemberDirectory(rest)
    expect(await dir.withRole({ guildId: GUILD, roleId: MODS, userIds: [ALICE, DAVE] })).toEqual([ALICE])
  })

  it('treats @everyone (role ID = guild ID) as every current member', async () => {
    const rest = new FakeDiscordRest()
    rest.setMember(GUILD, ALICE, [])
    rest.setMember(GUILD, BOB, [MODS])
    const dir = new RestMemberDirectory(rest)
    expect(await dir.withRole({ guildId: GUILD, roleId: GUILD, userIds: [ALICE, BOB, DAVE] })).toEqual([ALICE, BOB])
  })

  it('looks members up with bounded concurrency', async () => {
    const rest = new FakeDiscordRest()
    const ids = Array.from({ length: 12 }, (_, i) => `2000000000000001${String(i).padStart(2, '0')}`)
    for (const id of ids) rest.setMember(GUILD, id, [MODS])
    let inFlight = 0
    let peak = 0
    const slow = Object.assign(Object.create(rest), {
      getMember: async (g: string, u: string) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 2))
        inFlight--
        return rest.getMember(g, u)
      },
    })
    const dir = new RestMemberDirectory(slow, { concurrency: 4 })
    expect(await dir.withRole({ guildId: GUILD, roleId: MODS, userIds: ids })).toEqual(ids)
    expect(peak).toBeLessThanOrEqual(4)
  })
})
