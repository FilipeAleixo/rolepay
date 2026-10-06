import { describe, expect, it } from 'vitest'
import { GUILD } from '../../test/fixtures.js'
import { FakeDiscordRest } from '../testing/fakeDiscordRest.js'
import { wireMessage } from '../testing/messages.js'
import { RestActivityReader } from './restActivityReader.js'

const HELP = '700000000000000002'
const ANA = '200000000000000001'
const RUI = '200000000000000002'
const BOT = '200000000000000999'
const NOW = new Date('2026-10-06T12:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

function withHistory(count: number, opts: { from?: number } = {}) {
  const rest = new FakeDiscordRest()
  rest.addChannelMessages(...Array.from({ length: count }, (_, i) => wireMessage({ channelId: HELP, authorId: i % 2 ? ANA : RUI, at: minutesAgo((opts.from ?? 1) + i), content: `m${i}` })))
  return { rest, reader: new RestActivityReader(rest) }
}

describe('RestActivityReader.history (bounded, newest first, 100 per page)', () => {
  it('reads back to `since` and stops there', async () => {
    const { rest, reader } = withHistory(250)
    const r = await reader.history({ channelId: HELP, since: minutesAgo(150), until: NOW, limit: 10_000 })
    if (!r.ok) throw new Error(r.error.code)
    expect(r.value.messages).toHaveLength(150)
    expect(r.value.truncated).toBe(false)
    expect(r.value.messages[0]?.content).toBe('m0')
    expect(rest.reads.filter((x) => x.startsWith('messages'))).toHaveLength(2)
  })

  it('stops at the limit and says the scan was cut short', async () => {
    const { reader } = withHistory(250)
    const r = await reader.history({ channelId: HELP, since: minutesAgo(10_000), until: NOW, limit: 120 })
    expect(r.ok && { n: r.value.messages.length, truncated: r.value.truncated }).toEqual({ n: 120, truncated: true })
  })

  it('reaching the start of the channel is not truncation', async () => {
    const { reader } = withHistory(30)
    const r = await reader.history({ channelId: HELP, since: minutesAgo(10_000), until: NOW, limit: 30 })
    expect(r.ok && { n: r.value.messages.length, truncated: r.value.truncated }).toEqual({ n: 30, truncated: false })
  })

  it('starts at `until`: messages after it are not counted', async () => {
    const { reader } = withHistory(20)
    const r = await reader.history({ channelId: HELP, since: minutesAgo(1000), until: minutesAgo(10.5), limit: 100 })
    expect(r.ok && r.value.messages.map((m) => m.content)).toEqual(['m10', 'm11', 'm12', 'm13', 'm14', 'm15', 'm16', 'm17', 'm18', 'm19'])
  })

  it('keeps author, bot flag, mentions and the reply target (no message text needed for counting)', async () => {
    const rest = new FakeDiscordRest()
    const question = wireMessage({ channelId: HELP, authorId: RUI, at: minutesAgo(5), content: '' })
    rest.addChannelMessages(question, wireMessage({ channelId: HELP, authorId: ANA, at: minutesAgo(4), replyTo: { id: question.id, authorId: RUI } }), wireMessage({ channelId: HELP, authorId: BOT, at: minutesAgo(3), bot: true, mentions: [ANA] }))
    const r = await new RestActivityReader(rest).history({ channelId: HELP, since: minutesAgo(60), until: NOW, limit: 100 })
    expect(r.ok && r.value.messages.map((m) => [m.authorId, m.authorIsBot, m.mentionIds, m.replyTo])).toEqual([
      [BOT, true, [ANA], null],
      [ANA, false, [], { messageId: question.id, authorId: RUI }],
      [RUI, false, [], null],
    ])
  })

  it('a channel the bot cannot read is a clear error', async () => {
    const { rest, reader } = withHistory(5)
    rest.forbiddenChannels.add(HELP)
    expect(await reader.history({ channelId: HELP, since: minutesAgo(60), until: NOW, limit: 10 })).toEqual({ ok: false, error: { code: 'cannot_read', channelId: HELP, reason: 'forbidden' } })
  })
})

describe('RestActivityReader: members, names, messages, reactions', () => {
  it('looks members up one by one, with roles and join date; null for non-members', async () => {
    const rest = new FakeDiscordRest()
    rest.setMember(GUILD, ANA, ['400000000000000002'], new Date('2026-01-01T00:00:00Z'))
    expect(await new RestActivityReader(rest).members(GUILD, [ANA, RUI])).toEqual({ [ANA]: { roleIds: ['400000000000000002'], joinedAt: new Date('2026-01-01T00:00:00Z') }, [RUI]: null })
  })

  it('lists roles (not @everyone, not integration roles) and text channels, forums and active threads', async () => {
    const rest = new FakeDiscordRest()
    rest.roles.set(GUILD, [
      { id: GUILD, name: '@everyone' },
      { id: '400000000000000002', name: 'Mods' },
      { id: '400000000000000009', name: 'payrun', managed: true },
    ])
    rest.channels.set(GUILD, [
      { id: HELP, name: 'help', type: 0 },
      { id: '700000000000000003', name: 'Voice', type: 2 },
      { id: '700000000000000004', name: 'bounties', type: 15 },
      { id: '700000000000000005', name: 'Text channels', type: 4 },
    ])
    rest.threads.set(GUILD, [{ id: '700000000000000006', name: 'bounty #12', type: 11, parent_id: '700000000000000004' }])
    expect(await new RestActivityReader(rest).guildNames(GUILD)).toEqual({
      roles: [{ id: '400000000000000002', name: 'Mods' }],
      channels: [
        { id: HELP, name: 'help', kind: 'text' },
        { id: '700000000000000004', name: 'bounties', kind: 'forum' },
        { id: '700000000000000006', name: 'bounty #12', kind: 'thread' },
      ],
    })
  })

  it('reads one message; a missing one is not_found', async () => {
    const rest = new FakeDiscordRest()
    const m = wireMessage({ channelId: HELP, authorId: ANA, at: minutesAgo(1), content: 'Winners', mentions: [RUI] })
    rest.addChannelMessages(m)
    const reader = new RestActivityReader(rest)
    expect(await reader.message({ channelId: HELP, messageId: m.id })).toMatchObject({ ok: true, value: { mentionIds: [RUI] } })
    expect(await reader.message({ channelId: HELP, messageId: '810000000000000999' })).toEqual({ ok: false, error: { code: 'cannot_read', channelId: HELP, reason: 'not_found' } })
  })

  it('reactions with one emoji, paged past 100, bots left out', async () => {
    const rest = new FakeDiscordRest()
    const users = Array.from({ length: 130 }, (_, i) => ({ id: `2000000000000${String(i).padStart(5, '0')}` }))
    rest.setReactions(HELP, '810000000000000001', '✅', [...users, { id: BOT, bot: true }])
    const r = await new RestActivityReader(rest).reactions({ channelId: HELP, messageId: '810000000000000001', emoji: '✅', limit: 1000 })
    expect(r.ok && { n: r.value.userIds.length, truncated: r.value.truncated, bot: r.value.userIds.includes(BOT) }).toEqual({ n: 130, truncated: false, bot: false })
    expect(rest.reads.filter((x) => x.startsWith('reactions'))).toHaveLength(2)
  })

  it('reactions with any emoji: every emoji on the message, including custom ones', async () => {
    const rest = new FakeDiscordRest()
    const m = wireMessage({ channelId: HELP, authorId: RUI, at: minutesAgo(1) })
    rest.addChannelMessages(m)
    rest.setReactions(HELP, m.id, '✅', [{ id: ANA }])
    rest.setReactions(HELP, m.id, 'party:123456789012345678', [{ id: RUI }, { id: ANA }])
    const r = await new RestActivityReader(rest).reactions({ channelId: HELP, messageId: m.id, emoji: null, limit: 1000 })
    expect(r.ok && [...r.value.userIds].sort()).toEqual([ANA, RUI])
    const custom = await new RestActivityReader(rest).reactions({ channelId: HELP, messageId: m.id, emoji: '<:party:123456789012345678>', limit: 1000 })
    expect(custom.ok && [...custom.value.userIds].sort()).toEqual([ANA, RUI])
  })
})
