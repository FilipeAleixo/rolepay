import { describe, expect, it } from 'vitest'
import { type SourceMessage, pseudonymizeMessages, tokenizeInstruction } from './sources.js'

const GUILD = '1094309218049937418'
const CHANNEL = '700000000000000001'
const ANA = '200000000000000001'
const RUI = '200000000000000002'
const LI = '200000000000000003'
const TREASURER = '300000000000000001'
const at = (m: number) => new Date(Date.UTC(2026, 9, 6, 12, m))

const msg = (over: Partial<SourceMessage>): SourceMessage => ({
  id: '810000000000000001',
  channelId: CHANNEL,
  authorId: TREASURER,
  authorIsBot: false,
  content: '',
  mentionIds: [],
  at: at(0),
  replyTo: null,
  ...over,
})

describe('pseudonymizeMessages (no Discord IDs reach the model)', () => {
  const winners = msg({
    id: '810000000000000002',
    content: `Winners: <@${ANA}> (bug in the claim page), <@!${RUI}> (docs), <@${LI}> (big one: the indexer). Thanks <@&400000000000000001> in <#${CHANNEL}> <:party:123456789012345678>`,
    mentionIds: [ANA, RUI, LI],
    at: at(5),
  })
  const later = msg({ id: '810000000000000003', authorId: LI, content: `thanks! my id is ${LI}, and 999999999999999999 is not anyone`, at: at(9), replyTo: { messageId: winners.id, authorId: TREASURER } })

  it('replaces user IDs and mentions with U tokens, in order of appearance, and messages with M tokens, oldest first', () => {
    const p = pseudonymizeMessages({ instruction: `50 each, <@${LI}> 200`, messages: [later, winners] })
    expect(p.messages).toEqual([
      {
        ref: 'M1',
        author: 'U1',
        at: '2026-10-06T12:05:00.000Z',
        text: 'Winners: @U2 (bug in the claim page), @U3 (docs), @U4 (big one: the indexer). Thanks @role in #channel :party:',
        replyTo: null,
      },
      { ref: 'M2', author: 'U4', at: '2026-10-06T12:09:00.000Z', text: 'thanks! my id is U4, and [id] is not anyone', replyTo: 'M1' },
    ])
    expect(p.instruction).toBe('50 each, @U4 200')
    expect(p.map.users).toEqual({ U1: TREASURER, U2: ANA, U3: RUI, U4: LI })
    expect(p.map.messages).toEqual({
      M1: { messageId: winners.id, channelId: CHANNEL, authorId: TREASURER, text: winners.content },
      M2: { messageId: later.id, channelId: CHANNEL, authorId: LI, text: later.content },
    })
    expect(JSON.stringify([p.messages, p.instruction])).not.toMatch(/\d{17,20}/)
  })

  it('tokens people mentioned only in the metadata or only in the instruction too', () => {
    const p = pseudonymizeMessages({ instruction: `also <@${ANA}>`, messages: [msg({ content: 'see above', mentionIds: [RUI] })] })
    expect(p.map.users).toEqual({ U1: TREASURER, U2: RUI, U3: ANA })
    expect(Object.keys(p.messages[0] ?? {})).toEqual(['ref', 'author', 'at', 'text', 'replyTo'])
    expect(p.instruction).toBe('also @U3')
  })

  it('cuts a very long message to the limit', () => {
    const p = pseudonymizeMessages({ instruction: 'x', messages: [msg({ content: 'a'.repeat(5000) })] })
    expect(p.messages[0]?.text.length).toBeLessThanOrEqual(2001)
  })
})

describe('tokenizeInstruction (criteria mode: roles, channels, people and message links become tokens)', () => {
  const roles = [
    { id: '400000000000000001', name: 'Treasurer' },
    { id: '400000000000000002', name: 'Mods' },
  ]
  const channels = [
    { id: '700000000000000001', name: 'help', kind: 'text' as const },
    { id: '700000000000000002', name: 'bounties', kind: 'forum' as const },
  ]

  it('maps mentions and links to tokens and lists every role and channel by token', () => {
    const t = tokenizeInstruction(
      `pay 20 to every <@&400000000000000002> with 10 replies in <#700000000000000001> who reacted to https://discord.com/channels/${GUILD}/700000000000000002/810000000000000009 except <@${ANA}>`,
      { guildId: GUILD, roles, channels },
    )
    expect(t.text).toBe('pay 20 to every @R2 with 10 replies in #C1 who reacted to [message M1] except @U1')
    expect(t.roles).toEqual([
      { ref: 'R1', name: 'Treasurer' },
      { ref: 'R2', name: 'Mods' },
    ])
    expect(t.channels).toEqual([
      { ref: 'C1', name: 'help', kind: 'text' },
      { ref: 'C2', name: 'bounties', kind: 'forum' },
    ])
    expect(t.refs).toEqual({
      users: { U1: ANA },
      roles: { R1: '400000000000000001', R2: '400000000000000002' },
      channels: { C1: '700000000000000001', C2: '700000000000000002' },
      messages: { M1: { channelId: '700000000000000002', messageId: '810000000000000009' } },
    })
  })

  it('gives unknown mentioned roles and channels (a thread, say) their own tokens, and refuses links into other servers', () => {
    const t = tokenizeInstruction('in <#700000000000000099> and https://discord.com/channels/1111111111111111111/700000000000000001/810000000000000001', {
      guildId: GUILD,
      roles: [],
      channels: [],
    })
    expect(t.text).toBe('in #C1 and [a link to another server]')
    expect(t.refs.channels).toEqual({ C1: '700000000000000099' })
    expect(t.channels).toEqual([{ ref: 'C1', name: '(mentioned)', kind: 'other' }])
  })
})
