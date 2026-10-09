import { describe, expect, it } from 'vitest'
import { type SourceMessage, detokenize, pseudonymizeMessages, tokenizeInstruction } from './sources.js'

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
      M1: { messageId: winners.id, channelId: CHANNEL, authorId: TREASURER, authorIsBot: false, text: winners.content },
      M2: { messageId: later.id, channelId: CHANNEL, authorId: LI, authorIsBot: false, text: later.content },
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
      emojis: {},
    })
  })

  it('custom emoji reach the model by name and map back in code', () => {
    const t = tokenizeInstruction('5 to everyone who reacted <:pepe:123456789012345678> to it', { guildId: GUILD, roles: [], channels: [] })
    expect(t.text).toBe('5 to everyone who reacted :pepe: to it')
    expect(t.refs.emojis).toEqual({ ':pepe:': '<:pepe:123456789012345678>' })
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

describe('detokenize (the model writes tokens; people read names)', () => {
  const MODS = '400000000000000002'
  const HELP = '700000000000000001'
  const one = { users: { U1: TREASURER, U2: ANA, U3: RUI }, messages: { M1: {} } }
  const two = { users: one.users, messages: { M1: {}, M2: {} } }
  const criteria = { users: { U1: ANA }, roles: { R1: '400000000000000001', R2: MODS }, channels: { C1: HELP }, messages: { M1: {} } }

  it('the live example: messages and the jargon about them become plain words', () => {
    expect(detokenize('Named as a winner in M1 by name only, not by a U token, so it cannot be matched to a person.', one)).toBe(
      'Named as a winner in the message by name only, not by a mention, so it cannot be matched to a person.',
    )
    expect(detokenize('The winners are the two people named in M1, but neither has a U token so no payment lines were drafted.', one)).toBe(
      'The winners are the two people named in the message, but neither has a mention so no payment lines were drafted.',
    )
  })

  it('people become the mentions the view renders (read as names, ping nobody), with or without the @', () => {
    expect(detokenize('@U2 and U3 were named by U1.', one)).toBe(`<@${ANA}> and <@${RUI}> were named by <@${TREASURER}>.`)
    expect(detokenize("U2's docs", one)).toBe(`<@${ANA}>'s docs`)
  })

  it('messages: "the message" when there is one, "message 2 of 2" when there are several, with the words around the token folded in', () => {
    expect(detokenize('M1 names two winners.', one)).toBe('The message names two winners.')
    expect(detokenize('in message M1, the message M1 and [message M1]', one)).toBe('in the message, the message and the message')
    expect(detokenize('M2 replies to the M1 post; see messages M1 and M2.', two)).toBe('Message 2 of 2 replies to message 1 of 2 post; see message 1 of 2 and message 2 of 2.')
  })

  it('criteria mode: roles, channels, people and linked messages', () => {
    expect(detokenize('@R2 who replied in #C1 and reacted to [message M1], except @U1', criteria)).toBe(`<@&${MODS}> who replied in <#${HELP}> and reacted to the message, except <@${ANA}>`)
    expect(detokenize('R2 means Mods, C1 means help', criteria)).toBe(`<@&${MODS}> means Mods, <#${HELP}> means help`)
  })

  it('a token the request never made is a neutral word, never the raw token', () => {
    expect(detokenize('U9, @U12, M7, R9 and #C9', criteria)).toBe('Someone, someone, a message, a role and a channel')
    expect(detokenize('Paid as asked. U9 wrote it.', one)).toBe('Paid as asked. Someone wrote it.')
  })

  it('a kind of token the mode does not use is ordinary text: message mode has no roles or channels', () => {
    expect(detokenize('R2-D2 and C3 in the R1 release', one)).toBe('R2-D2 and C3 in the R1 release')
  })

  it('the jargon phrases, with their articles and plurals', () => {
    expect(detokenize('an M token, the U tokens, a user token, no R token, a C-token, a message token', criteria)).toBe('a message, the mentions, a mention, no role, a channel, a message')
    expect(detokenize('U tokens are missing. An M token is missing.', one)).toBe('Mentions are missing. A message is missing.')
  })

  it('leaves ordinary words alone: other tokens, letters and digits inside words, numbers that are not tokens', () => {
    const plain = [
      'a token of thanks',
      'the payout token is AlphaUSD',
      '20 AlphaUSD tokens each',
      'tokenised names',
      'MU1, AU2, M1A, U1x, U0, M01 and Q3',
      'U1.5 is not a token',
      'mail me@U1',
      'nobody is named',
    ]
    for (const t of plain) expect(detokenize(t, criteria)).toBe(t)
  })

  it("the model's own Discord markup survives only for people, roles and channels of the request", () => {
    expect(detokenize(`<@!${ANA}> and <@${RUI}>`, one)).toBe(`<@${ANA}> and <@${RUI}>`)
    expect(detokenize('<@999999999999999999>, <@&400000000000000099> and <#700000000000000099>', one)).toBe('Someone, a role and a channel')
    expect(detokenize(`<@&${MODS}> in <#${HELP}>`, criteria)).toBe(`<@&${MODS}> in <#${HELP}>`)
  })

  it('is idempotent: its output has nothing left to map', () => {
    const samples = [
      'Named as a winner in M1 by name only, not by a U token.',
      '@U2 and U3 in M2; U9 and M7',
      '<@999999999999999999> and an M token',
      '@R2 in #C1, [message M1], R9',
    ]
    for (const t of samples) for (const names of [one, two, criteria]) expect(detokenize(detokenize(t, names), names)).toBe(detokenize(t, names))
  })

  it('tokens that are object built-ins find nothing', () => {
    expect(detokenize('U1', { users: Object.create({ U1: ANA }) as Record<string, string> })).toBe('Someone')
  })
})
