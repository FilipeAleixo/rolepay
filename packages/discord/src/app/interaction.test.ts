import { describe, expect, it } from 'vitest'
import { parseInteraction } from './interaction.js'

const base = { id: '800000000000000001', application_id: '500000000000000001', token: 'tok' }
const member = { user: { id: '200000000000000001', username: 'alice' }, roles: ['400000000000000001'], permissions: '32' }

describe('parseInteraction', () => {
  it('reads a PING', () => {
    expect(parseInteraction({ ...base, type: 1 })).toEqual({ ok: true, value: { kind: 'ping' } })
  })

  it('flattens a subcommand and its options, and reads the caller from member', () => {
    const r = parseInteraction({
      ...base,
      type: 2,
      guild_id: '1094309218049937418',
      channel_id: '700000000000000001',
      member,
      data: {
        name: 'rolepay',
        options: [{ type: 1, name: 'new', options: [{ type: 3, name: 'amount', value: '25' }, { type: 8, name: 'role', value: '400000000000000002' }] }],
      },
    })
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'command',
        command: 'rolepay',
        sub: 'new',
        options: { amount: '25', role: '400000000000000002' },
        channels: {},
        focused: null,
        ctx: {
          applicationId: '500000000000000001',
          token: 'tok',
          guildId: '1094309218049937418',
          channelId: '700000000000000001',
          caller: { userId: '200000000000000001', roles: ['400000000000000001'], permissions: 32n },
        },
      },
    })
  })

  it('reads a subcommand inside a group (/rolepay policy new) as "policy new", with its options', () => {
    const r = parseInteraction({
      ...base,
      type: 2,
      guild_id: '1094309218049937418',
      member,
      data: { name: 'rolepay', options: [{ type: 2, name: 'policy', options: [{ type: 1, name: 'new', options: [{ type: 3, name: 'instruction', value: '1 per answer' }, { type: 4, name: 'hour', value: 18 }] }] }] },
    })
    expect(r.ok && r.value.kind === 'command' && [r.value.command, r.value.sub, r.value.options]).toEqual(['rolepay', 'policy new', { instruction: '1 per answer', hour: 18 }])
    const auto = parseInteraction({
      ...base,
      type: 4,
      guild_id: '1094309218049937418',
      member,
      data: { name: 'rolepay', options: [{ type: 2, name: 'policy', options: [{ type: 1, name: 'show', options: [{ type: 3, name: 'policy', value: 'hel', focused: true }] }] }] },
    })
    expect(auto.ok && auto.value.kind === 'autocomplete' && [auto.value.sub, auto.value.focused]).toEqual(['policy show', 'policy'])
  })

  it('reads a button click', () => {
    const r = parseInteraction({ ...base, type: 3, guild_id: '1094309218049937418', member, data: { custom_id: 'rolepay:approve:run_1', component_type: 2 } })
    expect(r.ok && r.value.kind === 'component' && r.value.customId).toBe('rolepay:approve:run_1')
  })

  it('reads an autocomplete request and which option is focused', () => {
    const r = parseInteraction({
      ...base,
      type: 4,
      guild_id: '1094309218049937418',
      member,
      data: { name: 'rolepay', options: [{ type: 1, name: 'status', options: [{ type: 3, name: 'run', value: 'run_', focused: true }] }] },
    })
    expect(r.ok && r.value.kind === 'autocomplete' && r.value.focused).toBe('run')
  })

  it('outside a server (a DM) the caller has no roles and no permissions', () => {
    const r = parseInteraction({ ...base, type: 2, user: { id: '200000000000000001', username: 'a' }, data: { name: 'payee', options: [{ type: 1, name: 'link' }] } })
    expect(r.ok && r.value.kind === 'command' && r.value.ctx).toMatchObject({ guildId: null, caller: { userId: '200000000000000001', roles: [], permissions: 0n } })
  })

  it('reads a message command (Apps > Draft pay run with AI) with its target message, text included', () => {
    const target = {
      id: '810000000000000001',
      channel_id: '700000000000000001',
      author: { id: '300000000000000001', username: 'treasurer' },
      content: 'Winners: <@200000000000000001>',
      mentions: [{ id: '200000000000000001', username: 'ana' }],
      timestamp: '2026-10-06T12:00:00.000000+00:00',
      referenced_message: { id: '810000000000000000', author: { id: '200000000000000002', bot: false } },
    }
    const r = parseInteraction({
      ...base,
      type: 2,
      guild_id: '1094309218049937418',
      channel_id: '700000000000000001',
      member,
      data: { id: '900000000000000002', name: 'Draft pay run with AI', type: 3, target_id: target.id, resolved: { messages: { [target.id]: target } } },
    })
    expect(r.ok && r.value.kind === 'message_command' && r.value).toMatchObject({
      command: 'Draft pay run with AI',
      target: {
        id: '810000000000000001',
        channelId: '700000000000000001',
        authorId: '300000000000000001',
        authorIsBot: false,
        content: 'Winners: <@200000000000000001>',
        mentionIds: ['200000000000000001'],
        at: new Date('2026-10-06T12:00:00.000Z'),
        replyTo: { messageId: '810000000000000000', authorId: '200000000000000002' },
      },
    })
  })

  it('reads a user command (Apps > Pay with Rolepay) with its target user and whether it is a bot; a missing target is refused', () => {
    const data = (users: Record<string, unknown>) => ({ id: '900000000000000003', name: 'Pay with Rolepay', type: 2, target_id: '200000000000000001', resolved: { users, members: {} } })
    const at = (d: unknown) => parseInteraction({ ...base, type: 2, guild_id: '1094309218049937418', member, data: d })
    expect(at(data({ '200000000000000001': { id: '200000000000000001', username: 'ana' } }))).toMatchObject({
      ok: true,
      value: { kind: 'user_command', command: 'Pay with Rolepay', target: { userId: '200000000000000001', isBot: false } },
    })
    expect(at(data({ '200000000000000001': { id: '200000000000000001', username: 'rolepay', bot: true } }))).toMatchObject({ ok: true, value: { target: { isBot: true } } })
    expect(at(data({}))).toMatchObject({ ok: false, error: { code: 'unsupported_interaction' } })
    expect(at(data({ '200000000000000001': { id: '200000000000000009' } }))).toMatchObject({ ok: false })
  })

  it('keeps the caller\'s permissions in a channel picked in an option', () => {
    const r = parseInteraction({
      ...base,
      type: 2,
      guild_id: '1094309218049937418',
      member,
      data: { name: 'rolepay', options: [{ type: 1, name: 'propose', options: [{ type: 7, name: 'source', value: '700000000000000001' }] }], resolved: { channels: { '700000000000000001': { id: '700000000000000001', type: 0, permissions: '66560' } } } },
    })
    expect(r.ok && r.value.kind === 'command' && r.value.channels).toEqual({ '700000000000000001': { permissions: 66560n } })
  })

  it('a message command whose target is missing is refused', () => {
    const r = parseInteraction({ ...base, type: 2, guild_id: '1094309218049937418', member, data: { name: 'Draft pay run with AI', type: 3, target_id: '810000000000000001', resolved: { messages: {} } } })
    expect(r).toMatchObject({ ok: false, error: { code: 'unsupported_interaction' } })
  })

  it('reads a submitted modal: text inputs in action rows or in labels, and the message whose button opened it', () => {
    const rows = parseInteraction({
      ...base,
      type: 5,
      guild_id: '1094309218049937418',
      member,
      message: { id: '810000000000000005' },
      data: { custom_id: 'proposal-modal:edit:prop_1', components: [{ type: 1, components: [{ type: 4, custom_id: 'lines', value: '<@200000000000000001>=5' }] }] },
    })
    expect(rows.ok && rows.value).toMatchObject({ kind: 'modal', customId: 'proposal-modal:edit:prop_1', fields: { lines: '<@200000000000000001>=5' }, messageId: '810000000000000005' })
    const labels = parseInteraction({
      ...base,
      type: 5,
      guild_id: '1094309218049937418',
      member,
      data: { custom_id: 'proposal-modal:instruct:810000000000000001', components: [{ type: 18, component: { type: 4, custom_id: 'instruction', value: '50 each' } }] },
    })
    expect(labels.ok && labels.value).toMatchObject({ kind: 'modal', fields: { instruction: '50 each' }, messageId: null })
  })

  it('refuses shapes it does not understand', () => {
    expect(parseInteraction({ ...base, type: 99 }).ok).toBe(false)
    expect(parseInteraction({ ...base, type: 2, guild_id: 'nope', member, data: { name: 'x' } }).ok).toBe(false)
    expect(parseInteraction('hello').ok).toBe(false)
  })
})
