import type { Payee } from '@rolepay/core'
import { describe, expect, it } from 'vitest'
import { payeesBody } from './payees.js'

const at = new Date('2026-10-08T12:00:00Z')
const payee = (over: Partial<Payee>): Payee => ({
  communityId: '1094309218049937418',
  discordUserId: '200000000000000001',
  address: '0x1111111111111111111111111111111111111111',
  addressKind: 'passkey',
  preferredToken: null,
  registeredAt: at,
  updatedAt: at,
  ...over,
})

describe('the Payees page', () => {
  it('marks who is paid at their own wallet (Rolepay cannot move or recover money there), and nobody else', () => {
    const html = payeesBody({
      guildId: '1094309218049937418',
      token: '0x20c0000000000000000000000000000000000001',
      explorer: 'https://explore.testnet.tempo.xyz',
      payees: [payee({}), payee({ discordUserId: '200000000000000002', address: '0x2222222222222222222222222222222222222222', addressKind: 'external' })],
      totals: new Map(),
      names: new Map([
        ['200000000000000001', 'Alice'],
        ['200000000000000002', 'Bob'],
      ]),
      periods: { this: 'October 2026', last: 'September 2026' },
    })
    const row = (name: string) => html.slice(html.indexOf(`>${name}<`), html.indexOf('</tr>', html.indexOf(`>${name}<`)))
    expect(row('Bob')).toContain('own wallet')
    expect(row('Alice')).not.toContain('own wallet')
  })
})
