import { describe, expect, it } from 'vitest'
import { checkSend, maxSendable } from './send.js'

const FROM = '0x7777777777777777777777777777777777777777'
const TO = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
const ok = (over: Partial<Parameters<typeof checkSend>[0]> = {}) => checkSend({ to: TO, amount: '12.5', from: FROM, balance: 20_000_000n, sponsored: false, ...over })

describe('checkSend (what the account page lets a payee send)', () => {
  it('a Tempo address and an amount up to the balance less the fee reserve', () => {
    expect(ok()).toEqual({ ok: true, value: { to: TO.toLowerCase(), amount: 12_500_000n } })
    expect(ok({ amount: '19.9' })).toMatchObject({ ok: true, value: { amount: 19_900_000n } })
    expect(ok({ to: `  ${TO}  `, amount: ' 1 ' })).toMatchObject({ ok: true, value: { amount: 1_000_000n } })
  })

  it('without a sponsor keeps 0.1 for the network fee, paid in the same token', () => {
    expect(ok({ amount: '19.900001' })).toEqual({ ok: false, error: 'that is more than you can send: keep 0.1 for the network fee (at most 19.9)' })
    expect(ok({ amount: '20', sponsored: true })).toMatchObject({ ok: true, value: { amount: 20_000_000n } })
    expect(ok({ amount: '20.000001', sponsored: true })).toEqual({ ok: false, error: 'that is more than the balance (20)' })
  })

  it('refuses anything that is not a plain positive amount with at most 6 decimals', () => {
    for (const amount of ['', '0', '0.0000001', '-1', '1e3', '1,5', 'ten', '0x10']) {
      expect(ok({ amount })).toEqual({ ok: false, error: `"${amount.trim()}" is not an amount: use a number like 10 or 2.5` })
    }
  })

  it('refuses an address that is not one, this account itself, the zero address and token contracts (funds sent there are lost)', () => {
    expect(ok({ to: '0x123' })).toEqual({ ok: false, error: 'that is not a Tempo address (0x and 40 hexadecimal characters)' })
    expect(ok({ to: 'alice.eth' })).toMatchObject({ ok: false })
    expect(ok({ to: FROM.toUpperCase().replace('0X', '0x') })).toEqual({ ok: false, error: 'that is this account' })
    expect(ok({ to: `0x${'0'.repeat(40)}` })).toEqual({ ok: false, error: 'that is the zero address: nothing sent there can ever be moved' })
    expect(ok({ to: '0x20c000000000000000000000b9537d11c60e8b50' })).toEqual({
      ok: false,
      error: 'that is a token contract, not an account: tokens cannot be sent there',
    })
  })
})

describe('maxSendable (the Max button)', () => {
  it('the whole balance when sponsored; otherwise the balance less the 0.1 fee reserve, never below zero', () => {
    expect(maxSendable(20_000_000n, true)).toBe(20_000_000n)
    expect(maxSendable(20_000_000n, false)).toBe(19_900_000n)
    expect(maxSendable(50_000n, false)).toBe(0n)
  })
})
