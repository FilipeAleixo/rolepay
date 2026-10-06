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
        name: 'payrun',
        options: [{ type: 1, name: 'new', options: [{ type: 3, name: 'amount', value: '25' }, { type: 8, name: 'role', value: '400000000000000002' }] }],
      },
    })
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'command',
        command: 'payrun',
        sub: 'new',
        options: { amount: '25', role: '400000000000000002' },
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

  it('reads a button click', () => {
    const r = parseInteraction({ ...base, type: 3, guild_id: '1094309218049937418', member, data: { custom_id: 'payrun:approve:run_1', component_type: 2 } })
    expect(r.ok && r.value.kind === 'component' && r.value.customId).toBe('payrun:approve:run_1')
  })

  it('reads an autocomplete request and which option is focused', () => {
    const r = parseInteraction({
      ...base,
      type: 4,
      guild_id: '1094309218049937418',
      member,
      data: { name: 'payrun', options: [{ type: 1, name: 'status', options: [{ type: 3, name: 'run', value: 'run_', focused: true }] }] },
    })
    expect(r.ok && r.value.kind === 'autocomplete' && r.value.focused).toBe('run')
  })

  it('outside a server (a DM) the caller has no roles and no permissions', () => {
    const r = parseInteraction({ ...base, type: 2, user: { id: '200000000000000001', username: 'a' }, data: { name: 'payee', options: [{ type: 1, name: 'link' }] } })
    expect(r.ok && r.value.kind === 'command' && r.value.ctx).toMatchObject({ guildId: null, caller: { userId: '200000000000000001', roles: [], permissions: 0n } })
  })

  it('refuses shapes it does not understand', () => {
    expect(parseInteraction({ ...base, type: 99 }).ok).toBe(false)
    expect(parseInteraction({ ...base, type: 2, guild_id: 'nope', member, data: { name: 'x' } }).ok).toBe(false)
    expect(parseInteraction('hello').ok).toBe(false)
  })
})
