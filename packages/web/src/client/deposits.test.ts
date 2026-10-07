import { toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { buildRegistration, describeRegistration, registrationMismatch } from './deposits.js'

// ox's published example (VirtualMaster docs): this address and salt pass the 32-bit proof of work.
const TREASURY = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const SALT = '0x00000000000000000000000000000000000000000000000000000000abf52baf'
const REGISTRY = '0xfdc0000000000000000000000000000000000000'

describe('the registration the page builds itself', () => {
  it('is registerVirtualMaster(salt) on the address registry, with the masterId the registry will give', () => {
    expect(buildRegistration(TREASURY.toUpperCase().replace('0X', '0x'), SALT)).toEqual({
      masterId: '0x58e21090',
      master: TREASURY,
      call: { to: REGISTRY, data: `${toFunctionSelector('registerVirtualMaster(bytes32)')}${SALT.slice(2)}` },
    })
  })

  it('refuses an account that can never be a master', () => {
    expect(buildRegistration('0x0000000000000000000000000000000000000000', SALT)).toBeNull()
    expect(buildRegistration('0x20c0000000000000000000000000000000000001', SALT)).toBeNull()
  })

  it('says what it signs in plain words', () => {
    const r = buildRegistration(TREASURY, SALT)
    expect(r && describeRegistration(r)).toBe(
      `register this account as the owner of the deposit addresses that start with 0x58e21090 (one call, registerVirtualMaster, to Tempo's address registry ${REGISTRY}). It moves no money.`,
    )
  })
})

describe("registrationMismatch: the server's copy is checked, never signed", () => {
  const mine = buildRegistration(TREASURY, SALT)
  if (!mine) throw new Error('fixture')

  it('accepts the same registration, whatever the case of its hex', () => {
    expect(registrationMismatch(mine, { ...mine, masterId: '0x58E21090', call: { to: REGISTRY.toUpperCase().replace('0X', '0x'), data: mine.call.data.toUpperCase().replace('0X', '0x') } })).toBeNull()
  })

  it('names what differs', () => {
    expect(registrationMismatch(mine, { ...mine, master: '0x7777777777777777777777777777777777777777' })).toBe('another account as the master')
    expect(registrationMismatch(mine, { ...mine, masterId: '0x01020304' })).toBe('a different masterId')
    expect(registrationMismatch(mine, { ...mine, call: { ...mine.call, to: '0xaaaaaaaa00000000000000000000000000000000' } })).toBe('a different contract to call')
    expect(registrationMismatch(mine, { ...mine, call: { ...mine.call, data: `${mine.call.data.slice(0, -2)}00` } })).toBe('a different call')
    expect(registrationMismatch(mine, { masterId: 1 })).toBe('a shape this page cannot read')
    expect(registrationMismatch(mine, null)).toBe('a shape this page cannot read')
  })
})
